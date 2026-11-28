import asyncio
from playwright.async_api import async_playwright
L="http://localhost:3999"; P="river lamp mango seven"
CONSENT="if(location.pathname==='/signin'){location.replace('/app?c=2026-11.'+Date.now()+(location.search?'&'+location.search.slice(1):'')+location.hash)}"
async def onboard(pg,n):
    await pg.goto(L+"/app"); await pg.wait_for_selector("#onboard:not(.hidden)")
    await pg.fill("#ob-name",n); await pg.fill("#ob-pass",P); await pg.fill("#ob-pass2",P); await pg.click("#ob-create"); await pg.wait_for_selector(".idbox",timeout=60000)
    i=await pg.inner_text(".idbox"); await pg.click("#modal-actions button:has-text('Close')"); return i
SEND = """async ([id, kind, f]) => {
  const enc = (s) => new TextEncoder().encode(s);
  const cat = (...a) => { const n = a.reduce((x,y)=>x+y.length,0), o = new Uint8Array(n); let p=0; for (const x of a){o.set(x,p);p+=x.length;} return o; };
  const apk = cat(new Uint8Array([0x50,0x4b,0x03,0x04]), enc("....AndroidManifest.xml....classes.dex....res/"), new Uint8Array(400));
  const pdf = enc("%PDF-1.4\\n1 0 obj << /Type /Catalog >> endobj\\ntrailer\\n%%EOF");
  const cv = document.createElement('canvas'); cv.width=40; cv.height=30; const x=cv.getContext('2d'); x.fillStyle='#c33'; x.fillRect(0,0,40,30);
  const png = new Uint8Array(await (await new Promise(r=>cv.toBlob(r,'image/png'))).arrayBuffer());
  const bodies = {
    disguised: ['file', { data: b64(apk), name: 'Wedding_Invitation.pdf', mime: 'application/pdf', size: apk.length }],
    apk:       ['file', { data: b64(apk), name: 'Shaadi_Card.apk', mime: 'application/vnd.android.package-archive', size: apk.length }],
    rlo:       ['file', { data: b64(pdf), name: 'card\\u202Efdp.apk', mime: 'application/pdf', size: pdf.length }],
    pdf:       ['file', { data: b64(pdf), name: 'menu.pdf', mime: 'application/pdf', size: pdf.length }],
    trojanimg: ['img',  { data: b64(cat(png, enc("MZ-HIDDEN-PAYLOAD-AFTER-IMAGE"))), w: 40, h: 30 }],
    fakeimg:   ['img',  { data: b64(apk), w: 40, h: 30 }],
  };
  const [k, fields] = bodies[kind]; await sendKind(id, k, fields); return true;
}"""
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox","--no-proxy-server"])
        errs=[]
        async def mk():
            c=await b.new_context(); await c.add_init_script(CONSENT); pg=await c.new_page(); pg.on("pageerror",lambda e: errs.append(str(e))); return pg
        a=await mk(); bp=await mk()
        aid=await onboard(a,"Stranger"); bid=await onboard(bp,"Victim")
        await a.click("#fab"); await a.click(".menu-item:has-text('New chat')"); await a.fill("#add-id",bid); await a.click("#modal-actions button:has-text('Start chat')")
        await a.fill("#msg-input","Shaadi ka card dekho https://bit.ly/shaadi-card"); await a.press("#msg-input","Enter")
        for kind in ["disguised","apk","rlo","pdf","trojanimg","fakeimg"]:
            await a.evaluate(SEND, [bid, kind, {}]); await a.wait_for_timeout(700)
        await a.evaluate("""async (id) => { const enc=(s)=>new TextEncoder().encode(s); const b=new Uint8Array(1500000); b.set([0x50,0x4b,0x03,0x04]); b.set(enc('AndroidManifest.xml classes.dex'),30); const blob=await uploadBig(b); await sendKind(id,'file',{blob,name:'Wedding_Video.mp4',mime:'video/mp4',size:b.length,got:true}); }""", bid); await a.wait_for_timeout(1000)
        await bp.wait_for_selector(".chat-item",timeout=30000); await bp.wait_for_timeout(2500); await bp.click(".chat-item"); await bp.wait_for_timeout(800)
        print("request banner shown:", await bp.locator(".request-box").count()==1)
        print("link warning shown:", await bp.locator(".mshield.s-warn:has-text('contains a link')").count()==1)
        r = await bp.evaluate("""msgs(current).map(m => (m.sys ? 'SYS: ' + m.text : m.kind + ' ' + (m.name||'') + ' -> ' + (m.verdict ? m.verdict.level + (m.verdict.block?'/BLOCK':'') : (m.kind==='img' ? 'clean jpeg=' + (unb64(m.data)[0]===0xff && unb64(m.data)[1]===0xd8) + ' payload-gone=' + !new TextDecoder('latin1').decode(unb64(m.data)).includes('HIDDEN-PAYLOAD') : '-'))))""")
        for x in r: print("  ", x)
        print("photo hidden until tap:", await bp.locator("[data-reveal]").count())
        await bp.click("[data-reveal]"); await bp.wait_for_timeout(300); print("photo shown after tap:", await bp.locator("img.photo").count())
        await bp.locator(".filecard.f-danger").first.click(); await bp.wait_for_timeout(400)
        print("before accept, tap file ->", await bp.inner_text("#toast"))
        await bp.screenshot(path="/home/claude/test/shield_b.png", full_page=False)
        await bp.click("[data-req='accept']"); await bp.wait_for_timeout(400)
        await bp.locator(".filecard:has-text('Wedding_Invitation')").click(); await bp.wait_for_timeout(400)
        print("disguised after accept ->", await bp.inner_text("#modal-title"), "| buttons:", await bp.locator("#modal-actions button").all_inner_texts())
        await bp.click("#modal-actions button"); 
        await bp.locator(".filecard:has-text('Shaadi_Card')").click(); await bp.wait_for_timeout(400)
        print("apk after accept ->", await bp.inner_text("#modal-title"), "| buttons:", await bp.locator("#modal-actions button").all_inner_texts())
        await bp.click("#modal-actions button:has-text(\"Don't save\")")
        await bp.locator(".filecard:has-text('Wedding_Video')").click(); await bp.wait_for_timeout(3000)
        print("big fake video ->", await bp.inner_text("#modal-title"), "| verdict:", await bp.evaluate("JSON.stringify(msgs(current).find(m=>m.name==='Wedding_Video.mp4').verdict)"), "| video players:", await bp.locator("video").count())
        print("errors:", errs); await b.close()
asyncio.run(main())
