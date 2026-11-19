package net.ghostchat.app

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.webkit.JavascriptInterface

/** The small set of native powers the web app may use (window.GhostNative in JavaScript). */
class GhostBridge(private val a: MainActivity) {
    private val prefs = a.getSharedPreferences("gc", Context.MODE_PRIVATE)
    // https anywhere; plain http ONLY for .onion, which Tor already encrypts (VAPT fix A2)
    private val serverRe = Regex("^(https://[A-Za-z0-9.-]+(:\\d+)?|http://[a-z2-7]{56}\\.onion(:\\d+)?)$")

    @JavascriptInterface
    fun server(): String = prefs.getString("server", "") ?: ""

    @JavascriptInterface
    fun setServer(url: String) {
        if (serverRe.matches(url)) prefs.edit().putString("server", url).apply()
    }

    /** Calculator disguise: swaps the real home-screen icon and name between "GhostChat" and "Calculator". */
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
