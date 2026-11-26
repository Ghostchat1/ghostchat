#!/usr/bin/env python3
"""Builds the static GhostChat website into public/site/. {{TOKENS}} are filled by the server from site/config.json."""
import os, html
OUT = "/home/claude/ghostchat/public/site"

I = {  # line icons
 "check": '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
 "x": '<path d="M6 6l12 12M18 6 6 18"/>',
 "id": '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16c.6-1.5 1.8-2.3 3.2-2.3s2.6.8 3.2 2.3M15 10h3M15 13.5h3"/>',
 "seal": '<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
 "atom": '<circle cx="12" cy="12" r="1.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/>',
 "key": '<circle cx="8" cy="15" r="4.5"/><path d="m11.2 11.8 8.3-8.3M16 7l2.5 2.5M14 9l2 2"/>',
 "timer": '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/>',
 "siren": '<path d="M7 18v-6a5 5 0 0 1 10 0v6M5 18h14v3H5zM12 3v2M4.5 6l1.4 1.4M19.5 6l-1.4 1.4"/>',
 "ghost": '<path d="M12 3a7 7 0 0 0-7 7v10l2.3-1.8L9.7 20l2.3-1.8 2.3 1.8 2.4-1.8L19 20V10a7 7 0 0 0-7-7z"/><circle cx="9.5" cy="10.5" r=".8"/><circle cx="14.5" cy="10.5" r=".8"/>',
 "mic": '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
 "save": '<path d="M12 3v12M7 10l5 5 5-5M4 19h16"/>',
 "onion": '<path d="M12 3c-1 3-6 6-6 11a6 6 0 0 0 12 0c0-5-5-8-6-11z"/><path d="M12 9c-1 2-3 3.5-3 6a3 3 0 0 0 6 0c0-2.5-2-4-3-6z"/>',
 "server": '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
 "lock": '<path d="M7 10V7a5 5 0 0 1 10 0v3"/><rect x="4.5" y="10" width="15" height="11" rx="2.5"/>',
 "eye": '<path d="M3 3l18 18M10.6 6.2A9.8 9.8 0 0 1 12 6c5 0 8.5 4.2 9.5 6-.5.9-1.6 2.5-3.3 3.8M6.4 7.6C4.6 8.9 3.3 10.7 2.5 12c1 1.8 4.5 6 9.5 6 1.4 0 2.7-.3 3.8-.8"/>',
 "users": '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18.2 14.8c1.9.8 3 2.5 3.3 5.2"/>',
 "qr": '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.2"/><path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18z"/>',
 "chat": '<path d="M4 18.5V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8.5z"/>',
 "shield": '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
 "phone": '<rect x="6.5" y="2.5" width="11" height="19" rx="3"/><path d="M10.5 18.5h3"/>',
 "apple": '<path d="M16.5 13.2c0-2.6 2.1-3.8 2.2-3.9a4.8 4.8 0 0 0-3.8-2c-1.6-.2-3.1.9-3.9.9s-2-.9-3.4-.9a5 5 0 0 0-4.2 2.6c-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.5 1.3 0 1.8-.8 3.3-.8s2 .8 3.4.8 2.2-1.3 3-2.5a10 10 0 0 0 1.4-2.8 4.3 4.3 0 0 1-2.5-4.1zM14 5.3a4.4 4.4 0 0 0 1-3.3 4.6 4.6 0 0 0-3 1.6 4.2 4.2 0 0 0-1.1 3.1A3.8 3.8 0 0 0 14 5.3z"/>',
 "android": '<path d="M5 10h14v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM7.5 10a4.5 4.5 0 0 1 9 0M8 4.5l1.5 2M16 4.5l-1.5 2M2.5 11v5M21.5 11v5"/><circle cx="9.5" cy="8" r=".5"/><circle cx="14.5" cy="8" r=".5"/>',
 "desktop": '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
 "doc": '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
 "mail": '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
 "menu": '<path d="M4 7h16M4 12h16M4 17h16"/>',
 "arrow": '<path d="M5 12h14M13 6l6 6-6 6"/>',
 "noads": '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
 "code": '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
 "india": '<path d="M4 20h16M6 20V10M18 20V10M12 20V10M3 10l9-6 9 6"/>',
}
def ic(n, cls="i"): return f'<svg class="{cls}" viewBox="0 0 24 24">{I[n]}</svg>'

NAV = [("/features", "Features"), ("/security", "Security"), ("/download", "Download"), ("/faq", "FAQ")]

def page(path, title, desc, body, active=""):
    nav = "".join(f'<a href="{h}"{" class=\"on\"" if h == active else ""}>{t}</a>' for h, t in NAV)
    mnav = "".join(f'<a href="{h}">{t}</a>' for h, t in NAV) + '<a href="/privacy">Privacy</a><a href="/contact">Contact</a>'
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(desc)}" />
<meta name="theme-color" content="#09090a" />
<meta name="referrer" content="no-referrer" />
<meta property="og:title" content="{html.escape(title)}" />
<meta property="og:description" content="{html.escape(desc)}" />
<meta property="og:image" content="/site/img/og.png" />
<link rel="icon" href="/icon.svg" />
<link rel="apple-touch-icon" href="/icon-180.png" />
<link rel="stylesheet" href="/site/site.css" />
<script src="/site/site.js"></script>
</head>
<body>
<header class="hdr">
  <div class="wrap">
    <a class="brand" href="/"><img src="/icon.svg" alt="" />GhostChat</a>
    <nav class="nav">{nav}</nav>
    <div class="hdr-cta"><a class="btn ghost sm" href="/signin">Sign in</a><a class="btn gold sm" href="/signin" data-open>Open GhostChat</a></div>
    <button class="burger" id="burger" aria-label="Menu" aria-expanded="false">{ic("menu")}</button>
  </div>
</header>
<div class="mnav" id="mnav">{mnav}<a class="btn gold" href="/signin" data-open>Open GhostChat</a></div>
<main>
{body}
</main>
<footer class="ftr">
  <div class="wrap">
    <div class="cols">
      <div><a class="brand" href="/"><img src="/icon.svg" alt="" />GhostChat</a><p>Private messaging with no phone number, no email and no name. Built in India for the Digital Personal Data Protection Act, 2023.</p></div>
      <div><h5>Product</h5><a href="/features">Features</a><a href="/security">Security</a><a href="/download">Download</a><a href="/signin">Open GhostChat</a></div>
      <div><h5>Help</h5><a href="/faq">FAQ</a><a href="/contact">Contact &amp; grievances</a><a href="/download#tor">Tor (.onion) access</a></div>
      <div><h5>Legal</h5><a href="/privacy">Privacy notice</a><a href="/terms">Terms of use</a><a href="/contact#grievance">Grievance officer</a></div>
    </div>
    <div class="bottom"><span>© 2026 {{{{COMPANY}}}}. All rights reserved.</span><span>No cookies · No trackers · No ads</span></div>
  </div>
</footer>
</body>
</html>
'''

def write(name, content):
    with open(os.path.join(OUT, name), "w") as f: f.write(content)

# ------------------------------------------------------------------ HOME
FEATS = [
 ("id", "No phone, no email", "Sign up with nothing. You get a random 16-character ID that isn't linked to you in any way."),
 ("seal", "Sealed sender", "Every message travels in an anonymous envelope. Even our server can't tell who sent it."),
 ("atom", "Post-quantum encryption", "Hybrid ML-KEM-768 and P-384, so messages recorded today stay locked against tomorrow's quantum computers."),
 ("key", "A new key for every message", "A Signal-style double ratchet changes keys with each message. One leaked key unlocks nothing else."),
 ("timer", "Disappearing & view-once", "Messages that erase themselves on both phones, and photos that vanish after one look."),
 ("siren", "Panic button", "Hold the lock for two seconds, or type a duress passcode, and every trace is gone. Your contacts' copies too."),
 ("ghost", "Disguise & decoy", "Make it look like a working calculator, or open a harmless decoy account under pressure."),
 ("mic", "Voice, photos & files", "Voice notes, documents, groups, replies and reactions, all end-to-end encrypted. Photos are stripped of location data."),
]
def feat_cards(items, cls="g4"):
    return f'<div class="grid {cls}">' + "".join(f'<div class="card rv"><div class="ico">{ic(i)}</div><h3>{t}</h3><p>{d}</p></div>' for i, t, d in items) + "</div>"

CMP = [
 ("Phone number or email required", False, True),
 ("Server can see who messages whom", False, True),
 ("Post-quantum encryption", True, None),
 ("Panic wipe & duress passcode", True, False),
 ("Calculator disguise & decoy account", True, False),
 ("Works over Tor (.onion)", True, False),
 ("Ads, trackers or analytics", False, None),
]
def cell(v, desired, us=False):
    cls = "us " if us else ""
    if v is None: return f'<td class="{cls}muted">Varies</td>'
    good = v == desired
    return f'<td class="{cls}{"yes" if good else "no"}">{ic("check" if good else "x")} {"Yes" if v else "No"}</td>'
def cmp_table():
    rows = ""
    for label, us, them in CMP:
        rows += f'<tr><td>{label}</td>{cell(us, us, True)}{cell(them, us)}</tr>'
    return f'<div class="tbl-wrap rv"><table class="cmp"><thead><tr><th></th><th class="us">GhostChat</th><th>Typical messengers</th></tr></thead><tbody>{rows}</tbody></table></div>'

FAQ = [
 ("Do I really not need a phone number?", "<p>Yes. GhostChat never asks for a phone number, email, name or contacts. When you sign up, your phone creates a random ID and a set of encryption keys. That ID is all anyone, including us, ever sees.</p>"),
 ("Can GhostChat read my messages?", "<p>No. Messages are encrypted on your phone and can only be decrypted on the recipient's phone. Our server only ever holds sealed envelopes it cannot open, and it deletes them once they're delivered (or after 7 days).</p>"),
 ("What happens if I forget my passcode?", "<p>Nobody can recover it, not even us. That's the price of real privacy. Keep an <b>encrypted backup</b> (You → Encrypted backup) somewhere safe; you can restore it with your passcode on any device.</p>"),
 ("Is it free?", "<p>Yes. GhostChat has no ads and does not sell or share data. There's nothing to sell.</p>"),
 ("How is this different from other private messengers?", "<p>Most private messengers still tie your account to a phone number. GhostChat doesn't, hides the sender from the server (sealed sender), uses post-quantum encryption, and adds protection for people at risk: a panic wipe, duress passcode, auto-erase, calculator disguise and a decoy account.</p>"),
 ("Does it work on iPhone and Android?", "<p>Yes. On iPhone, open GhostChat in Safari and add it to your Home Screen. On Android, install the app or use the browser. It also works on any computer. See <a href=\"/download\">Download</a>.</p>"),
 ("What does the panic button do?", "<p>Holding the lock button for two seconds (or typing your duress passcode) erases your keys, chats and settings from the device instantly, and can tell your contacts' apps to erase your conversations too. It cannot be undone.</p>"),
 ("Who can see that I use GhostChat?", "<p>On the normal web address, your internet provider can see you connect to quietline.chat (not what you send). For maximum anonymity use our Tor address, which hides your IP address from everyone, including us. See <a href=\"/security\">Security</a>.</p>"),
 ("Is GhostChat legal to use in India?", "<p>Yes. Private, encrypted communication is lawful. Using GhostChat for anything illegal is not, and is prohibited by our <a href=\"/terms\">Terms</a>. We follow the Digital Personal Data Protection Act, 2023 and the IT Act, 2000.</p>"),
 ("How do I delete my account?", "<p>Open GhostChat → You → Privacy &amp; your data → <b>Withdraw consent &amp; erase account</b>. Your keys and chats are wiped from the device, your ID is removed from our server, and your contacts' copies can be erased as well.</p>"),
]
def faq_html(items): return '<div class="faq">' + "".join(f"<details class=\"rv\"><summary>{q}</summary>{a}</details>" for q, a in items) + "</div>"

home = f'''
<section class="hero">
  <div class="wrap">
    <div>
      <span class="eyebrow"><i></i>Post-quantum · Sealed sender · No phone number</span>
      <h1>Talk freely.<br><span class="gold-text">Leave no trace.</span></h1>
      <p class="lead">GhostChat is a private messenger that needs no phone number, no email and no name. Every message is end-to-end encrypted, and even our own server can't see who sent it.</p>
      <div class="cta-row"><a class="btn gold" href="/signin" data-open>Get started, it's free {ic("arrow")}</a><a class="btn ghost" href="#how">How it works</a></div>
      <div class="trust"><span>{ic("check")}No phone or email</span><span>{ic("check")}No ads or trackers</span><span>{ic("check")}iPhone, Android &amp; desktop</span></div>
    </div>
    <div class="phones">
      <div class="phone p1"><img src="/site/img/shot-chat.webp" alt="A GhostChat conversation with a reply, a reaction, a PDF and a voice note" /></div>
      <div class="phone p2"><img src="/site/img/shot-list.webp" alt="The GhostChat chat list" /></div>
    </div>
  </div>
</section>

<section class="s">
  <div class="wrap">
    <div class="s-head rv"><span class="eyebrow">Built differently</span><h2>Private by design.<br>Not by promise.</h2><p>Most apps ask you to trust them with your data. GhostChat is built so there's nothing to trust us with.</p></div>
    <div class="grid g3 big3">
      <div class="card rv"><div class="ico">{ic("id")}</div><h3>We don't know who you are</h3><p>No phone number, email, name, contacts or location. Your identity is a random ID your phone creates.</p></div>
      <div class="card rv"><div class="ico">{ic("server")}</div><h3>Our server knows almost nothing</h3><p>It can't read your messages or see who sent them. It runs in memory only and deletes envelopes after delivery.</p></div>
      <div class="card rv"><div class="ico">{ic("key")}</div><h3>Only you hold the keys</h3><p>Keys are made and kept on your device, locked by your passcode. There's no copy anywhere else.</p></div>
    </div>
  </div>
</section>

<section class="s alt">
  <div class="wrap">
    <div class="s-head rv"><span class="eyebrow">Features</span><h2>Everything you expect.<br><span class="gold-text">Plus what others won't build.</span></h2><p>A complete messenger, with protections designed for people who can't afford a leak.</p></div>
    {feat_cards(FEATS)}
    <p class="center rv" style=""><a class="btn ghost" href="/features">Explore all features {ic("arrow")}</a></p>
  </div>
</section>

<section class="s" id="how">
  <div class="wrap">
    <div class="s-head rv"><span class="eyebrow">How it works</span><h2>Private in under a minute.</h2><p>No forms, no verification codes, no waiting.</p></div>
    <div class="grid g3 steps">
      <div class="card step rv"><h3>Create your anonymous ID</h3><p>Pick a passcode. Your phone generates your ID and encryption keys in seconds. Nothing personal is asked.</p></div>
      <div class="card step rv"><h3>Share your QR code</h3><p>Let someone scan your code or send them your invite link. Only people you give it to can find you.</p></div>
      <div class="card step rv"><h3>Talk without a trace</h3><p>Chat, call it a day, and let messages disappear. If you ever need to, one long press erases everything.</p></div>
    </div>
  </div>
</section>

<section class="s alt">
  <div class="wrap">
    <div class="s-head rv"><span class="eyebrow">Compare</span><h2>What sets GhostChat apart</h2><p>How GhostChat compares with the messaging apps most people use every day.</p></div>
    {cmp_table()}
    <p class="small muted center">“Typical messengers” describes common mainstream apps; features vary between apps and versions.</p>
  </div>
</section>

<section class="s">
  <div class="wrap">
    <div class="band rv">
      <div>
        <span class="eyebrow">Security centre</span>
        <h2>See exactly how protected you are.</h2>
        <p>GhostChat scores your setup and shows what's left: a backup, a duress passcode, auto-erase, remote erase. One tap fixes each.</p>
        <p><a class="btn ghost" href="/security">How our security works {ic("arrow")}</a></p>
      </div>
      <div class="shot"><div class="phone"><img src="/site/img/shot-security.webp" alt="GhostChat security centre with a protection score" /></div></div>
    </div>
    <div class="stats">
      <div class="stat rv"><b class="gold-text">0</b><span>phone numbers stored</span></div>
      <div class="stat rv"><b class="gold-text">768</b><span>ML-KEM security level</span></div>
      <div class="stat rv"><b class="gold-text">1</b><span>key per message</span></div>
      <div class="stat rv"><b class="gold-text">2s</b><span>to erase everything</span></div>
    </div>
  </div>
</section>

<section class="s alt">
  <div class="wrap">
    <div class="s-head rv"><span class="eyebrow">Questions</span><h2>Good questions, honest answers</h2></div>
    {faq_html(FAQ[:5])}
    <p class="center"><a class="btn ghost" href="/faq">All questions {ic("arrow")}</a></p>
  </div>
</section>

<section class="final">
  <div class="wrap">
    <img src="/icon.svg" alt="" />
    <h2>Your conversations are yours.<br><span class="gold-text">Keep them that way.</span></h2>
    <p>Free. No phone number. Ready in under a minute.</p>
    <div class="cta-row" style=""><a class="btn gold" href="/signin" data-open>Open GhostChat {ic("arrow")}</a><a class="btn ghost" href="/download">Get the app</a></div>
  </div>
</section>
'''
home = home.replace(' style=""', "")
write("index.html", page("/", "GhostChat: private messaging with no phone number", "Anonymous, end-to-end encrypted messaging. No phone number, no email, no name. Post-quantum encryption, sealed sender, panic wipe.", home))

# ------------------------------------------------------------------ FEATURES
def split(eyebrow, title, text, bullets, img, alt, rev=False):
    lis = "".join(f"<li>{ic('check')}<span>{b}</span></li>" for b in bullets)
    return f'''<div class="split{' rev' if rev else ''}"><div class="rv"><span class="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{text}</p><ul>{lis}</ul></div>
<div class="shot rv"><div class="phone"><img src="/site/img/{img}" alt="{alt}" /></div></div></div>'''
features = f'''
<section class="phead"><div class="wrap"><span class="eyebrow">Features</span><h1>A complete messenger.<br><span class="gold-text">Built to forget.</span></h1><p>Everything you use every day, rebuilt so that nothing about you is collected, kept or exposed.</p></div></section>
<section class="s"><div class="wrap">
{split("Messaging", "Everything you'd expect. Nothing you'd regret.", "Rich, fast messaging, with every message, photo, file and voice note end-to-end encrypted before it leaves your phone.",
 ["Replies, reactions and starred messages", "Voice messages and documents up to 2&nbsp;MB", "Photos cleaned of location, camera and time data", "Groups where the server can't even tell a group exists", "Search, pin and filter chats"], "shot-chat.webp", "A GhostChat conversation")}
{split("Identity", "Your identity is a random ID. Nothing more.", "No phone number, no email, no contact upload. Share your QR code or invite link only with people you choose.",
 ["16-character random ID made on your device", "A unique pattern avatar instead of a photo", "Safety numbers to verify a contact in person", "Nickname optional, seen only inside encrypted messages"], "shot-you.webp", "GhostChat profile page with an anonymous ID", True)}
{split("Protection", "Built for the moment things go wrong.", "Designed with journalists, lawyers and anyone under pressure in mind.",
 ["Panic: hold the lock two seconds to erase everything", "Duress passcode that silently wipes instead of unlocking", "Auto-erase if the app isn't opened for days", "Remote erase of your chats from contacts' phones", "Calculator disguise and a believable decoy account", "Disappearing messages and view-once photos"], "shot-security.webp", "GhostChat security centre")}
</div></section>
<section class="s alt"><div class="wrap">
<div class="s-head rv"><span class="eyebrow">And more</span><h2>The details that matter</h2></div>
{feat_cards([
 ("save", "Encrypted backup", "Move to a new phone with one backup and your passcode. The backup is useless to anyone else."),
 ("onion", "Tor hidden service", "Use our .onion address to hide your IP address from everyone, including us."),
 ("lock", "Locked vault", "Everything on your device is encrypted with your passcode. Ten wrong tries and it erases itself."),
 ("noads", "No ads, no analytics", "No trackers, no cookies, no third-party code. The website and app contain none."),
 ("users", "Private groups", "Every member gets a separately encrypted copy, so the server never sees a group."),
 ("qr", "QR invites", "Add someone by scanning their code. No directory, no search, no way to be found by strangers."),
 ("phone", "Works everywhere", "iPhone, Android and any computer browser. Install it on your home screen like an app."),
 ("india", "Built for India's DPDP Act", "Clear notice, real consent, your rights honoured, and a named grievance officer."),
])}
</div></section>
<section class="final"><div class="wrap"><h2>Try it in under a minute.</h2><p>No sign-up form. No phone number. Free.</p><a class="btn gold" href="/signin" data-open>Open GhostChat {ic("arrow")}</a></div></section>
'''
write("features.html", page("/features", "Features | GhostChat", "Voice, files, groups, disappearing messages, panic wipe, duress passcode, decoy account and more, with no phone number.", features, "/features"))

# ------------------------------------------------------------------ SECURITY
security = f'''
<section class="phead"><div class="wrap"><span class="eyebrow">Security</span><h1>How GhostChat<br><span class="gold-text">keeps you invisible</span></h1><p>A plain-language tour of what protects you, and an honest list of what can't.</p></div></section>
<section class="s"><div class="wrap">
{feat_cards([
 ("atom", "Hybrid post-quantum key exchange", "Each conversation starts with ML-KEM-768 (the NIST post-quantum standard) combined with P-384 elliptic-curve Diffie-Hellman. An attacker would have to break both."),
 ("key", "Double ratchet", "Like Signal, keys move forward with every message and old keys are destroyed, giving forward secrecy and recovery after compromise."),
 ("seal", "Sealed sender", "The outer envelope is encrypted to the recipient with a fresh one-time key. The server sees only the destination, never the sender."),
 ("lock", "AES-256-GCM everywhere", "Messages, files, voice notes and your on-device vault are encrypted with authenticated AES-256."),
 ("server", "Memory-only server", "Our relay keeps nothing on disk. Undelivered envelopes are deleted after 7 days; delivered ones immediately."),
 ("eye", "Traffic padding & cover noise", "Messages are padded to fixed sizes and your app sends random dummy traffic, so activity is hard to infer."),
 ("shield", "Signed, rotating prekeys", "Prekeys are signed by your identity key and rotate daily, so a server can't swap in its own keys unnoticed. Compare safety numbers to be sure."),
 ("onion", "Tor onion service", "Connect through Tor and no one, not your ISP and not us, learns your IP address."),
 ("code", "Tested & public", "Our code is public on GitHub and has been through our own OWASP-style security testing (VAPT). An independent audit is planned."),
], "g3")}
</div></section>
<section class="s alt"><div class="wrap">
<div class="s-head rv"><span class="eyebrow">What the server sees</span><h2>Almost nothing.</h2><p>Here is everything that passes through our server, and what it can learn.</p></div>
<div class="tbl-wrap rv"><table class="cmp"><thead><tr><th>Item</th><th class="us">Can the server read it?</th><th>Kept for</th></tr></thead><tbody>
<tr><td>Message text, photos, files, voice</td><td class="us">{ic("x")} No, end-to-end encrypted</td><td>Until delivered, max 7 days</td></tr>
<tr><td>Who sent a message</td><td class="us">{ic("x")} No, sealed sender</td><td>Never known</td></tr>
<tr><td>Your nickname</td><td class="us">{ic("x")} No, inside encrypted messages</td><td>Never stored</td></tr>
<tr><td>Your anonymous ID &amp; public keys</td><td class="us">{ic("check")} Yes, needed to deliver to you</td><td>While your account exists (memory only)</td></tr>
<tr><td>Your IP address</td><td class="us">Briefly, to keep the connection open. Hidden entirely over Tor</td><td>Not logged</td></tr>
</tbody></table></div>
</div></section>
<section class="s"><div class="wrap prose" style="padding-bottom:0">
<h2>Honest limits</h2>
<p>No tool makes you invisible on its own. GhostChat can't protect you if:</p>
<ul>
<li><b>Your device is compromised.</b> Spyware on your phone can read the screen. Keep your phone updated and locked.</li>
<li><b>Someone knows your passcode.</b> Use a few random words, and set a duress passcode for emergencies.</li>
<li><b>The other person shares your messages.</b> They can photograph their screen. Use disappearing messages and view-once photos.</li>
<li><b>You use the normal web address and need to hide your IP.</b> The fast address shows your IP to our hosting provider. For full anonymity use the <a href="/download#tor">Tor address</a>.</li>
<li><b>You use the web version.</b> The web app is downloaded from our server each time; the Android app bundles its code instead. High-risk users should prefer the app.</li>
</ul>
<p>Found a vulnerability? Please tell us privately at <a href="mailto:{{{{EMAIL}}}}">{{{{EMAIL}}}}</a>. We respond to every report.</p>
</div></section>
<section class="final"><div class="wrap"><h2>Privacy you can verify.</h2><p>Compare safety numbers with a contact and see it for yourself.</p><a class="btn gold" href="/signin" data-open>Open GhostChat {ic("arrow")}</a></div></section>
'''.replace(' style="padding-bottom:0"', "")
write("security.html", page("/security", "Security | GhostChat", "Post-quantum encryption, double ratchet, sealed sender, memory-only server and Tor. How GhostChat protects you, and its honest limits.", security, "/security"))

# ------------------------------------------------------------------ DOWNLOAD
download = f'''
<section class="phead"><div class="wrap"><span class="eyebrow">Download</span><h1>Get GhostChat<br><span class="gold-text">on every device</span></h1><p>No app store account needed. Nothing to sign up for.</p></div></section>
<section class="s"><div class="wrap">
<div class="grid g2 dl">
  <div class="card rv"><div class="ico">{ic("apple")}</div><h3>iPhone &amp; iPad</h3><p>Install GhostChat to your Home Screen straight from Safari. It opens full-screen like any app.</p>
    <ol><li>Open <b>quietline.chat</b> in <b>Safari</b> and tap <b>Open GhostChat</b>.</li><li>Tap the <b>Share</b> button (square with an arrow).</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>
    <a class="btn gold" href="/signin" data-open>Open in Safari {ic("arrow")}</a></div>
  <div class="card rv"><div class="ico">{ic("android")}</div><h3>Android</h3><p>Install the app directly. Its code is bundled inside, it blocks screenshots, and it can work over Bluetooth without internet.</p>
    <ol><li>Tap <b>Download APK</b> below.</li><li>Open the file. If asked, allow <b>Install unknown apps</b> for your browser.</li><li>Open GhostChat and create your ID.</li></ol>
    <a class="btn gold" href="https://github.com/Ghostchat1/ghostchat/releases/latest/download/GhostChat.apk" rel="noopener">Download APK {ic("save")}</a></div>
  <div class="card rv"><div class="ico">{ic("desktop")}</div><h3>Computer</h3><p>Works in any modern browser on Windows, Mac or Linux. In Chrome or Edge you can install it as an app from the address bar.</p>
    <a class="btn ghost" href="/signin" data-open>Open in your browser {ic("arrow")}</a></div>
  <div class="card rv" id="tor"><div class="ico">{ic("onion")}</div><h3>Tor (maximum anonymity)</h3><p>Hide your IP address from everyone, including us. Use <b>Tor Browser</b> on a computer or <b>Onion Browser</b> on iPhone, and open:</p>
    <p><code>{{{{ONION}}}}</code></p><p class="small muted">Accounts on the Tor address and the normal address are separate.</p></div>
</div>
</div></section>
'''
write("download.html", page("/download", "Download | GhostChat", "Install GhostChat on iPhone, Android or your computer, or use it over Tor.", download, "/download"))

# ------------------------------------------------------------------ FAQ
faq = f'''
<section class="phead"><div class="wrap"><span class="eyebrow">FAQ</span><h1>Questions &amp; answers</h1><p>Can't find what you need? <a href="/contact">Contact us</a>.</p></div></section>
<section class="s"><div class="wrap">{faq_html(FAQ)}</div></section>
'''
write("faq.html", page("/faq", "FAQ | GhostChat", "Answers about GhostChat: no phone number, encryption, backups, panic wipe, iPhone and Android, DPDP rights.", faq, "/faq"))

# ------------------------------------------------------------------ PRIVACY (DPDP)
DATA_ROWS = [
 ("Anonymous ID and public encryption keys", "To route messages to you and let contacts verify you", "Our server (memory only)", "While your account exists; removed when you erase your account"),
 ("Encrypted message envelopes", "To deliver messages when the recipient is offline", "Our server (memory only)", "Deleted on delivery, or after 7 days"),
 ("Consent record (notice version and time)", "To show that you were given this notice and agreed (DPDP Act s.6(10))", "Your device and our server, linked to your anonymous ID", "While your account exists"),
 ("IP address (network connection)", "Technically necessary to keep a connection open; to block abuse", "Held in memory during the connection; <b>not logged</b>", "Not retained. Not visible to us at all over Tor"),
 ("Messages, contacts, nickname, settings", "To run the app on your device", "<b>Only your device</b>, encrypted with your passcode", "Until you delete them or erase the app"),
 ("Emails you send us", "To answer you or resolve a grievance", "Our email provider", "Up to 12 months after resolution, unless law requires longer"),
]
rows = "".join(f"<tr><td>{a}</td><td>{b}</td><td>{c}</td><td>{d}</td></tr>" for a, b, c, d in DATA_ROWS)
privacy = f'''
<section class="phead"><div class="wrap"><span class="eyebrow">Privacy notice</span><h1>Privacy notice</h1><p>Issued under the Digital Personal Data Protection Act, 2023 and the DPDP Rules, 2025.</p></div></section>
<div class="prose">
<p class="meta">Version {{{{NOTICE_V}}}} · Last updated {{{{UPDATED}}}} · Data Fiduciary: {{{{COMPANY}}}}, {{{{ADDRESS}}}}</p>
<div class="tldr"><h3>In plain words</h3>
<ul><li>We never ask for your name, phone number, email, contacts or location.</li>
<li>We can't read your messages. Only you and the people you message can.</li>
<li>Our server keeps only your anonymous ID, your public keys and sealed messages waiting to be delivered, in memory only.</li>
<li>You can withdraw consent and erase your account at any time, from inside the app.</li>
<li>No ads, no tracking, no selling or sharing of data.</li></ul></div>
<div class="toc"><b>Contents</b><ol>
<li><a href="#who">Who we are</a></li><li><a href="#data">Personal data we process and why</a></li><li><a href="#basis">Consent and legal basis</a></li>
<li><a href="#rights">Your rights</a></li><li><a href="#withdraw">Withdrawing consent and erasing your data</a></li><li><a href="#grievance">Grievances and the Data Protection Board</a></li>
<li><a href="#children">Children</a></li><li><a href="#security">Security and breaches</a></li><li><a href="#processors">Service providers and data location</a></li>
<li><a href="#cookies">Cookies and tracking</a></li><li><a href="#law">Requests from authorities</a></li><li><a href="#changes">Changes and languages</a></li></ol></div>

<h2 id="who">1. Who we are</h2>
<p>GhostChat is operated by <b>{{{{COMPANY}}}}</b>, {{{{ADDRESS}}}} (“we”, “us”). For your personal data we are the <b>Data Fiduciary</b> under the Digital Personal Data Protection Act, 2023 (“DPDP Act”). You are the <b>Data Principal</b>.</p>

<h2 id="data">2. Personal data we process and why</h2>
<p>GhostChat is designed to process as little personal data as possible. This is the complete list:</p>
<table><thead><tr><th>Data</th><th>Purpose</th><th>Where it is kept</th><th>How long</th></tr></thead><tbody>{rows}</tbody></table>
<p><b>We do not collect:</b> your name, phone number, email address (unless you write to us), address book, location, device identifiers, advertising IDs, analytics or browsing history. Message contents are end-to-end encrypted and cannot be read by us.</p>
<p>Your anonymous ID is random and is not linked to you by us. We still treat it, and your public keys, as personal data and protect them accordingly.</p>

<h2 id="basis">3. Consent and legal basis</h2>
<p>We process the data above on the basis of your <b>consent</b> (DPDP Act, section 6), which you give on the <a href="/signin">sign-in page</a> or in the app before an account is created. Your consent is limited to the purposes in section 2. We may also process data where the law permits without consent (DPDP Act, section 7), for example to comply with a court order or a legal obligation.</p>
<p>We keep a record of the version of this notice you agreed to and when, linked to your anonymous ID, so that we can demonstrate consent as the DPDP Act requires.</p>

<h2 id="rights">4. Your rights</h2>
<p>Under the DPDP Act you have the right to:</p>
<ul>
<li><b>Information</b> (section 11): a summary of the personal data we process about you and the processing activities.</li>
<li><b>Correction and erasure</b> (section 12): correct, complete, update or erase your personal data. Most of it lives only on your device, where you control it directly.</li>
<li><b>Grievance redressal</b> (section 13): a readily available way to raise a complaint with us.</li>
<li><b>Nomination</b> (section 14): nominate a person to exercise your rights in the event of your death or incapacity.</li>
<li><b>Withdraw consent</b> at any time, as easily as you gave it.</li>
</ul>
<p><b>How to exercise them:</b> email <a href="mailto:{{{{EMAIL}}}}">{{{{EMAIL}}}}</a> with your anonymous ID. Because we don't know who you are, we will ask you to prove that the ID is yours from inside the app before acting. We respond within a reasonable time, and in any case <b>within 90 days</b>, as the DPDP Rules, 2025 require.</p>

<h2 id="withdraw">5. Withdrawing consent and erasing your data</h2>
<p>Open GhostChat → <b>You</b> → <b>Privacy &amp; your data</b> → <b>Withdraw consent &amp; erase account</b>. This immediately erases your keys and chats from your device, removes your ID and keys from our server, deletes messages waiting for you, and (if you choose) asks your contacts' apps to erase your conversations. Withdrawal doesn't affect processing done before it. Without an account, the service can't be provided.</p>

<h2 id="grievance">6. Grievances and the Data Protection Board</h2>
<p>Contact our Grievance Officer, <b>{{{{GRIEVANCE_NAME}}}}</b>, at <a href="mailto:{{{{EMAIL}}}}">{{{{EMAIL}}}}</a> or {{{{ADDRESS}}}}. Details are also on our <a href="/contact">contact page</a>. We acknowledge complaints within 24 hours and aim to resolve them within 15 days (Information Technology Rules, 2021), and never later than 90 days (DPDP Rules, 2025).</p>
<p>If you are not satisfied with our response, you may complain to the <b>Data Protection Board of India</b> after using our grievance process (DPDP Act, section 13(3)).</p>

<h2 id="children">7. Children</h2>
<p>GhostChat is only for people aged <b>18 or older</b>. Everyone must confirm this before creating an account. We do not knowingly process children's personal data and do not carry out tracking, behavioural monitoring or targeted advertising of anyone. If you believe a child is using GhostChat, contact us and we will help erase the account.</p>

<h2 id="security">8. Security and breaches</h2>
<p>We protect personal data with reasonable security safeguards (DPDP Act, section 8(5)), including end-to-end and post-quantum encryption, sealed sender, a memory-only server, encrypted on-device storage, strict access controls and regular security testing. See <a href="/security">Security</a>.</p>
<p>If a personal data breach occurs, we will inform the Data Protection Board of India and affected users as the DPDP Rules require. Because we don't know who our users are, we will notify you inside the app and on this website.</p>

<h2 id="processors">9. Service providers and data location</h2>
<p>Our server is hosted by DigitalOcean in a data centre in Frankfurt, Germany, which processes data on our behalf as a Data Processor. Domain and TLS certificates are provided by our domain registrar and Let's Encrypt. Android app downloads are served by GitHub. We do not sell or share personal data with anyone for their own purposes. Transfers outside India are made in line with section 16 of the DPDP Act.</p>

<h2 id="cookies">10. Cookies and tracking</h2>
<p>We use <b>no cookies, analytics or trackers</b>, on the website or in the app. The app stores its encrypted data in your browser's or phone's local storage only so that it can work. That data never leaves your device unless you make a backup.</p>

<h2 id="law">11. Requests from authorities</h2>
<p>We comply with valid legal orders under Indian law. Because of how GhostChat is built, we hold very little: we cannot provide message contents, sender identities, contact lists or IP logs, because we do not have them.</p>

<h2 id="changes">12. Changes and languages</h2>
<p>If we change this notice in a way that affects how we process your data, we will update the version number and ask for your consent again in the app. This notice is available in English and Hindi (हिन्दी). To request it in another language listed in the Eighth Schedule to the Constitution, email us.</p>
<p class="note">The DPDP Act and DPDP Rules, 2025 are being brought into force in phases, with most obligations applying from May 2027. GhostChat already follows them.</p>
</div>
'''
write("privacy.html", page("/privacy", "Privacy notice | GhostChat", "GhostChat privacy notice under India's Digital Personal Data Protection Act, 2023: what we process, why, your rights and our grievance officer.", privacy))

# ------------------------------------------------------------------ TERMS
terms = f'''
<section class="phead"><div class="wrap"><span class="eyebrow">Terms</span><h1>Terms of use</h1><p>The rules for using GhostChat, in plain language.</p></div></section>
<div class="prose">
<p class="meta">Last updated {{{{UPDATED}}}} · Provider: {{{{COMPANY}}}}, {{{{ADDRESS}}}}</p>
<h2>1. Agreement</h2><p>By creating a GhostChat account you agree to these Terms and confirm you have read our <a href="/privacy">Privacy notice</a>. If you don't agree, don't use GhostChat.</p>
<h2>2. Who can use GhostChat</h2><p>You must be at least <b>18 years old</b> and legally able to enter into a contract under Indian law.</p>
<h2>3. Your account</h2><ul><li>Your account exists only on your device and is protected by your passcode. <b>We cannot recover a lost passcode or account.</b> Keep an encrypted backup.</li><li>You are responsible for keeping your device, passcode and backups safe.</li><li>Erasing your account (by panic, duress passcode, auto-erase or withdrawal of consent) is permanent.</li></ul>
<h2>4. Acceptable use</h2><p>You must not use GhostChat to host, share or transmit anything that is unlawful under Indian law, including content that:</p>
<ul><li>sexually exploits or abuses children, or is obscene or pornographic;</li><li>threatens the unity, integrity, defence, security or sovereignty of India, or incites violence or terrorism;</li><li>harasses, defames, threatens, impersonates or invades the privacy of another person;</li><li>promotes fraud, scams, money laundering, illegal gambling or trade in prohibited goods;</li><li>contains malware or is used to attack, spam or overload our service or anyone else's;</li><li>infringes another person's intellectual property.</li></ul>
<p>We cannot read messages, but we may suspend access for any ID that we reasonably believe violates these rules, for example based on a report with evidence or a lawful order.</p>
<h2>5. Reporting abuse</h2><p>If someone sends you unlawful content, you can delete the chat and block the ID by deleting the contact. To report it, email <a href="mailto:{{{{EMAIL}}}}">{{{{EMAIL}}}}</a> with the sender's ID and screenshots. We will act as required by the Information Technology Act, 2000 and the IT Rules, 2021.</p>
<h2>6. Our service</h2><p>GhostChat is provided free of charge, “as is” and “as available”. We work hard to keep it secure and available but can't guarantee it will be uninterrupted or error-free. We may change, suspend or discontinue features, with notice where reasonable.</p>
<h2>7. Limitation of liability</h2><p>To the extent permitted by law, we are not liable for indirect or consequential losses, or for loss of data, messages or accounts, including loss caused by a forgotten passcode or a deliberate erase. Nothing in these Terms limits liability that cannot be limited under Indian law.</p>
<h2>8. Intellectual property</h2><p>The GhostChat name, logo and design belong to {{{{COMPANY}}}}. Your messages belong to you.</p>
<h2>9. Governing law</h2><p>These Terms are governed by the laws of India. Courts at {{{{JURISDICTION}}}} have exclusive jurisdiction, subject to any mandatory consumer protection rights you have.</p>
<h2>10. Grievance Officer</h2><p>In accordance with the Information Technology Act, 2000, the IT Rules, 2021 and the DPDP Act, 2023, our Grievance Officer is <b>{{{{GRIEVANCE_NAME}}}}</b>, reachable at <a href="mailto:{{{{EMAIL}}}}">{{{{EMAIL}}}}</a>. See <a href="/contact">Contact</a>.</p>
<h2>11. Changes</h2><p>We may update these Terms. Material changes will be announced in the app and on this page before they take effect.</p>
</div>
'''
write("terms.html", page("/terms", "Terms of use | GhostChat", "The terms for using GhostChat: eligibility, acceptable use, your account and our grievance officer.", terms))

# ------------------------------------------------------------------ CONTACT
contact = f'''
<section class="phead"><div class="wrap"><span class="eyebrow">Contact</span><h1>Contact &amp; grievances</h1><p>Questions, privacy requests, security reports or complaints. A real person reads every message.</p></div></section>
<div class="wrap">
<div class="contact-card">
<div class="grid g3">
  <div class="card rv"><div class="ico">{ic("mail")}</div><h3>Privacy &amp; data requests</h3><p>Access, correction, erasure or nomination under the DPDP Act. Include your anonymous ID.</p></div>
  <div class="card rv"><div class="ico">{ic("shield")}</div><h3>Security reports</h3><p>Found a vulnerability? Tell us privately and we'll work with you to fix it.</p></div>
  <div class="card rv"><div class="ico">{ic("siren")}</div><h3>Report abuse</h3><p>Send the sender's ID and screenshots. We act under the IT Act, 2000 and IT Rules, 2021.</p></div>
</div>
<h2 class="center" id="grievance">Grievance Officer &amp; Data Protection contact</h2>
<div class="kv rv">
  <b>Name</b><span>{{{{GRIEVANCE_NAME}}}}</span>
  <b>Organisation</b><span>{{{{COMPANY}}}}</span>
  <b>Email</b><span><a href="mailto:{{{{EMAIL}}}}">{{{{EMAIL}}}}</a></span>
  <b>Address</b><span>{{{{ADDRESS}}}}</span>
  <b>Acknowledgement</b><span>Within 24 hours</span>
  <b>Resolution</b><span>Within 15 days (IT Rules, 2021); never more than 90 days (DPDP Rules, 2025)</span>
  <b>Escalation</b><span>If you're not satisfied, you may approach the Data Protection Board of India</span>
</div>
<p class="center small muted">Writing to us by email means we will see your email address. If you prefer to stay anonymous, use a new email address created just for this.</p>
</div></div>
'''
write("contact.html", page("/contact", "Contact & grievances | GhostChat", "Contact GhostChat: privacy requests, security reports, abuse reports and our Grievance Officer under the DPDP Act and IT Rules.", contact))

# ------------------------------------------------------------------ SIGN IN (DPDP consent)
notice_en = f'''<div data-lang="en">
<p>Before you use GhostChat, please read what personal data we process. This notice is separate from our other terms, as the DPDP Act, 2023 requires.</p>
<h4>What we process</h4>
<table><tr><th>Data</th><th>Why</th></tr>
<tr><td>Anonymous ID &amp; public keys</td><td>To deliver messages to you</td></tr>
<tr><td>Sealed messages awaiting delivery</td><td>Delivery while you're offline (deleted on delivery or after 7 days)</td></tr>
<tr><td>Record of this consent</td><td>To prove you agreed (DPDP Act s.6(10))</td></tr>
<tr><td>IP address (not logged)</td><td>Keeping your connection open</td></tr></table>
<h4>What we never collect</h4><p>Name, phone number, email, contacts, location, analytics or message contents. Messages are end-to-end encrypted.</p>
<h4>Your rights</h4><ul><li>Withdraw consent at any time: <b>You → Privacy &amp; your data → Withdraw consent &amp; erase account</b>.</li><li>Access, correct or erase your data, nominate someone, and raise a grievance, answered within 90 days.</li><li>Complain to the Data Protection Board of India.</li></ul>
<h4>Contact</h4><p>Grievance Officer: {{{{GRIEVANCE_NAME}}}}, <a href="mailto:{{{{EMAIL}}}}">{{{{EMAIL}}}}</a>. Full notice: <a href="/privacy" target="_blank" rel="noopener">Privacy notice</a>.</p></div>'''
notice_hi = f'''<div data-lang="hi" class="hidden">
<p>GhostChat का उपयोग करने से पहले, कृपया पढ़ें कि हम कौन-सा व्यक्तिगत डेटा संसाधित करते हैं। यह सूचना डिजिटल व्यक्तिगत डेटा संरक्षण अधिनियम, 2023 के अनुसार हमारी अन्य शर्तों से अलग है।</p>
<h4>हम क्या संसाधित करते हैं</h4>
<table><tr><th>डेटा</th><th>क्यों</th></tr>
<tr><td>गुमनाम ID और सार्वजनिक कुंजियाँ</td><td>आप तक संदेश पहुँचाने के लिए</td></tr>
<tr><td>डिलीवरी की प्रतीक्षा में सीलबंद संदेश</td><td>आपके ऑफ़लाइन रहने पर डिलीवरी (डिलीवरी पर या 7 दिन बाद हटाए जाते हैं)</td></tr>
<tr><td>इस सहमति का रिकॉर्ड</td><td>यह दिखाने के लिए कि आपने सहमति दी (धारा 6(10))</td></tr>
<tr><td>IP पता (लॉग नहीं किया जाता)</td><td>आपका कनेक्शन चालू रखने के लिए</td></tr></table>
<h4>हम कभी एकत्र नहीं करते</h4><p>नाम, फ़ोन नंबर, ईमेल, संपर्क, लोकेशन, एनालिटिक्स या संदेशों की सामग्री। संदेश एंड-टू-एंड एन्क्रिप्टेड हैं।</p>
<h4>आपके अधिकार</h4><ul><li>किसी भी समय सहमति वापस लें: <b>You → Privacy &amp; your data → Withdraw consent &amp; erase account</b>।</li><li>अपने डेटा की जानकारी, सुधार या मिटाने का अनुरोध, नामांकन और शिकायत — 90 दिनों के भीतर उत्तर।</li><li>भारतीय डेटा संरक्षण बोर्ड में शिकायत करने का अधिकार।</li></ul>
<h4>संपर्क</h4><p>शिकायत अधिकारी: {{{{GRIEVANCE_NAME}}}}, <a href="mailto:{{{{EMAIL}}}}">{{{{EMAIL}}}}</a>। पूरी सूचना: <a href="/privacy" target="_blank" rel="noopener">गोपनीयता सूचना</a>।</p></div>'''
signin = f'''
<div class="auth" id="auth">
  <aside class="auth-art">
    <span class="eyebrow"><i></i>End-to-end encrypted</span>
    <h1>Welcome to<br><span class="gold-text">GhostChat</span></h1>
    <p>No username. No password to send anywhere. Your account lives encrypted on your device, and you unlock it with your passcode.</p>
    <ul><li>{ic("check")}<span>No phone number or email, ever</span></li><li>{ic("check")}<span>Messages only you and your contact can read</span></li><li>{ic("check")}<span>Erase everything in two seconds</span></li></ul>
  </aside>
  <div class="auth-main">
    <div class="auth-box">
      <div class="tabs"><button data-m="new" class="on">New to GhostChat</button><button data-m="in">I have an account</button></div>
      <div id="t-new"><h2>Create your anonymous ID</h2><p>It takes under a minute. First, please review how we handle your data.</p></div>
      <div id="t-in" class="hidden"><h2>Sign in</h2><p>You'll unlock with your passcode on the next screen. On a new device, choose <b>Restore from encrypted backup</b> there.</p></div>
      <div id="consented" class="done hidden">✓ You gave consent on this device on <span id="c-when"></span>. <a href="#" id="c-withdraw">Withdraw</a></div>
      <div class="notice">
        <div class="notice-h"><b>Privacy notice<small>Version {{{{NOTICE_V}}}} · DPDP Act, 2023</small></b><div class="lang"><button data-l="en" class="on">English</button><button data-l="hi">हिन्दी</button></div></div>
        <div class="notice-b">{notice_en}{notice_hi}</div>
      </div>
      <div class="checks">
        <label class="chk"><input type="checkbox" id="c-notice" /><span>I have read the privacy notice and <b>consent</b> to the processing of the data listed above to use GhostChat.</span></label>
        <label class="chk"><input type="checkbox" id="c-adult" /><span>I confirm I am <b>18 years of age or older</b>.</span></label>
        <label class="chk"><input type="checkbox" id="c-terms" /><span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms of use</a>.</span></label>
      </div>
      <button class="btn gold" id="c-go" disabled>Agree &amp; create my anonymous ID</button>
      <p class="fine">Consent is stored on your device and with your anonymous ID. You can withdraw it at any time inside the app.</p>
    </div>
  </div>
</div>
'''
write("signin.html", page("/signin", "Sign in | GhostChat", "Create an anonymous GhostChat ID or unlock your account. No phone number or email needed.", signin))

# ------------------------------------------------------------------ 404
nf = f'''<section class="final"><div class="wrap"><img src="/icon.svg" alt="" /><h2>This page vanished.</h2><p>Like a good disappearing message.</p><a class="btn gold" href="/">Back to home {ic("arrow")}</a></div></section>'''
write("404.html", page("/404", "Not found | GhostChat", "Page not found.", nf))
print("built", sorted(os.listdir(OUT)))
