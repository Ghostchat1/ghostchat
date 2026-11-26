# Google Play: everything to paste

Every official build now also produces **GhostChat-playstore.aab** (same app, same permanent signing key)
in the Android release on GitHub. That is the file you upload to Play.

## Before you start (one-time)
1. Create a Google Play developer account: https://play.google.com/console (US$25 once).
   - **Register as an organisation (Hyperviz Labs), not as a person.** Organisation accounts need a free
     D-U-N-S number for the company, but they skip Google's rule that new *personal* accounts must run a
     closed test with at least 12 testers for 14 days before they can publish.
2. When Play asks about app signing, accept **Play App Signing** (Google holds the key that signs what
   users download) and upload **GhostChat-playstore.aab**. Our permanent key then acts as the *upload key*.
   Play copies and GitHub copies will have different signatures, so someone switching between them must
   uninstall first (after saving a backup). Keep publishing the GitHub APK for people who avoid Google.

## Store listing
- **App name:** GhostChat – Private Messenger
- **Short description (80):** Private messenger with no phone number. End-to-end encrypted chats and calls.
- **Category:** Communication
- **Contact email:** privacy@quietline.chat · **Website:** https://quietline.chat
- **Privacy policy URL:** https://quietline.chat/privacy

**Full description**
```
GhostChat is a private messenger that never asks for your phone number, email or contacts.

• No phone number. Your phone creates a random ID; share it as a QR code or link.
• End-to-end encrypted messages, voice notes, photos, videos and files, using modern
  post-quantum encryption. Our server only ever holds sealed envelopes it can't open.
• Encrypted voice and video calls, relayed so neither person learns the other's IP address.
• Sealed sender: the server can't see who is writing to whom.
• Disappearing messages, view-once photos and photos cleaned of location data.
• Panic wipe: hold the lock button to erase everything instantly.
• Screenshot blocking, passcode lock, and an encrypted backup only you can open.
• Block and report anyone, at any time.
• No ads, no trackers, no analytics.

GhostChat is made by Hyperviz Labs, Ludhiana, India. Our code is public:
github.com/Ghostchat1/ghostchat
```
- **Graphics:** icon 512×512 (`public/icon-512.png`), feature graphic 1024×500, 2–8 phone screenshots
  (use the ones on quietline.chat/press, or take fresh ones on the phone).

## Content rating (IARC questionnaire)
- Category: *Communication / social*. Users can interact and exchange messages, photos and calls: **Yes**.
- Shares user location: **No**. Digital purchases: **No**. Unrestricted internet: **No** (it only talks to our server).
- Expected result: rated for teens/12+ with "Users Interact".

## Target audience
- **18 and over only.** (Our terms say adults only, and the sign-up asks users to confirm they are 18+.)

## Data safety form
Answer from what the app actually does (this is what's in our privacy notice):
- **Does your app collect or share any of the required user data types?** Yes (be conservative).
- **Is all user data encrypted in transit?** Yes.
- **Do you provide a way for users to request that their data is deleted?** Yes (in the app: You → Privacy & your data → Withdraw consent & erase account).
- Data types to declare, each as *Collected · Not shared · Required · Purpose: App functionality*:
  - **Messages → Other in-app messages** (end-to-end encrypted; we can't read them; deleted on delivery or after 7 days).
  - **Device or other IDs** (the random GhostChat ID; not linked to a person).
  - **Photos and videos / Files and docs** (only large files, end-to-end encrypted, deleted after 7 days).
  - **Audio → Voice or sound recordings** (voice notes, end-to-end encrypted).
- Do **not** declare: name, email, phone, contacts, location, financial info, app activity, analytics, ads.
- Google's guidance treats some end-to-end encrypted data differently; if their help page says you may
  leave E2E-encrypted data out, you can, but declaring it is never penalised.

## Policy points reviewers check (all done)
- Block and report users in chats and groups.
- In-app account deletion.
- Privacy policy reachable in the app and on the website.
- Permissions are explained when requested (microphone, camera, Bluetooth).

## One change before the first Play upload
Play restricts the "delete other apps" permission (`REQUEST_DELETE_PACKAGES`) that our panic
"uninstall GhostChat" option uses. Before the first upload, a Play-only build should leave that permission
out (the in-app wipe still works). Ask Claude for the "Play build without self-uninstall" when your account is ready.

## App access (for the reviewer)
"No login needed. Open the app, choose a passcode, tap Create. To test chatting, open
quietline.chat/app in a browser as a second user and add each other's ID."
