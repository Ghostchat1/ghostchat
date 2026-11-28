# Raazdar Plus & Work: B2B research, gap check and how it works (v7.0, 28 Nov 2026)

Prepared for Mohit Sharma, Hyperviz Labs.

## 1. What businesses expect from a private messenger

Sources: Threema Work (management cockpit, MDM, app configuration), Wire Enterprise (guest rooms, legal hold, RBAC/SCIM, policy enforcement), AWS Wickr (compliance retention), legal-sector guides (NetSfere, Bitdefender, FindLaw), and India's DPDP Act 2023 with the DPDP Rules 2025 (main obligations from 13 May 2027).

| # | B2B need | Who asks for it | Raazdar 7.0 |
|---|---|---|---|
| 1 | End-to-end encryption by default, files, voice, video | Everyone | ✅ (post-quantum, sealed sender) |
| 2 | Admin console: add and remove staff | Every buyer | ✅ Work console in the app |
| 3 | Access stops when someone leaves | HR, IT | ✅ Seat revoked on the server, directory updated |
| 4 | Remote wipe of a lost phone | IT, law firms | ✅ Only with the colleague's consent at join |
| 5 | Policies: disappearing messages, no forwarding, no saving | Law, health, finance | ✅ Office rules |
| 6 | Verified internal contacts / outsider warning (CEO-fraud defence) | Finance, accounts | ✅ 🏢 badge + "External" label and warning |
| 7 | Broadcast to all staff | Ops, HR | ✅ Announcement channel, auto-maintained |
| 8 | No phone number / address-book access | Privacy-sensitive orgs | ✅ Built in |
| 9 | Desktop app | Offices | ✅ Windows, Mac, Linux |
| 10 | Usage statistics (anonymised) | Admins | ✅ Seat usage in the Work console; server counts in the owner panel |
| 11 | Invoices / GST | Finance | ⚙️ Manual for now (from the payment provider) |
| 12 | Self-hosting / data in India | Banks, hospitals, government | ✅ Deploy scripts + AGPL; commercial licence offered |
| 13 | Group calls | Teams | ❌ Roadmap (1-to-1 calls only today) |
| 14 | Several admins, roles | Larger orgs | ❌ Roadmap (one admin per organisation) |
| 15 | MDM / SSO / SCIM / Active Directory | Enterprises | ❌ Roadmap, only for big contracts |
| 16 | Legal hold / compliance archive | Banks, regulated firms | ❌ Deliberately not built: it breaks the "nobody can read it" promise. Offer chat export (per user) instead |
| 17 | Guest access for clients without an account | Law firms | ⚠️ Clients install the free app (no phone number needed); no web guest rooms yet |

## 2. Plans

| | Free | ✦ Plus | 🏢 Work |
|---|---|---|---|
| Price (suggested) | ₹0 | ₹79/month, ₹699/year | ₹249 per colleague/month, ₹2,399/year |
| Files | 25 MB, 200 MB/day | 64 MB, 1 GB/day | as Plus |
| Group size | 32 | 256 | 256 |
| Pinned chats | 3 | Unlimited | Unlimited |
| Export a chat (.txt) | — | ✓ | ✓ (unless office rules forbid it) |
| Announcement channels | — | ✓ | ✓ + organisation channel |
| App colours | Gold | 5 colours | 5 colours |
| Organisation console, rules, External label, remote erase | — | — | ✓ |
| All security features | ✓ | ✓ | ✓ |

Principle: **safety is never paywalled.** Free users keep everything they had before 7.0 (the 25 MB file limit was not reduced).

## 3. How payment stays anonymous

1. The owner makes **voucher codes** in the owner panel (`https://raazdar.app/admin`).
2. A buyer pays (UPI, Razorpay link, bank transfer) and receives a code such as `RZD-TSRA-ZP93-TPHN-02HN-01SC-0MD9`.
3. In the app: You → Raazdar Plus → type the code → Redeem.
4. The server checks the code's HMAC, marks its serial number as used and returns a **pass** signed with the server's P-384 key: `{id, tier, expiry, seats, org key}`.
5. The pass lives only in the user's encrypted vault and is shown to the server on each connection. The server keeps **no table of who pays**. After a reboot it simply re-checks passes.

What is stored on the server's disk (in `/var/lib/raazdar`): the signing key, the voucher HMAC key, the used serial numbers, removed-seat numbers (random), counters, the notice text and the owner-panel key. No IDs, no names, no payments.

Codes look random: the payload is scrambled with a key derived from its tag, so a buyer can't see how many codes have been sold.

## 4. How Work functions

- The admin redeems a Work code. The app creates an **organisation key** (P-384), and the server binds it to the pass together with the seat count.
- To add a colleague, the admin's app signs a **seat certificate** `{org, colleague ID, seat number, random certificate id, expiry}` and sends it, end-to-end encrypted, as an invite.
- The colleague sees the rules and an "allow remote erase" tick box, then joins or declines.
- Each phone presents its seat certificate. The server verifies the chain (server → org key → colleague), the seat number, expiry and revocation, then gives the phone Plus limits. It keeps "seat → ID" in RAM only, for 24 hours, so one seat can't be shared between several people.
- To remove a colleague, the admin's app sends `revoke` (the random certificate id) to the server and an encrypted "remove" to the colleague.
- Office rules, the directory and the announcement channel travel inside normal end-to-end encrypted messages. Members accept organisation commands only from their admin's authenticated ID.
- The admin can never read colleagues' chats.

Honest limitations:
- The app is open source (AGPL), so a determined user could unlock client-side extras such as colours or export in a modified build. Server-side limits (file size, daily volume) can't be bypassed.
- Office rules are enforced by colleagues' apps. A colleague with a modified app could ignore them.
- Remote erase works when the lost phone next opens Raazdar online.

## 5. Owner panel (`/admin`)

- **Sign in** with the admin key. After updating, it is printed in the console, or you can run `cat /var/lib/raazdar/admin.key`. After 8 wrong keys the panel locks for 15 minutes.
- **Stats:** registered IDs (RAM), online, Plus and Work online, codes made and used, files and messages waiting, memory, CPU, uptime, calls relay status.
- **Make codes:** Plus or Work, 1–24 months, seats, up to 200 at a time. Copy them, or download as CSV. **Codes are shown once.**
- **Check / cancel a code:** for support and refunds.
- **Notice to all users:** a short dismissible banner under "Chats".

## 6. Selling: practical next steps

1. Create a Razorpay Payment Page (or use a UPI QR code) for Plus monthly, Plus yearly and Work. Put its link in `public/site/config.json` → `PAY_URL`; for now it is an email link.
2. After each payment, make a code in the owner panel and send it to the buyer by email or Instagram DM.
3. Later, a Razorpay webhook can issue codes automatically (needs a Razorpay account and secret).
4. Pilot Work with 3–5 law firms or CA offices: offer a free month (a 1-month Work code), then charge annually.
