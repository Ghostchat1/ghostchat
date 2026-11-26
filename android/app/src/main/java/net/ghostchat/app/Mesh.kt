package net.ghostchat.app

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Offline Bluetooth mesh ("store and forward").
 *
 * Messages handed to the mesh are ALREADY sealed by the app (post-quantum, sealed sender,
 * ratchet). Each phone keeps a small pool of sealed envelopes and swaps it with every nearby
 * Raazdar phone it meets. An envelope addressed to you is handed to the app; anything else
 * is carried along for others, so messages can hop across several phones.
 * Carriers learn only the recipient's anonymous ID — never the sender or the content.
 *
 * Transport: Bluetooth Classic RFCOMM. Works automatically with paired phones; unpaired phones
 * are found while they are "visible" (Android allows up to 5 minutes at a time).
 */
@SuppressLint("MissingPermission")
class Mesh(private val ctx: Context, private val deliver: (String, String, String) -> Unit) {
    private data class Item(val to: String, val mid: String, val env: String, val exp: Long)

    private val uuid: UUID = UUID.fromString("6b1e5d6a-4c2f-4f7e-9a8b-2c1d0e9f7a31")
    private val idRe = Regex("^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$")
    private val ttl = 3L * 24 * 3600 * 1000
    private val pool = ConcurrentHashMap<String, Item>()
    private val seen: MutableSet<String> = Collections.newSetFromMap(ConcurrentHashMap())
    private val peers: MutableSet<String> = Collections.newSetFromMap(ConcurrentHashMap())
    private val busy: MutableSet<String> = Collections.newSetFromMap(ConcurrentHashMap())
    private val exec = Executors.newCachedThreadPool()
    private val sched = Executors.newSingleThreadScheduledExecutor()
    private var task: ScheduledFuture<*>? = null
    private var server: BluetoothServerSocket? = null
    private var receiverOn = false
    @Volatile private var myId: String? = null
    @Volatile private var running = false

    private val adapter: BluetoothAdapter?
        get() = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private val found = object : BroadcastReceiver() {
        @Suppress("DEPRECATION")
        override fun onReceive(c: Context, i: Intent) {
            if (i.action != BluetoothDevice.ACTION_FOUND) return
            val d: BluetoothDevice? = if (Build.VERSION.SDK_INT >= 33)
                i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
            else i.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)
            if (d != null) exec.execute { exchangeWith(d) }
        }
    }

    @Synchronized
    fun start(id: String) {
        myId = id
        // hand over anything that arrived for us while the app was locked
        for (item in pool.values) if (item.to == id) { pool.remove(item.mid); deliver(item.to, item.mid, item.env) }
        if (running) return
        val ad = adapter ?: return
        try { if (!ad.isEnabled) return } catch (e: SecurityException) { return }
        running = true
        exec.execute { listen() }
        if (!receiverOn) {
            try {
                if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(found, IntentFilter(BluetoothDevice.ACTION_FOUND), Context.RECEIVER_EXPORTED)
                else ctx.registerReceiver(found, IntentFilter(BluetoothDevice.ACTION_FOUND))
                receiverOn = true
            } catch (e: Exception) { }
        }
        task = sched.scheduleWithFixedDelay({ cycle() }, 2, 45, TimeUnit.SECONDS)
    }

    @Synchronized
    fun stop() {
        myId = null
        running = false
        task?.cancel(true); task = null
        try { server?.close() } catch (e: Exception) { }
        try { adapter?.cancelDiscovery() } catch (e: Exception) { }
        if (receiverOn) { try { ctx.unregisterReceiver(found) } catch (e: Exception) { }; receiverOn = false }
    }

    fun clear() { pool.clear(); seen.clear(); peers.clear() }

    fun send(to: String, mid: String, env: String) {
        if (!idRe.matches(to) || mid.length > 40) return
        seen.add(mid)
        pool[mid] = Item(to, mid, env, System.currentTimeMillis() + ttl)
    }

    fun status(): String {
        val bt = try { adapter?.isEnabled == true } catch (e: SecurityException) { false }
        return JSONObject().put("bt", bt).put("peers", peers.size).put("pool", pool.size).put("running", running).toString()
    }

    // every 45 s: swap with paired phones, then scan for visible ones
    private fun cycle() {
        if (!running) return
        val now = System.currentTimeMillis()
        pool.values.filter { it.exp < now }.forEach { pool.remove(it.mid) }
        if (seen.size > 20000) seen.clear()
        val ad = adapter ?: return
        try {
            for (d in ad.bondedDevices ?: emptySet()) exchangeWith(d)
            if (running) ad.startDiscovery()
        } catch (e: SecurityException) { }
    }

    private fun listen() {
        try {
            val ss = adapter?.listenUsingInsecureRfcommWithServiceRecord("Serial Port", uuid) ?: return // neutral name (VAPT fix A7)
            server = ss
            while (running) {
                val s = ss.accept() ?: break
                exec.execute { session(s) }
            }
        } catch (e: Exception) {
        } finally {
            try { server?.close() } catch (e: Exception) { }
        }
    }

    private fun exchangeWith(d: BluetoothDevice) {
        val addr = d.address ?: return
        if (!running || !busy.add(addr)) return
        try {
            val s = d.createInsecureRfcommSocketToServiceRecord(uuid)
            try { adapter?.cancelDiscovery() } catch (e: SecurityException) { }
            s.connect()      // fails fast for phones without Raazdar
            session(s)
        } catch (e: Exception) {
        } finally {
            busy.remove(addr)
        }
    }

    /** Both sides send their whole pool (length-prefixed frames, 0 = end) and read the other's. */
    private fun session(sock: BluetoothSocket) {
        try {
            sock.use { s ->
                val out = DataOutputStream(BufferedOutputStream(s.outputStream))
                val inp = DataInputStream(BufferedInputStream(s.inputStream))
                val writer = exec.submit(Runnable {
                    val now = System.currentTimeMillis()
                    for (item in pool.values) {
                        if (item.exp <= now) continue
                        val b = JSONObject().put("to", item.to).put("mid", item.mid).put("env", item.env).put("exp", item.exp).toString().toByteArray()
                        out.writeInt(b.size); out.write(b)
                    }
                    out.writeInt(0); out.flush()
                })
                var n = 0
                while (n < 300) { // a malicious nearby phone can't flood us (VAPT fix A6)
                    val len = inp.readInt()
                    if (len == 0) break
                    if (len < 0 || len > 1_000_000) throw IOException("bad frame")
                    val b = ByteArray(len); inp.readFully(b)
                    accept(JSONObject(String(b)))
                    n++
                }
                writer.get(30, TimeUnit.SECONDS)
                try { peers.add(s.remoteDevice.address) } catch (e: Exception) { }
                Thread.sleep(300)
            }
        } catch (e: Exception) { }
    }

    private fun accept(j: JSONObject) {
        val to = j.optString("to"); val mid = j.optString("mid"); val env = j.optString("env")
        val now = System.currentTimeMillis()
        val exp = minOf(j.optLong("exp"), now + ttl)
        if (!idRe.matches(to) || mid.isEmpty() || mid.length > 40 || env.length > 900_000 || exp < now) return
        if (!seen.add(mid)) return
        if (to == myId) deliver(to, mid, env)
        else if (pool.size < 1000) pool[mid] = Item(to, mid, env, exp) // carry it for someone else
    }
}
