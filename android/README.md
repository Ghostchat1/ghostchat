# GhostChat Android app

The full GhostChat app, with its code **bundled inside** (never downloaded from the server), plus:
- 🚫 screenshots and screen recording blocked
- 🔥 panic wipe: all data erased, then Android's "Uninstall?" prompt
- 📶 offline Bluetooth mesh chat
- 🧮 real "Calculator" home-screen disguise

## Get the APK (no Android Studio needed)

1. **Make a free GitHub account** and create a **new private repository**.
2. **Upload the whole `ghostchat` folder** to it (on github.com: "Add file" → "Upload files", then drag the folder contents in).
   The `.github` folder must be included. It holds the build instructions.
3. Open the repo's **Actions** tab, click **Build Android APK**, then **Run workflow**.
4. After about 5–8 minutes, open the finished run and download **GhostChat-APK** under "Artifacts". Unzip it to get the `.apk`.
5. On the phone, open the APK and allow "install unknown apps" when asked.

If the build fails, copy the red error lines from the Actions log and send them to me. First builds of a new Android project often need one small fix.

### Before sharing the app with others: sign it with your own key
Without your own key, each build gets a throwaway signature, and a new version won't install over the old one.
Create a key once, on any computer with Java:
```
keytool -genkeypair -v -keystore ghost.jks -alias ghost -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 ghost.jks > ghost.b64
```
In the repo, go to **Settings → Secrets and variables → Actions** and add:
`GC_KEYSTORE_B64` (contents of ghost.b64), `GC_KEYSTORE_PASS`, `GC_KEY_ALIAS` (= ghost), `GC_KEY_PASS`.
**Keep ghost.jks safe and private.** Whoever has it can publish "updates" of your app.

## Using it
1. **Install Orbot** (free, from the Tor Project / Guardian Project) and turn on its **VPN mode** for GhostChat. This sends the app's traffic through Tor so it can reach your `.onion` server.
2. Open GhostChat and enter your server's `.onion` address once, e.g. `http://abc…xyz.onion`.
3. Create your account as usual.

## How each feature works
| Feature | How |
|---|---|
| Screenshot block | `FLAG_SECURE` on the window: blocks screenshots, recording and casting, and blanks the app in Recents. |
| Panic uninstall | Clears WebView storage, then `clearApplicationUserData()` erases all app data, and `ACTION_DELETE` opens Android's uninstall prompt. Silent uninstall is impossible on Android without device-owner rights. |
| Bluetooth mesh | Bluetooth Classic RFCOMM, store-and-forward. Phones swap pools of sealed envelopes every 45 s with paired phones and with any visible GhostChat phone. Envelopes are kept up to 3 days, 1000 max, in memory only. |
| Calculator icon | Two launcher entries (`activity-alias`); the disguise switch enables one and disables the other. |
| Bundled code | Served from the private in-app address `https://appassets.androidplatform.net` with a strict Content-Security-Policy, so no outside script can ever run. |
| No cloud backups | `allowBackup="false"`, so Android/Google backups never copy app data. |

## Known limits
- Not compiled or device-tested yet (see the main README).
- Bluetooth discovery is slow (about 12 s per scan) and both phones need GhostChat open and unlocked. Classic Bluetooth range is roughly 10–30 m.
- Orbot VPN mode is required to reach a `.onion` server. A future version could embed Tor inside the app.
