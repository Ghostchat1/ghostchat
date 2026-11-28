package net.ghostchat.app

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.webkit.JavascriptInterface
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.widget.Toast
import java.io.File

/** The small set of native powers the web app may use (window.GhostNative in JavaScript). */
/** Server used unless the person enters another one. */
const val DEFAULT_SERVER = "https://raazdar.app"

class GhostBridge(private val a: MainActivity) {
    private val prefs = a.getSharedPreferences("gc", Context.MODE_PRIVATE)
    // https anywhere; plain http ONLY for .onion, which Tor already encrypts (VAPT fix A2)
    private val serverRe = Regex("^(https://[A-Za-z0-9.-]+(:\\d+)?|http://[a-z2-7]{56}\\.onion(:\\d+)?)$")

    @JavascriptInterface
    fun server(): String = prefs.getString("server", DEFAULT_SERVER) ?: DEFAULT_SERVER

    /** Saves a received (already decrypted) file to the phone's Downloads folder. */
    @JavascriptInterface
    fun saveFile(name: String, mime: String, b64: String) {
        val safe = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").take(80).ifBlank { "file" }
        try {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            if (Build.VERSION.SDK_INT >= 29) {
                val v = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safe)
                    put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
                }
                val uri = a.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v) ?: throw Exception("no uri")
                a.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
            } else {
                val dir = a.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: throw Exception("no dir")
                File(dir, safe).writeBytes(bytes)
            }
            a.runOnUiThread { Toast.makeText(a, "Saved to Downloads: $safe", Toast.LENGTH_SHORT).show() }
        } catch (e: Exception) {
            a.runOnUiThread { Toast.makeText(a, "Couldn't save the file", Toast.LENGTH_SHORT).show() }
        }
    }

    /** Call audio: "earpiece" (held to the ear), "speaker" (loudspeaker) or "off" (call ended). */
    @JavascriptInterface
    fun callAudio(mode: String) { a.runOnUiThread { a.setCallAudio(mode) } }

    @JavascriptInterface
    fun ring(on: Boolean) { a.runOnUiThread { a.ring(on) } }

    /** Scam-protection check: remote-control apps, apps that can read the screen, screen recording. */
    @JavascriptInterface
    fun safetyScan(): String = a.safetyScan()

    @JavascriptInterface
    fun setServer(url: String) {
        if (serverRe.matches(url)) prefs.edit().putString("server", url).apply()
    }

    /** Calculator disguise: swaps the real home-screen icon and name between "Raazdar" and "Calculator". */
    @JavascriptInterface
    fun setDisguise(on: Boolean) {
        if (prefs.getBoolean("disguise", false) == on) return
        prefs.edit().putBoolean("disguise", on).apply()
        val pm = a.packageManager
        val ghost = ComponentName(a, "net.ghostchat.app.LauncherGhost")
        val calc = ComponentName(a, "net.ghostchat.app.LauncherCalc")
        val enable = if (on) calc else ghost
        val disable = if (on) ghost else calc
        pm.setComponentEnabledSetting(enable, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
        pm.setComponentEnabledSetting(disable, PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
    }

    /** Panic: wipe all app data and show Android's uninstall prompt. */
    @JavascriptInterface
    fun panic() { a.runOnUiThread { a.panic() } }

    @JavascriptInterface
    fun meshStart(id: String) { a.runOnUiThread { a.startMesh(id) } }

    @JavascriptInterface
    fun meshStop() { a.mesh.stop() }

    @JavascriptInterface
    fun meshSend(to: String, mid: String, env: String) { a.mesh.send(to, mid, env) }

    @JavascriptInterface
    fun meshStatus(): String = a.mesh.status()

    @JavascriptInterface
    fun meshVisible() { a.runOnUiThread { a.makeVisible() } }
}
