# Security policy

## Reporting a vulnerability
Email **privacy@quietline.chat** with the subject "Security". Please include steps to reproduce.
- We acknowledge within 72 hours and aim to fix critical issues within 14 days.
- Please give us 90 days before publishing, or less once a fix has shipped.
- Good-faith research that respects users' privacy (no access to other people's data, no denial of
  service, no social engineering) will not be pursued legally, and we will credit you if you wish.
- Machine-readable contact: https://raazdar.app/.well-known/security.txt

## In scope
The relay server (`server.js`), the web app (`public/`), the Android app (`android/`), the desktop app
(`desktop/`), the call relay configuration (`deploy/setup-calls.sh`) and raazdar.app / the .onion address.

## Testing so far
- **Internal security assessment, November 2026** (commissioned and approved by Mohit Sharma, CEH, Hyperviz Labs):
  `security/INTERNAL-ASSESSMENT-2026-11.md`. 0 critical, 1 high, 5 medium, 6 low; all fixed except 1 low.
- **Internal VAPT / OWASP testing** by the Raazdar team: automated attack suites in `security/`
  (server: 32 checks, client: 11 checks) with before/after results published in that folder.
- **Independent third-party audit:** not yet done. When it is, the full report will be published here.

## Design summary
- Hybrid post-quantum key exchange (ML-KEM-768 + ECDH P-384), Double Ratchet, AES-256-GCM, sealed sender.
- Server is RAM-only, keeps no logs, and never sees plaintext, sender identity or contact lists.
- Large files: encrypted on the device; the key travels only inside the end-to-end encrypted message.
- Calls: WebRTC DTLS-SRTP; call setup (including DTLS fingerprints) is exchanged inside end-to-end encrypted
  messages; media is forced through the TURN relay so peers never learn each other's IP. Short-lived TURN
  credentials are issued only to authenticated users. Calls are disabled on the .onion address.
