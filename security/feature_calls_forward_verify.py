import asyncio
from playwright.async_api import async_playwright
L="http://localhost:3999"; P="river lamp mango seven"
CONSENT="if(location.pathname==='/signin'){location.replace('/app?c=2026-11.'+Date.now()+(location.search?'&'+location.search.slice(1):'')+location.hash)}"
async def onboard(pg,n):
    await pg.goto(L+"/app"); await pg.wait_for_selector("#onboard:not(.hidden)")
    await pg.fill("#ob-name",n); await pg.fill("#ob-pass",P); await pg.fill("#ob-pass2",P); await pg.click("#ob-create"); await pg.wait_for_selector(".idbox",timeout=60000)
    i=await pg.inner_text(".idbox"); await pg.click("#modal-actions button:has-text('Close')"); return i
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox","--no-proxy-server","--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream","--autoplay-policy=no-user-gesture-required"])
        errs=[]
        async def mk():
            c=await b.new_context(permissions=["camera","microphone"]); await c.add_init_script(CONSENT); pg=await c.new_page(); pg.on("pageerror",lambda e: errs.append(str(e))); return pg
        a=await mk(); bp=await mk()
        aid=await onboard(a,"Caller"); bid=await onboard(bp,"Callee")
        await a.click("#fab"); await a.click("[data-nc=contact]"); await a.fill("#add-id",bid); await a.click("#modal-actions button:has-text('Start chat')")
        await a.fill("#msg-input","hi"); await a.press("#msg-input","Enter")
        await bp.wait_for_selector(".chat-item",timeout=30000); await bp.click(".chat-item")
        # video call
        print("callok", await a.evaluate("[CALL_OK(), IS_ONION, !!window.RTCPeerConnection, isSecureContext, ready]"))
        print("turn:", await a.evaluate("getTurn().then(x=>JSON.stringify(x))")); print("btn", await a.evaluate("[document.querySelector('#btn-vcall').className, current, !!conv(current)]"))
        await a.click("#btn-vcall"); await a.wait_for_timeout(2500); print("toast:", await a.evaluate("(document.querySelector('.toast')||{}).textContent"), await a.evaluate("document.querySelector('#call').className"))
        await a.wait_for_selector("#call:not(.hidden)")
        await bp.wait_for_selector("#call.ringing:not(.hidden)",timeout=20000); print("callee rings:", await bp.inner_text("#call-status"))
        await bp.click("#cb-accept")
        await a.wait_for_selector("#call.live",timeout=20000); await bp.wait_for_selector("#call.live",timeout=20000)
        await a.wait_for_timeout(3000)
        vw=await bp.evaluate("document.querySelector('#call-remote').videoWidth"); print("callee receives video, width:", vw)
        aw=await a.evaluate("document.querySelector('#call-remote').videoWidth"); print("caller receives video, width:", aw)
        st=await a.evaluate("(async()=>{const s=await call.pc.getStats();let r=[];s.forEach(x=>{if(x.type==='candidate-pair'&&x.state==='succeeded')r.push(x)});return r.length})()")
        print("connected pairs:", st, "| timer:", await a.inner_text("#call-status"))
        await a.wait_for_timeout(1500)
        ca=await a.evaluate("(document.querySelector('#call .callcode')||{}).textContent"); cb=await bp.evaluate("(document.querySelector('#call .callcode')||{}).textContent")
        print("call code caller:", ca, "| callee:", cb, "| match:", bool(ca) and ca==cb)
        print("at 900,300:", await a.evaluate("document.elementFromPoint(900,300).id"), await a.evaluate("JSON.stringify(document.querySelector('#call').getBoundingClientRect())")); await a.screenshot(path="call_a.png"); await bp.set_viewport_size({"width":390,"height":800}); await bp.wait_for_timeout(800); await bp.screenshot(path="call_b.png")

        await a.click("#cb-mute"); print("mute:", await a.evaluate("call.stream.getAudioTracks()[0].enabled"))
        await bp.click("#cb-end"); await a.wait_for_selector("#call.hidden",state="attached",timeout=10000); await bp.wait_for_timeout(1500)
        print("history A:", await a.locator(".sys").last.inner_text()); print("history B:", await bp.locator(".sys").last.inner_text())
        # decline voice call
        await bp.click("#btn-call"); await a.wait_for_selector("#call.ringing:not(.hidden)",timeout=20000)
        await a.click("#cb-decline"); await bp.wait_for_selector("#call.hidden",state="attached",timeout=10000)
        print("after decline B:", await bp.locator(".sys").last.inner_text())
        await a.wait_for_timeout(1500)
        await a.evaluate("(async()=>{ const m = msgs(current).find(x=>x.text==='hi'); await sendForward(current, m); m.fwd = 4; await sendForward(current, m); })()"); await bp.wait_for_timeout(2500)
        print("forward labels on receiver:", await bp.locator(".fwd").all_inner_texts())
        await a.evaluate("safetyDialog()"); await a.wait_for_timeout(500); sa=await a.inner_text("#sn"); await a.click("#modal-actions button:has-text('Mark as verified')"); await a.wait_for_timeout(300)
        await bp.evaluate("safetyDialog()"); await bp.wait_for_timeout(500); sb=await bp.inner_text("#sn")
        print("safety numbers match:", sa==sb, "| header badge:", await a.locator("#chat-name .verified").count(), "| sys:", await a.locator(".sys:has-text('verified')").count())
        print("errors:", errs); await b.close()
asyncio.run(main())
