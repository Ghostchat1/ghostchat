# Apple App Store: the plan

Apple will not accept the website wrapped in an app ("minimum functionality", guideline 4.2), and it
needs a Mac to build. We already solved both on Android: the app code is bundled inside the app. iOS
will do the same with Capacitor, built on GitHub's Mac machines, so you never need a Mac.

## What you need to do first
1. **Apple Developer Program, as an organisation** (Hyperviz Labs): https://developer.apple.com/programs/
   US$99/year. Needs a free D-U-N-S number for the company and a website with your company name
   (quietline.chat/about has it).
2. In App Store Connect create the app: bundle ID `app.raazdar`, name "Raazdar – Private Messenger".
3. Create an **App Store Connect API key** (Users and Access → Integrations → Keys, role *App Manager*)
   and add three repository secrets on GitHub: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the file's text).
   With those, the build can create its own certificates and upload to TestFlight.

Then tell Claude "Apple account ready" and the iOS build (Capacitor project + GitHub workflow) gets added.

## Review risks to avoid
- **Wording.** Apple rejects apps for "anonymous or prank" messaging (guideline 1.2 area). Describe
  Raazdar as a *private messenger* with "no phone number needed"; avoid "anonymous", "dark web",
  "untraceable" in the listing.
- **User-generated content (1.2):** needs block, report and a way to act on reports. Done (block,
  report to privacy@quietline.chat). Answer every report within 24 hours.
- **Account deletion (5.1.1):** done, in the app.
- **Encryption export question:** answer *Yes, it uses encryption*, and that it uses standard algorithms
  (AES, ECDH, ML-KEM) published by recognised standards bodies. Apple may ask for an export
  self-classification; Apple's help page walks through it.
- **Panic "uninstall" and Bluetooth mesh:** iOS doesn't allow an app to uninstall itself; the iOS build
  will only offer the in-app wipe. Bluetooth mesh would be a later addition.

## Store text
Reuse the Play listing (PLAY-STORE.md) with these changes: subtitle (30 chars) "No phone number. Encrypted.",
age rating 17+, privacy "nutrition label": *Data not linked to you*: Identifiers (random ID), User content
(messages, photos, audio; end-to-end encrypted). *Data used to track you*: none.
