package net.ghostchat.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.bluetooth.BluetoothAdapter
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.PowerManager
import android.os.Bundle
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.content.Context
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.IOException

/**
 * Raazdar for Android.
 *  - The whole app (HTML/JS/crypto) is bundled inside the APK and served from a private
 *    in-app address, so its code is never downloaded from the server.
 *  - FLAG_SECURE blocks screenshots, screen recording and casting, and blanks the
 *    app in the recent-apps switcher.
 */
class MainActivity : Activity() {
    lateinit var web: WebView
    lateinit var mesh: Mesh
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingMic: PermissionRequest? = null
    private var pendingRes: Array<String> = arrayOf()
    private var pendingMeshId: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        WebView.setWebContentsDebuggingEnabled(false)

        val loader = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/", WebViewAssetLoader.PathHandler { path -> asset(path) })
            .build()

        web = SecureWebView(this)
        web.filterTouchesWhenObscured = true // ignore taps while another app draws over us (tapjacking, VAPT fix A3)
        setContentView(web)
        web.settings.apply {
            mediaPlaybackRequiresUserGesture = false  // lets the other person's call audio play without an extra tap
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // the page is on the in-app https address; the server is a plain-http .onion (encrypted by Tor)
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (request.url.host == HOST) loader.shouldInterceptRequest(request.url) else null

            // never navigate away from the bundled app
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.host != HOST
        }
        web.webChromeClient = object : WebChromeClient() {
            // voice messages: the microphone only, and only after Android's own permission prompt
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val res = request.resources.filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE }
                    if (request.origin.host != HOST || res.isEmpty()) { request.deny(); return@runOnUiThread }
                    val need = res.map { if (it == PermissionRequest.RESOURCE_VIDEO_CAPTURE) Manifest.permission.CAMERA else Manifest.permission.RECORD_AUDIO }
                        .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
                    if (need.isEmpty()) request.grant(res.toTypedArray())
                    else { pendingMic = request; pendingRes = res.toTypedArray(); requestPermissions(need.toTypedArray(), REQ_MIC) }
                }
            }
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                return try {
                    startActivityForResult(params.createIntent(), REQ_FILE); true
                } catch (e: Exception) {
                    fileCallback = null; false
                }
            }
        }

        mesh = Mesh(this) { to, mid, env ->
            runOnUiThread {
                web.evaluateJavascript("window.ghostMeshReceive&&ghostMeshReceive(${q(to)},${q(mid)},${q(env)})", null)
            }
        }
        web.addJavascriptInterface(GhostBridge(this), "GhostNative")
        web.loadUrl("https://$HOST/index.html")
    }

    /** Serves files from assets/www/ with a strict security policy: scripts may only come from the app itself. */
    private fun asset(path: String): WebResourceResponse? {
        val p = if (path.isEmpty()) "index.html" else path
        if (p.contains("..")) return null
        val mime = when (p.substringAfterLast('.', "")) {
            "html" -> "text/html"
            "js" -> "text/javascript"
            "css" -> "text/css"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "json", "webmanifest" -> "application/json"
            else -> "application/octet-stream"
        }
        return try {
            WebResourceResponse(mime, "utf-8", assets.open("www/$p")).apply {
                responseHeaders = mapOf("Content-Security-Policy" to CSP, "Cache-Control" to "no-store", "Referrer-Policy" to "no-referrer")
            }
        } catch (e: IOException) {
            null
        }
    }

    // ---------- Bluetooth mesh ----------
    private fun btPerms(): Array<String> =
        if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE)
        else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    fun startMesh(id: String) {
        val missing = btPerms().filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            pendingMeshId = id
            requestPermissions(missing.toTypedArray(), REQ_BT)
            return
        }
        mesh.start(id)
    }

    fun makeVisible() {
        try {
            startActivityForResult(Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE).putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, 300), REQ_VISIBLE)
        } catch (e: Exception) { }
    }

    // ---- call audio: earpiece by default for voice calls, like a normal phone call ----
    private var proxLock: PowerManager.WakeLock? = null
    fun setCallAudio(mode: String) {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (mode == "earpiece" || mode == "speaker") {
            val speaker = mode == "speaker"
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            if (Build.VERSION.SDK_INT >= 31) {
                val devs = am.availableCommunicationDevices
                val headset = devs.firstOrNull { it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                    it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET || it.type == AudioDeviceInfo.TYPE_USB_HEADSET }
                val want = if (speaker) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                val dev = if (!speaker && headset != null) headset else devs.firstOrNull { it.type == want }
                if (dev != null) am.setCommunicationDevice(dev)
            } else {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = speaker
            }
            volumeControlStream = AudioManager.STREAM_VOICE_CALL
            proximity(!speaker) // screen turns off when the phone is at your ear
        } else {
            if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice() else {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = false
            }
            am.mode = AudioManager.MODE_NORMAL
            volumeControlStream = AudioManager.USE_DEFAULT_STREAM_TYPE
            proximity(false)
        }
    }
    private fun proximity(on: Boolean) {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (on) {
            if (proxLock == null && pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK))
                proxLock = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "raazdar:call").also { it.acquire(3 * 60 * 60 * 1000L) }
        } else {
            proxLock?.let { if (it.isHeld) it.release() }; proxLock = null
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_MIC) {
            val ok = grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }
            pendingMic?.let { if (ok) it.grant(pendingRes) else it.deny() }
            pendingMic = null
            return
        }
        if (requestCode == REQ_BT && grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
            pendingMeshId?.let { mesh.start(it) }
        }
        pendingMeshId = null
    }

    // ---------- panic: wipe everything, then ask Android to uninstall ----------
    fun panic() {
        try { mesh.stop(); mesh.clear() } catch (e: Exception) { }
        try {
            web.clearCache(true); web.clearHistory(); web.clearFormData()
            WebStorage.getInstance().deleteAllData()
            CookieManager.getInstance().removeAllCookies(null)
        } catch (e: Exception) { }
        // 1) Android's own "Uninstall Raazdar?" prompt. One tap. (Android never allows any app to uninstall itself silently.)
        try {
            startActivity(Intent(Intent.ACTION_DELETE, Uri.parse("package:$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) { }
        // 2) Erase every byte of app data (IndexedDB, WebView storage, settings) and stop the app.
        web.postDelayed({
            try { (getSystemService(ACTIVITY_SERVICE) as ActivityManager).clearApplicationUserData() } catch (e: Exception) { finishAndRemoveTask() }
        }, 700)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // Back closes an open chat; otherwise the app goes to the background (it auto-locks there).
        web.evaluateJavascript("(function(){try{if(typeof current!=='undefined'&&current){closeChat();return 1}}catch(e){}return 0})()") { r ->
            if (r != "1") moveTaskToBack(true)
        }
    }

    override fun onPause() { super.onPause(); web.onPause() }
    override fun onResume() { super.onResume(); web.onResume() }
    override fun onDestroy() {
        try { mesh.stop() } catch (e: Exception) { }
        web.destroy()
        super.onDestroy()
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val REQ_FILE = 1
        const val REQ_BT = 2
        const val REQ_VISIBLE = 3
        const val REQ_MIC = 4
        const val CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src blob:; " +
            "connect-src 'self' http: https: ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        fun q(s: String): String = JSONObject.quote(s)
    }
}

/** Tells the keyboard not to learn or remember anything typed in Raazdar (VAPT fix A4). */
class SecureWebView(ctx: Context) : WebView(ctx) {
    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val ic = super.onCreateInputConnection(outAttrs)
        outAttrs.imeOptions = outAttrs.imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        return ic
    }
}
