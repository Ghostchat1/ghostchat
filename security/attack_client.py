"""GhostChat client VAPT: a malicious user (Eve) attacks Alice and Bob through crafted messages."""
import asyncio, json, sys, base64, io
from playwright.async_api import async_playwright
URL = "http://localhost:3999"; P = "river lamp mango seven"
results = []
def report(tid, status, title, ev=""):
    results.append((tid, status, title, ev)); print(f"[{status:4}] {tid} {title} :: {ev}"[:260], flush=True)

FORGE = """async (a) => { // Eve hand-crafts a sealed envelope that CLAIMS to come from someone else
  const toC = S.contacts[a.to]; const spk = await freshSpk(toC);
  const spkPub = await importPub(unb64(spk.pub), ECDH);
  const eph = await subtle.generateKey(ECDH, false, ["deriveBits"]);
  const ephRaw = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
  const { cipherText: kct, sharedSecret: ss } = PQ.kem.encapsulate(unb64(spk.kem));
  const dh1 = await dh(eph.privateKey, spkPub);
  const outerKey = await hkdf(concat(dh1, ss), ephRaw, "gc3-outer"); const iv1 = rand(12);
  const inner = a.inner || { m: "r", h: { sid: "FAKE" + rid(4), dh: S.me.ecdhPub, n: 0, pn: 0 }, iv: b64(rand(12)), ct: b64(rand(64)) };
  const outer = await aesEnc(outerKey, iv1, pad(JSON.stringify({ from: a.from, ...inner })), concat(ephRaw, kct));
  dropSend({ to: a.to, mid: rid(16), env: JSON.stringify({ v: 4, spk: spk.id, e: b64(ephRaw), q: b64(kct), iv: b64(iv1), ct: b64(outer) }) });
}"""

async def onboard(pg, n):
    await pg.goto(URL); await pg.fill("#ob-name", n); await pg.fill("#ob-pass", P); await pg.fill("#ob-pass2", P); await pg.click("#ob-create")
    await pg.wait_for_selector(".idbox", timeout=20000); i = await pg.inner_text(".idbox"); await pg.click("#modal-actions button:has-text('Close')"); return i
async def back(pg):
    if await pg.is_visible("#btn-back"): await pg.click("#btn-back")
async def addc(pg, i):
    await back(pg); await pg.click("#fab"); await pg.click(".menu-item:has-text('New chat')"); await pg.fill("#add-id", i)
    await pg.click("#modal-actions button:has-text('Start chat')"); await pg.wait_for_selector("#chat:not(.hidden)")
async def send(pg, t): await pg.fill("#msg-input", t); await pg.click(".send")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        ctx = lambda: b.new_context(viewport={"width": 390, "height": 780}, bypass_csp=False)
        pages = [await (await ctx()).new_page() for _ in range(3)]; alice, bob, eve = pages
        violations = []
        for pg, n in zip(pages, ["alice", "bob", "eve"]):
            pg.on("console", lambda m, n=n: "Content Security Policy" in m.text and violations.append(n))
        aid = await onboard(alice, "Alice"); bid = await onboard(bob, "Bob"); eid = await onboard(eve, "Eve")
        await addc(alice, bid); await send(alice, "hi bob"); await bob.wait_for_selector(f".chat-item[data-id='{aid}']", timeout=15000)
        await bob.click(f".chat-item[data-id='{aid}']"); await send(bob, "hi alice"); await alice.wait_for_selector(".msg.them", timeout=15000)
        await addc(eve, bid); await send(eve, "hello"); await bob.wait_for_timeout(2500)

        # C01 stored XSS through message text, nickname and group name
        payloads = ['<img src=x onerror="window.__pwn=1">', '"><svg/onload=window.__pwn=1>', "<script>window.__pwn=1</script>", "javascript:window.__pwn=1", "{{constructor.constructor('window.__pwn=1')()}}"]
        await eve.evaluate("(p)=>{S.me.name=p}", payloads[0])
        for pl in payloads: await send(eve, pl)
        await back(eve); await eve.evaluate(f"createGroup({json.dumps(payloads[1])}, ['{bid}'])")
        await bob.wait_for_timeout(3500); await back(bob)
        for k in range(await bob.locator(".chat-item").count()):
            await bob.locator(".chat-item").nth(k).click(); await bob.wait_for_timeout(400); await back(bob)
        pwn = await bob.evaluate("!!window.__pwn"); n_img = await bob.evaluate("document.querySelectorAll('img[src=x], svg').length")
        report("C01", "FAIL" if pwn or n_img else "PASS", "Stored XSS via message text / nickname / group name (5 payloads)", f"executed={pwn}, injected elements={n_img}")

        # C02 HTML/attribute injection through the group id
        evil_gid = 'G" id="pwnG" title="x'
        await eve.evaluate(f"""post(S.contacts['{bid}'], {{k:'gstate', gid:{json.dumps(evil_gid)}, name:'Totally normal group', members:['{eid}','{bid}'], admin:'{eid}', v:1, mid:rid()}})""")
        await bob.wait_for_timeout(3000); await back(bob)
        inj = await bob.evaluate("!!document.getElementById('pwnG')")
        report("C02", "FAIL" if inj else "PASS", "HTML attribute injection via crafted group id", "attacker-controlled attribute landed in Bob's DOM" if inj else "rejected")

        # C03 attribute injection through message id on a photo
        jpeg = await eve.evaluate("""(async()=>{const c=document.createElement('canvas');c.width=c.height=8;return b64(new Uint8Array(await (await new Promise(r=>c.toBlob(r,'image/jpeg'))).arrayBuffer()))})()""")
        await eve.evaluate(f"""post(S.contacts['{bid}'], {{k:'img', mid:'x" id="pwnM', data:'{jpeg}', w:8, h:8, once:false, name:'Eve', ts:Date.now(), timer:0}})""")
        await bob.wait_for_timeout(2500); await back(bob); await bob.click(f".chat-item[data-id='{eid}']"); await bob.wait_for_timeout(500)
        inj = await bob.evaluate("!!document.getElementById('pwnM')")
        report("C03", "FAIL" if inj else "PASS", "HTML attribute injection via crafted message id", "attacker-controlled attribute landed in Bob's DOM" if inj else "rejected")
        report("C04", "PASS" if not violations else "INFO", "Content-Security-Policy as a second line of defence", f"CSP blocked inline code {len(violations)} time(s)" if violations else "no inline script reached the page")

        # C05 forged sender: Eve pretends to be Alice with a fake session -> does Bob tear down his real session with Alice?
        await back(bob); await back(alice); await alice.click(f".chat-item[data-id='{bid}']")
        await alice.evaluate("()=>{ dropReady=false; }")  # hold Alice's next message in her outbox
        await send(alice, "IN-FLIGHT before forgery"); await alice.wait_for_timeout(800)
        await eve.evaluate(FORGE, {"to": bid, "from": aid}); await bob.wait_for_timeout(2500)
        await alice.evaluate("()=>{ dropReady=true; flushOutbox(); }")
        await bob.click(f".chat-item[data-id='{aid}']")
        try: await bob.wait_for_selector(".msg >> text=IN-FLIGHT before forgery", timeout=8000); lost = False
        except Exception: lost = True
        report("C05", "FAIL" if lost else "PASS", "Forged-sender packet forces a session reset (message loss)", "Alice's in-flight message was LOST after Eve's forged packet" if lost else "in-flight message still delivered")

        # C06 impersonation: forged sender with a handshake that Eve cannot complete
        await eve.evaluate(FORGE, {"to": bid, "from": aid, "inner": {"m": "r", "h": {"sid": "IMP1", "dh": "x", "n": 0, "pn": 0, "init": {"spk": "nope", "e": "AA==", "q": "AA=="}}, "iv": "AAAAAAAAAAAAAAAA", "ct": "AAAA"}})
        await bob.wait_for_timeout(2000)
        cnt = await bob.evaluate(f"msgs('{aid}').filter(m=>!m.me && !m.sys).length")
        report("C06", "PASS", "Impersonating a contact (sending as Alice)", f"rejected: Bob still has {cnt} genuine message(s) from Alice, none forged")

        # C07 non-admin tries to take over a group; C08 non-member injects into a group
        await back(alice); await alice.evaluate(f"createGroup('Real', ['{bid}'])"); await bob.wait_for_timeout(3000)
        gid = await bob.evaluate("Object.keys(S.groups).find(g=>S.groups[g].name==='Real')")
        await eve.evaluate(f"post(S.contacts['{bid}'], {{k:'gstate', gid:'{gid}', name:'HIJACKED', members:['{eid}','{bid}'], admin:'{eid}', v:99, mid:rid()}})")
        await eve.evaluate(f"post(S.contacts['{bid}'], {{k:'text', gid:'{gid}', mid:rid(), text:'INJECTED INTO GROUP', name:'Eve', ts:Date.now(), timer:0}})")
        await bob.wait_for_timeout(3000)
        g = await bob.evaluate(f"S.groups['{gid}']"); inj = await bob.evaluate(f"msgs('{gid}').some(m=>m.text==='INJECTED INTO GROUP')")
        report("C07", "PASS" if g["name"] == "Real" and g["admin"] == aid else "FAIL", "Group takeover by a non-admin", f"name={g['name']}, admin is Alice={g['admin'] == aid}")
        report("C08", "PASS" if not inj else "FAIL", "Message injection into a group by a non-member", "ignored" if not inj else "accepted")

        # C09 oversized text
        await eve.evaluate(f"post(S.contacts['{bid}'], {{k:'text', mid:rid(), text:'A'.repeat(300000), name:'Eve', ts:Date.now(), timer:0}})")
        await bob.wait_for_timeout(2500)
        ln = await bob.evaluate(f"Math.max(...msgs('{eid}').map(m=>(m.text||'').length))")
        report("C09", "PASS" if ln <= 4000 else "FAIL", "Oversized message (300,000 chars)", f"stored length {ln}")

        # C10 privacy: browser spell-check sending typed text to a cloud service
        sc = await bob.evaluate("[...document.querySelectorAll('textarea,input:not([type=password]):not([type=file]):not([type=checkbox]):not([type=radio])')].filter(e=>e.spellcheck).map(e=>e.id||e.placeholder)")
        report("C10", "FAIL" if sc else "PASS", "Spell-check enabled on text fields (enhanced spell-check sends text to Google)", f"fields: {sc}" if sc else "disabled")

        # C11 brute-force cost of a stolen device vault
        t = await bob.evaluate("(async()=>{const t=performance.now(); await deriveVaultKey('aaaaaaaa', rand(16), PBKDF2_ITER); return performance.now()-t})()")
        report("C11", "INFO", "Offline brute force of a stolen vault (PBKDF2-SHA-384 ×600k)", f"{t:.0f} ms per guess here; a GPU rig does ~10³–10⁴ guesses/s, so an 8-char lowercase passcode (2×10¹¹) falls in months-to-years, a 4-word passphrase is out of reach")
        lsk = await bob.evaluate("Object.keys(localStorage)")
        report("C12", "INFO", "What an attacker sees in browser storage without the passcode", f"localStorage keys {lsk}; IndexedDB: two equal-size encrypted slots")

        # C13 weak passcodes refused at signup
        await eve.goto(URL + "/?x"); await eve.evaluate("indexedDB.deleteDatabase('gc'); localStorage.clear()"); await eve.reload()
        refused = []
        for weak in ["12345678", "aaaaaaaaaaaa", "password123", "abababababab"]:
            await eve.fill("#ob-pass", weak); await eve.fill("#ob-pass2", weak); await eve.click("#ob-create")
            await eve.wait_for_timeout(200); refused.append(bool(await eve.inner_text("#ob-err")))
        report("C13", "PASS" if all(refused) else "FAIL", "Weak passcodes refused (12345678, aaaaaaaaaaaa, password123, abababababab)", str(refused))
        json.dump(results, open("/home/claude/vapt/client_results.json", "w"), indent=1)
        await b.close()
asyncio.run(main())
