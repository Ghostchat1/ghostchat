# Raazdar v5: anonymous messenger on Tor

A WhatsApp-style chat app with **no phone, no email and no name**. It runs as a **Tor onion service**, so neither the server's location nor the users' IP addresses are exposed.

## What protects you

| Layer | What it does |
|---|---|
| **Tor onion service** | The app only exists at a `.onion` address. Users can't find the server's IP, and the server can't see users' IPs. Traffic is end-to-end encrypted by Tor itself. |
| **No identity** | Your ID (e.g. `K7QM-2XRA-9FDP`) is a hash of a key generated on your device. Nothing else is collected. |
| **End-to-end encryption** | ECDH P-384 key exchange, AES-256-GCM, HKDF-SHA-384, ECDSA P-384 signatures. These are the primitives in the NSA's CNSA suite for TOP SECRET data, which is what "military grade" usually means. |
| **Forward secrecy** | A fresh key for every message, plus prekeys that rotate every 48 h and are destroyed after 9 days. A key stolen later can't unlock past messages. |
| **Sealed sender** | Messages are posted through an anonymous connection and the sender's ID is inside the encryption. **The server can't see who sent anything.** |
| **Size padding** | Every message is padded to fixed sizes (1 KB / 4 KB / 16 KB / 64 KB), so its length gives nothing away. |
| **Server forgets** | Messages are deleted the moment they're delivered (max 7 days). By default the server runs **RAM-only**: nothing is written to disk and a reboot erases everything. No logs. |
| **Locked device vault** | Keys, contacts and messages are stored encrypted with your passcode (PBKDF2-SHA-384, 600,000 rounds). The app auto-locks after 3 min in the background. **10 wrong passcodes erase everything.** |
| **Anti-tampering** | The app checks every contact's keys against their ID and signatures, so a hacked server can't secretly swap keys. Safety numbers let two people confirm this in person. |
| **Other** | Disappearing messages (30 s to 7 days), screen hidden in the app switcher, no read receipts, no last seen, no online status, notifications that never show names or text, strict Content-Security-Policy. |

Tested: two users exchanged messages through the server. The server's stored data held no plaintext, no sender ID and no "from" field. The browser storage held no readable text. Wrong passcodes were counted, restoring from a backup brought back the full history, and both safety numbers matched. A RAM-wipe restart recovered on its own. Tor validated the configuration and generated an onion address from it.

## Security assessment (v5.1)
A full OWASP-style code review and penetration test was run on the server, web app, cryptography and Android code (about 80 automated checks). It found 16 issues: 1 critical, 3 high, 6 medium and 6 low, and all of them are fixed and retested. The report is published separately.

Server abuse limits you can tune with environment variables:

| Variable | Default | What it does |
|---|---|---|
| `POW_BITS` | 18 | Proof-of-work per signup (about 1 s in a browser). Raise to 20–22 if bots sign up in bulk. |
| `MAX_USERS` | 100000 | Total accounts the server will hold |
| `MAX_CONNS` | 3000 | Total open connections |
| `GLOBAL_QUEUE_BYTES` | 512 MB | Total waiting messages, across everyone |
| `DROPS_PER_MIN` | 120 | Messages per minute that can be queued for one person |

## New in v5

| Feature | Where | Status |
|---|---|---|
| **Double Ratchet: a new key for every message** | Web + app | ✅ Built and tested |
| **Group chats** | Web + app | ✅ Built and tested |
| **Screenshot and screen-recording block** | Android app | 🟡 Written, not compiled yet |
| **Panic: wipe everything + uninstall prompt** | Android app | 🟡 Written, not compiled yet |
| **Offline Bluetooth chat (mesh)** | Android app | 🟡 Written, not compiled yet. Web side tested in a simulation |
| **Real calculator icon on the home screen** | Android app | 🟡 Written, not compiled yet |
| **App code bundled inside the app** (fixes the "server could serve altered code" weakness) | Android app | 🟡 Written, not compiled yet. Tested in a simulation |

### Double Ratchet
This is the same idea as Signal's protocol. Every message gets a new key, used once and then destroyed. Every reply mixes in a fresh key exchange.
- **Per-message forward secrecy:** stealing your phone's keys today can't unlock messages already received.
- **Self-healing:** if a key is stolen, the conversation locks the attacker out again within one back-and-forth.
- The session starts from the quantum-safe handshake, and every message still travels inside the quantum-safe sealed-sender envelope.

Tested:
- a burst of messages arrived in order, and the key changed after each reply
- messages delivered in reverse order all decrypted
- a replayed old message was rejected
- both people starting a chat at the same moment worked
- a broken session (for example after restoring an old backup) healed on its own

### Group chats
- Create a group, add or remove members, rename it, set disappearing messages, and leave.
- **The server can't even see that a group exists.** Each message is sealed separately for each member over their own ratchet, so to the server it looks like ordinary one-to-one traffic.
- Only the admin can change who's in the group. If the admin leaves, the next member takes over.
- ✓✓ appears only when every member has the message.
- Members you haven't added as contacts appear by name in the group but don't clutter your chat list.
- Tested: everyone received the messages, removed members stopped getting them, and leaving was shown to the others.

### Android app (`android/` folder)
- **Code bundled inside the app.** The app never downloads its code from the server, which closes the biggest remaining weakness of the web version.
- **Screenshots blocked.** Screenshots, screen recording and casting are blocked, and the app shows blank in the recent-apps view (FLAG_SECURE).
- **Panic uninstall.** A wipe erases every byte of app data instantly, and Android's own "Uninstall Raazdar?" prompt appears. One tap removes the app. **Android does not allow any app to uninstall itself silently**, so this one tap is as far as any app can go. The data is already gone before the prompt appears.
- **Offline Bluetooth mesh.** With no internet, already-encrypted messages hop phone-to-phone over Bluetooth, and phones in between can carry messages for others. Carriers see only the recipient's anonymous ID, never the sender or the content. It works automatically between phones paired in Bluetooth settings. Unpaired phones are found while they're "visible", which Android allows for up to 5 minutes at a time.
- **Calculator disguise.** The real home-screen icon and name change to "Calculator".
- **How to get the APK:** see `android/README.md`. The build runs free on GitHub, so you don't need Android Studio.

**Honest status:** this workspace can't download Android's build tools, so the Android app has not been compiled or run on a phone yet. The Kotlin parses cleanly and the web side was tested in a simulation of the app. Expect possibly one round of small fixes when it's first built on GitHub. Real-world Bluetooth range and discovery also need testing on actual phones.

**iPhone:** iOS doesn't let apps block screenshots, uninstall themselves, or run a background Bluetooth mesh like this. An iPhone version would only get the web features.

## New in v4

| Feature | What it does |
|---|---|
| **Quantum-safe encryption** | Every message is also locked with ML-KEM-768 (NIST FIPS 203) alongside P-384. Traffic recorded today stays locked even against future quantum computers. An attacker has to break both locks. |
| **🎭 Decoy account** | A second passcode opens a separate, fully working account. The device always holds two encrypted "slots" of the same size, so nobody can tell whether the second slot is a hidden account or random noise. Stronger than a duress wipe, because a freshly wiped app looks suspicious and a normal-looking account doesn't. |
| **🧮 Calculator disguise** | The app opens as a working calculator, and the browser tab says "Calculator". Typing your secret number and pressing **=** brings up the passcode screen. **Holding C for 2 s** erases everything. |
| **📡 Cover traffic** | At random moments the app sends dummy messages that look identical to real ones on the network. Someone watching can't tell when you're actually chatting. |
| **📷 Photos, with hidden data removed** | Every photo is redrawn before sending, which strips GPS location, phone model and time stamps. Tested on a photo containing GPS and a phone model: none of it survived. |
| **View-once photos** | The photo is destroyed after it's opened. |
| **Daily key rotation** | Prekeys now rotate every 24 h instead of 48 h. |

Tested end to end with two users: quantum-safe messages, offline delivery, the server seeing no sender or text, photo metadata removed, view-once destroying the photo, cover traffic arriving and being discarded silently, the decoy and real passcodes opening different accounts, the calculator doing real math and unlocking with the secret number, and every panic trigger leaving zero data on the device.

**Honest notes on the new features:**
- The two vault slots start the same size. A heavily used real account can grow past the decoy, so use the decoy a little too.
- The decoy and the calculator fool a person searching your phone. An expert who knows Raazdar's code knows these features exist and can guess you may be using them. That's true of every deniability feature in every app.
- A wipe triggered from the lock or calculator screen can't erase chats from contacts' phones, because the keys needed to send that order are themselves locked. Wipe while unlocked (hold 🔒) for that.
- The calculator disguise is strongest in Tor Browser. If the app was added to a home screen, the installed icon and name can't be changed by a web app.

## 🚨 Panic button

**How to trigger a wipe** (none of these ask for confirmation, except the menu option):
- **Hold 🔒 for 2 seconds.** Works without looking at the screen.
- **On the lock screen, hold the ghost logo for 2 seconds.** Works without the passcode.
- **Type the duress passcode** when someone forces you to unlock. The app erases itself silently and opens like a fresh install, as if it was never used.
- **10 wrong passcodes in a row.**
- **Auto-erase (dead-man's switch).** If the app isn't unlocked for 3, 7 or 30 days, it erases itself the next time it's opened.
- **Menu → Erase everything.** This one asks for confirmation.

**What gets destroyed, in order:**
1. The screen goes blank instantly.
2. A sealed **"burn" order goes to every contact**, and their app deletes your chat with them. This is on by default and can be turned off in Panic settings.
3. Your ID, keys and waiting messages are **deleted from the server**.
4. Everything on the device is erased: the encrypted vault, settings, offline app copy, service worker and caches.
5. The browser is told to **clear all site data** (`Clear-Site-Data`). The tab lands on a blank "New Tab" page, and the back button doesn't return to the chats.

Tested: every trigger left zero Raazdar data on the device, the server forgot the ID, and the contact's copy of the chat disappeared.

**Can it uninstall the app itself?** No website or web app can uninstall itself. Phones and browsers don't allow it. In practice:
- **Best setup: use it in Tor Browser and don't add it to the home screen.** Then there's nothing installed to remove. Tor Browser keeps no history, so after a wipe there's no trace that Raazdar was used.
- If it was added to the home screen, the icon stays after a wipe, but opening it shows an empty, never-used app. Long-press the icon → Remove to delete it.
- A native Android version could open the system "Uninstall?" prompt as the last step of a wipe, and the user taps OK. iPhone doesn't let any app uninstall itself.

## Deploy as an onion service

### Option A: one command on a VPS (Ubuntu 22.04+ / Debian 12+)
```
sudo bash deploy/setup-onion.sh
```
It installs Tor and Node.js and runs the app sandboxed on localhost only, in RAM with no logs. It also sets a firewall that blocks all incoming traffic except SSH, makes system logs RAM-only, and prints your `.onion` address.

**Back up `/var/lib/tor/ghostchat/`.** Those keys *are* your onion address.

### Option B: Docker
```
docker compose up -d --build
docker compose exec tor cat /var/lib/tor/ghostchat/hostname
```
The app container has no internet access and publishes no ports. Only the Tor container can reach it.

### Users open it with
- **Android / desktop:** Tor Browser (torproject.org)
- **iPhone:** Onion Browser

Tor Browser deletes site data when it closes by default. Users should either save an **Encrypted backup** (Menu → Encrypted backup) and restore it next time, or turn off "Always use private browsing mode" in Tor Browser's settings.

## Run locally for testing
```
npm install
HOST=0.0.0.0 npm start      # http://localhost:3000
```

## Limits (no app can promise "untraceable")
1. **A hacked or seized phone beats any encryption.** Spyware, someone watching the screen, or the other person screenshotting your chat can't be prevented by the app. Use a strong passcode.
2. **Web app trust.** The app's code is loaded from the server every time. If the server is taken over, an attacker could serve altered code. Self-hosting reduces this risk. A fully packaged mobile app (next step) removes it.
3. **Timing analysis.** Someone who can watch both people's internet connections at once could match up their traffic timing. Tor makes this hard, but no low-latency system can make it impossible.
4. **Hosting provider.** The provider can see that your server runs Tor, but not what passes through it. For extra separation, pay for the VPS anonymously.
5. **No voice notes or calls yet.** Each one needs its own careful crypto design.
6. **Not independently audited.** The design follows established patterns: X3DH-style prekeys and Signal-style sealed sender. Get a professional audit before relying on it for life-or-death situations.

## Files
- `server.js`: relay (RAM-only, localhost-only, sealed-sender drop box)
- `public/app.js`: client and all cryptography
- `public/pq.js`: ML-KEM-768 from `@noble/post-quantum` (MIT, audited library), bundled
- `deploy/setup-onion.sh`, `deploy/torrc`: VPS onion install
- `Dockerfile`, `docker-compose.yml`, `deploy/tor/`: Docker onion install

## Licence
Raazdar's code is free software under the **GNU Affero General Public License v3.0 or later** (see `LICENSE`).
You can read, audit and modify it. If you run a modified version as a service for others, you must
publish your changes under the same licence.

The **Raazdar name and logo are trademarks of Hyperviz Labs** and are not covered by the code licence.
Forks must use a different name and logo.

Copyright © 2026 Hyperviz Labs, Ludhiana, India.
