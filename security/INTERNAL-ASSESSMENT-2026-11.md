# Raazdar internal security assessment, November 2026

| | |
|---|---|
| **Type** | Internal security assessment (VAPT, OWASP ASVS 4.0 L2 / MASVS). **Not an independent audit.** |
| **Commissioned and approved by** | Mohit Sharma (Certified Ethical Hacker), Grievance Officer, Hyperviz Labs |
| **Performed by** | Hyperviz Labs internal assessment, carried out with AI-assisted testing (Claude, Anthropic) |
| **Version tested** | Raazdar 6.5 (fixes shipped in 6.6) |
| **Dates** | 26–27 November 2026 |
| **Scope** | Relay server, web app, call relay (coturn), Android app, desktop app, deployment scripts, release pipeline |
| **Standards** | OWASP ASVS 4.0 Level 2, OWASP MASVS, OWASP WSTG |

## Summary

Raazdar's core promises held: in every test, our server saw only sealed, unreadable envelopes and never learned who sent a message. The most serious problem was in the new call relay: it would forward traffic to **any address on the internet**, so it could be abused as an open proxy. That is fixed and verified.

| Severity | Found | Fixed | Open |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 1 | 1 | 0 |
| Medium | 5 | 5 | 0 |
| Low | 6 | 5 | 1 |
| Informational | 7 | – | – |

Server-side fixes take effect once `deploy/harden.sh` has been run on the production server (see "Applying the fixes").

## Statement of independence

This is an **internal** assessment, decided on and approved by Hyperviz Labs, the company that builds and runs Raazdar. It is not independent. We publish it in full, including the method and every finding, so that anyone can check our work. An independent audit by an outside firm is planned; its report will be published here in full.

## Method

1. **Code review** of `server.js`, `public/app.js`, the Android shell (`android/`), the desktop app (`desktop/`), the deployment scripts (`deploy/`) and the GitHub Actions workflows.
2. **Automated attack suites**, run against a local copy of the server:
   - `security/attack_server.py`: 32 server attacks (HTTP, WebSocket, uploads, abuse limits). Output: `assessment-2026-11-server.txt`.
   - `security/attack_client.py`: 11 attacks by a malicious contact against two users (XSS, malformed messages, spoofing, storage). Output: `assessment-2026-11-client.txt`.
3. **Promise tests G1 to G12** with real browsers (Chrome, through Playwright), including a real call relay (coturn) and a dump of the server's memory.
4. **Regression tests** after every fix: messaging, groups, healing of broken sessions, large files, video, device move, panic wipe, iPhone storage modes, the website and calls.

Production was not attacked. All active testing used test accounts on a local copy.

## Promise checks

| # | Promise | Result | Evidence |
|---|---|---|---|
| G1 | The server can't read messages | **Pass** | A marker message was absent from every WebSocket frame and from a full dump of the server's memory |
| G2 | Sealed sender | **Pass** | Waiting envelopes hold only `env`, `exp` and `mid`; the sender's ID appears nowhere on the server |
| G3 | No logs | **Pass after fix M1** | The app logs one start-up line; web-server and system logs could hold IPs (fixed) |
| G4 | Calls hide your IP | **Pass** | During a real call both sides saw only the relay's address (`relay` candidates only) |
| G5 | Calls can't be hijacked | **Pass** | Call setup travels inside end-to-end encrypted messages; relay credentials go only to signed-in IDs (A03) |
| G6 | The call relay can't be abused | **Pass after fix H1** | Before: relaying to 1.1.1.1 and 8.8.8.8 worked. After: refused ("peer IP denied") |
| G7 | Large files stay private | **Pass** | The server holds ciphertext only, under a random 32-character ID; deleted after 7 days or 64 downloads; uploads need a token (A01, A04) |
| G8 | Device move links work once | **Pass** | A reused link returns 404 |
| G9 | Panic wipe | **Pass** | Menu panic leaves 0 storage keys, 0 databases, 0 caches and 0 service workers; the account is deleted from the server |
| G10 | Notifications carry no content | **Pass** | Push requests have an empty body (code review) |
| G11 | The Tor address doesn't leak | **Pass** | Strict same-origin CSP; calls and push are off on the .onion address |
| G12 | Blocked contacts can't reach you | **Pass** | Their messages are dropped and their calls don't ring |

## Findings

### H1 · The call relay could be used as an open proxy · High · Fixed
**Component:** `deploy/setup-calls.sh` (coturn). **CVSS 3.1:** 7.2 (AV:N/AC:L/PR:L/UI:N/S:C/C:N/I:L/A:L)
Anyone could create a free account, get relay credentials and send traffic through our server to any public address. The relay only blocked private networks. Attackers could hide behind our server's IP or run up its bandwidth.
**Fix:** both callers always use the same relay, so it now talks only to itself. Every other address on the internet is refused (`allowed-peer-ip` = the server only), and TCP relaying is off. Tested with a real coturn before and after.

### M1 · Web-server and system logs could record visitors' IP addresses · Medium · Fixed
**Component:** Caddy, journald, rsyslog, ufw.
Caddy had no access log, but its error and TLS messages (which can include a visitor's IP) went to the system journal and syslog, both stored on disk.
**Fix:** `harden.sh` turns all Caddy logging off, keeps system logs in memory only, stops syslog copies, turns firewall logging off, and removes old lines.

### M2 · Anyone could fill the file and device-move stores without an account · Medium · Fixed
**Component:** `POST /api/blob`, `POST /api/move`.
Anonymous uploads could fill the 300 MB file store and block large files for everyone.
**Fix:** uploads now need a one-time token that only a signed-in ID can get, with a daily allowance per ID (200 MB of files, 6 moves). Verified by A01–A05.

### M3 · Mass sign-ups could exhaust the server's memory · Medium · Fixed
**Component:** `POST /api/register`.
The account cap (100,000) was larger than a 1 GB server can hold.
**Fix:** the sign-up puzzle gets harder as the server fills up, and new sign-ups are refused when memory is tight. Existing accounts are not affected.

### M4 · The server ran an unsupported Node.js · Medium · Fixed
Ubuntu's Node.js 18 no longer gets free security updates. **Fix:** `harden.sh` installs Node.js 22 LTS and turns on automatic security updates.

### M5 · The desktop app used an out-of-support Electron · Medium · Fixed
Electron 33 no longer gets Chromium security fixes. **Fix:** moved to Electron 45. The app also now hides local network addresses from WebRTC.

### L1 · Calls trusted the server to require the relay · Low · Fixed
A tampered server could have told the app to call directly, revealing IP addresses. **Fix:** the app refuses to place or answer a call unless the relay is in use.

### L2 · A re-used socket kept its old subscription · Low · Fixed
**Fix:** signing in as another ID on the same connection now drops the old one.

### L3 · Android saved received files with the sender's chosen file type · Low · Fixed
**Fix:** unknown file types are saved as raw data.

### L4 · Android allowed unencrypted http to any address · Low · Fixed
**Fix:** plain http is allowed only for .onion addresses, which Tor encrypts.

### L5 · Server updates didn't install exact dependency versions · Low · Fixed
**Fix:** updates use the lockfile (`npm ci`).

### L6 · Build actions are pinned to version tags, not commit hashes · Low · Open
A compromised third-party GitHub Action could change our builds. **Plan:** pin every action to a commit hash. Until then, the published signing-certificate check still stops a wrong-key APK from being released.

### Informational
- **I1 Messages from strangers.** Anyone who knows your ID can message you, up to 120 messages a minute. Block and report are available. Planned: delivery tokens, so that only people you've accepted can message you.
- **I2 IP addresses in memory.** On the normal web address, the web server and call relay see visitors' IPs in memory while connected. They are never written down. Use the Tor address to hide your IP even from us.
- **I3 Push timing.** If you turn notifications on, Apple or Google can see when *something* arrives, never what or from whom.
- **I4 Passcode strength.** A stolen, locked phone vault costs about 0.25 s per guess on a laptop. An 8-letter passcode could fall to a determined attacker in months; a 4-word passphrase is out of reach.
- **I5 Duress code.** It is stored as a PBKDF2 hash (100,000 rounds). A short numeric code can be recovered from a stolen device, but it opens nothing.
- **I6 After an automatic wipe**, the browser shows the sign-in page; browser history still shows the site was visited.
- **I7 Accounts.** The GitHub, DigitalOcean, Hostinger and email accounts must use two-factor authentication, and SSH must use keys only. `harden.sh` reports the SSH setting; the owner confirms the rest.

## Applying the fixes
- App, Android and desktop fixes ship in **Raazdar 6.6**.
- Server fixes: run once on the server
  `ghostchat-update && bash /root/ghostchat/deploy/update.sh && bash /root/ghostchat/deploy/harden.sh`

## Appendix
- Raw results: `assessment-2026-11-server.txt` (32/32 pass, 1 informational) and `assessment-2026-11-client.txt` (11/11 pass, 2 informational).
- Two test-tool corrections were made during the assessment: the client XSS check counted the app's own icons as injected elements (fixed to count only injected handlers), and the blocked-contact test initially skipped the confirmation dialog. Neither was an app defect.
- Next internal assessment: after the next major release. Independent audit: planned.

*Hyperviz Labs, 2nd Floor, BXX-3369, Ferozepur Road, Ludhiana, Punjab 141001 · privacy@quietline.chat*

## Engineering checklist review (added 27 November 2026)
We also checked Raazdar against a widely shared list of about 110 engineering and security practices.

| Area | Status | Notes |
|---|---|---|
| Rate limiting, input validation, server-side validation, error handling, HTTP status codes | Done | Per-socket and per-recipient limits, proof-of-work sign-up, upload allowances |
| Authentication, authorization, session management, brute-force protection, account lockout | Done | Signature-based sign-in, no passwords on the server; 10 wrong passcodes wipe the phone |
| XSS, CSRF, clickjacking, CSP, security headers, SSRF, open redirects, path traversal, command injection, mass assignment, IDOR | Done | Tested by the attack suites (C01, W01–W10, H-series, A01–A05) |
| HTTPS/TLS, encryption in transit and at rest, hashing vs encryption, salting | Done | TLS plus end-to-end encryption; passcode vault AES-256-GCM with salted PBKDF2 |
| Secrets management, environment variables, secret rotation, least privilege | Done | Secrets in root-only files and GitHub Secrets; prekeys rotate; service runs unprivileged |
| File upload security | Done | Ciphertext only, size limits, signed-in token, served as raw bytes |
| Idempotency, timeouts, exponential backoff, graceful shutdown | Done | Duplicate-safe message IDs; reconnect backoff with jitter (added); handover on restart |
| Health checks, uptime monitoring, alerting | **Added** | `/healthz`, 30-minute uptime and certificate check that emails the owner on failure |
| Automated testing, CI/CD, dependency vulnerabilities | **Added** | Security tests run on every change; weekly Dependabot checks; `npm audit` in CI |
| Memory leaks | **Fixed** | One small cache (push timing) was never emptied |
| Logging, structured logging, audit logs, tracing, error tracking | Not used, by design | Logs would record who uses Raazdar; the server keeps none |
| Backups, disaster recovery | Partly | No user data on the server to back up. **To do:** keep an encrypted offline copy of the .onion key, or turn on DigitalOcean backups (disk only, holds no user data) |
| Cost monitoring | Owner action | Set a DigitalOcean billing alert |
| Two-factor authentication | Owner action | For GitHub, DigitalOcean, Hostinger and email (users have no passwords to protect) |
| Load testing, scaling, load balancing, stateless services, read replicas | Planned | One server handles current use; the connection cap is tested (W08). Scaling plan when users grow |
| Staging environment, feature flags, code review, branching, API docs, accessibility audit | Planned | Changes are tested on a local copy today; a small staging server and an accessibility review are next |
| Databases (indexing, migrations, normalization, pooling, SQL injection, row-level security, soft deletes) | Not applicable | No database. Deletes are real deletes, on purpose |
| Passwords, password reset, magic links, passkeys, SSO, API keys, cookies, token refresh | Not applicable | No accounts with passwords, no cookies, no third-party sign-in |
| CDNs, API gateways, message brokers, webhooks | Not applicable | A CDN would see users' IP addresses; not used on purpose |
| Data privacy | Done | DPDP Act notice, consent and erase; GDPR-style rights offered to everyone |
