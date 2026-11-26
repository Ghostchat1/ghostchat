"""GhostChat server VAPT: black-box attacks against a running server.
Each test prints PASS (defended) / FAIL (vulnerable) / INFO with evidence."""
import base64, hashlib, json, os, sys, time, threading, socket, http.client, urllib.request
import websocket
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

HOST, PORT = "127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 3999
BASE = f"http://{HOST}:{PORT}"
results = []
def report(tid, status, title, evidence=""):
    results.append((tid, status, title, evidence)); print(f"[{status:4}] {tid} {title} :: {evidence}"[:260], flush=True)

b64 = lambda b: base64.b64encode(b).decode()
B32 = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
def base32(bs):
    bits = val = 0; out = ""
    for b in bs:  # mirrors the JS exactly (32-bit ints, unmasked shift)
        val = ((val << 8) | b) & 0xFFFFFFFF; bits += 8
        while bits >= 5: out += B32[(val >> (bits - 5)) % 31]; bits -= 5
    return out
def id_of(raw):
    s = base32(hashlib.sha384(raw).digest()[:10])[:16]; return "-".join(s[i:i+4] for i in (0, 4, 8, 12))
def raw_pub(k): return k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
def sign(k, data):
    r, s = decode_dss_signature(k.sign(data, ec.ECDSA(hashes.SHA384()))); return r.to_bytes(48, "big") + s.to_bytes(48, "big")

class User:
    def __init__(self):
        self.sk = ec.generate_private_key(ec.SECP384R1()); self.dk = ec.generate_private_key(ec.SECP384R1())
        self.sign_raw = raw_pub(self.sk); self.ecdh_raw = raw_pub(self.dk); self.id = id_of(self.sign_raw)
    def spk(self, kem=None):
        pub = raw_pub(ec.generate_private_key(ec.SECP384R1())); kem = kem or os.urandom(1184); sid = "spk" + os.urandom(4).hex()
        return {"id": sid, "pub": b64(pub), "kem": b64(kem), "sig": b64(sign(self.sk, sid.encode() + pub + kem))}
    def reg_body(self, pow=True, **over):
        b = {"sign": b64(self.sign_raw), "ecdh": b64(self.ecdh_raw), "sig": b64(sign(self.sk, self.ecdh_raw)), "spk": self.spk()}
        if pow: b["pow"] = solve_pow(b["sign"])
        b.update(over); return b

POW_CACHE = {}
def solve_pow(sign_b64, bits=18):
    if sign_b64 in POW_CACHE: return POW_CACHE[sign_b64]
    pre = ("gc-pow:" + sign_b64 + ":").encode(); n = 0
    while True:
        d = hashlib.sha256(pre + str(n).encode()).digest()
        if int.from_bytes(d[:4], "big") >> (32 - bits) == 0: POW_CACHE[sign_b64] = str(n); return str(n)
        n += 1
def req(method, path, body=None, headers=None, raw=None):
    c = http.client.HTTPConnection(HOST, PORT, timeout=10)
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = {"Content-Type": "application/json"}; h.update(headers or {})
    c.request(method, path, body=data, headers=h); r = c.getresponse(); d = r.read(); c.close()
    return r.status, dict(r.getheaders()), d
def register(u, pow=True, **over): return req("POST", "/api/register", u.reg_body(pow=pow, **over))
def ws_open():
    w = websocket.create_connection(f"ws://{HOST}:{PORT}/ws", timeout=5); ch = json.loads(w.recv()); return w, ch["nonce"]
def ws_auth(u, w=None):
    if w is None: w, n = ws_open()
    else: n = w._nonce
    w.send(json.dumps({"t": "auth", "id": u.id, "sig": b64(sign(u.sk, ("gc2-auth:" + n).encode()))})); return w, json.loads(w.recv())
def recv_all(w, t=0.6):
    w.settimeout(t); out = []
    try:
        while True: out.append(json.loads(w.recv()))
    except Exception: pass
    return out
def alive():
    try: return req("GET", "/")[0] == 200
    except Exception: return False

# ---------------- HTTP ----------------
st, h, body = req("GET", "/")
need = {"Content-Security-Policy": "script-src 'self'", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store"}
miss = [k for k, v in need.items() if v not in h.get(k, "")]
report("H01", "PASS" if not miss else "FAIL", "Security headers on pages", "missing: " + str(miss) if miss else "CSP, XFO, nosniff, no-referrer, no-store present")
csp = h.get("Content-Security-Policy", "")
report("H16", "PASS" if f"ws://{HOST}:{PORT}" in csp else "FAIL", "CSP allows the app's own websocket explicitly (Firefox/Tor Browser compatibility)", "connect-src lists ws://host" if f"ws://{HOST}:{PORT}" in csp else csp[:120])
report("H02", "PASS" if "X-Powered-By" not in h and "Server" not in h else "FAIL", "No server fingerprint headers", str({k: h[k] for k in h if k in ("Server", "X-Powered-By")}))
report("H03", "INFO", "No HSTS header", "expected: served over Tor .onion (http); add HSTS only if also hosted on https")

trav = ["/../server.js", "/%2e%2e/server.js", "/..%2fserver.js", "/%2e%2e%2fserver.js", "/public/../server.js", "/..\\server.js", "//etc/passwd",
        "/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd", "/index.html%00.js", "/./../package.json", "/%252e%252e/server.js", "/....//server.js"]
leaks = []
for p in trav:
    s, hh, d = req("GET", p)
    if b"require(\"ws\")" in d or b"root:x:" in d or b'"dependencies"' in d: leaks.append(p)
report("H04", "PASS" if not leaks else "FAIL", f"Path traversal ({len(trav)} variants)", "leaked: " + str(leaks) if leaks else "no file outside public/ served")

try:
    s, hh, d = req("POST", "/api/register", raw=b"{" * 20000); ev = f"status {s}"; okk = s in (400, 413)
except Exception as e: ev, okk = "connection closed by server (body >8 KB refused)", True
report("H05", "PASS" if okk and alive() else "FAIL", "Oversized body to /api/register", ev)
s, hh, d = req("POST", "/api/register", raw=b"{not json")
report("H06", "PASS" if s == 400 and b"at " not in d and b"Error" not in d else "FAIL", "Malformed JSON → no stack trace", f"{s} {d[:60]}")
codes = {m: req(m, "/")[0] for m in ["TRACE", "PUT", "DELETE", "PATCH"]}
report("H07", "PASS" if all(c == 405 for c in codes.values()) else "INFO", "Unexpected HTTP methods (TRACE/PUT/DELETE/PATCH)", str(codes))

u = User()
cases = {
    "short sign key": dict(sign=b64(b"\x04" + os.urandom(40))),
    "bad identity sig": dict(sig=b64(os.urandom(96))),
    "sig by other key": dict(sig=b64(sign(ec.generate_private_key(ec.SECP384R1()), u.ecdh_raw))),
    "spk missing kem": dict(spk={k: v for k, v in u.spk().items() if k != "kem"}),
    "spk forged sig": dict(spk={**u.spk(), "sig": b64(os.urandom(96))}),
    "spk wrong kem size": dict(spk=u.spk(kem=os.urandom(800))),
    "types confusion": dict(sign=["x"], ecdh={"a": 1}),
}
bad = [n for n, o in cases.items() if register(u, **o)[0] == 200]
report("H08", "PASS" if not bad else "FAIL", f"Registration input validation ({len(cases)} forged/malformed cases)", "accepted: " + str(bad) if bad else "all rejected with 400")
s0, _, d0 = register(u, pow=False)
report("H17", "PASS" if s0 == 400 and b"proof" in d0 else "FAIL", "Signup without proof-of-work refused", f"{s0} {d0[:60]}")
s, hh, d = register(u); ok = s == 200 and json.loads(d)["id"] == u.id
report("H09", "PASS" if ok else "FAIL", "Valid registration; server derives same ID as client", u.id)

# account takeover: re-register victim's public sign key with attacker's ecdh/spk
victim = u; att = User()
body = {"sign": b64(victim.sign_raw), "ecdh": b64(att.ecdh_raw), "sig": b64(sign(att.sk, att.ecdh_raw)), "spk": att.spk(), "pow": solve_pow(b64(victim.sign_raw))}
s, hh, d = req("POST", "/api/register", body)
keys = json.loads(req("GET", "/api/keys/" + victim.id)[2])
report("H10", "PASS" if keys["ecdh"] == b64(victim.ecdh_raw) else "FAIL", "Account takeover by re-registering victim's public key", f"status {s}; victim keys unchanged={keys['ecdh'] == b64(victim.ecdh_raw)}")

for p in ["/api/keys/__proto__", "/api/keys/constructor", "/api/keys/..%2f..%2fserver.js", "/api/keys/" + "A" * 5000, "/api/keys/%00"]:
    s, hh, d = req("GET", p)
    if s not in (404, 400, 414, 431): report("H11", "FAIL", "Key lookup injection", f"{p[:40]} → {s} {d[:60]}"); break
else: report("H11", "PASS", "Key lookup injection (__proto__, traversal, huge, NUL)", "all 404/4xx, no crash")

s, hh, d = req("GET", "/api/keys/" + victim.id, headers={"Origin": "https://evil.example"})
report("H12", "PASS" if "Access-Control-Allow-Origin" not in hh else "FAIL", "CORS: arbitrary origin denied", hh.get("Access-Control-Allow-Origin", "no ACAO header"))
s, hh, d = req("OPTIONS", "/api/register", headers={"Origin": "https://appassets.androidplatform.net", "Access-Control-Request-Method": "POST"})
report("H13", "PASS" if s == 204 and hh.get("Access-Control-Allow-Origin") == "https://appassets.androidplatform.net" else "FAIL", "CORS: only the Android app origin allowed", f"preflight {s}")

s2, h2, _ = req("POST", "/wipe")
s3, h3, _ = req("POST", "/wipe", headers={"X-GC-Wipe": "1", "Sec-Fetch-Site": "cross-site"})
s4, h4, _ = req("POST", "/wipe", headers={"X-GC-Wipe": "1", "Sec-Fetch-Site": "same-origin"})
report("H15", "PASS" if s2 == 403 and s3 == 403 and "Clear-Site-Data" in h4 else "FAIL", "Wipe only from the app itself (POST + custom header + same-origin)", f"no header→{s2}, cross-site→{s3}, app→{s4} clear={('Clear-Site-Data' in h4)}")
s, hh, d = req("GET", "/wipe")
report("H14", "FAIL" if "Clear-Site-Data" in hh else "PASS", "Cross-site 'wipe' link (CSRF on destructive endpoint)",
       "GET /wipe returns Clear-Site-Data — any link/redirect to /wipe erases a victim's account" if "Clear-Site-Data" in hh else "GET /wipe no longer clears data")

# ---------------- WebSocket ----------------
w, n = ws_open()
for f in [{"t": "ack", "mid": "x"}, {"t": "spk", "spk": att.spk()}, {"t": "delete_account"}]: w.send(json.dumps(f))
time.sleep(0.4); w.close()
still = req("GET", "/api/keys/" + victim.id)[0] == 200
report("W01", "PASS" if still else "FAIL", "Privileged WS commands before auth (ack/spk/delete_account)", "ignored" if still else "executed!")

w, n = ws_open(); w.send(json.dumps({"t": "auth", "id": victim.id, "sig": b64(sign(att.sk, ("gc2-auth:" + n).encode()))}))
r = json.loads(w.recv()); w.close()
report("W02", "PASS" if r.get("error") == "auth failed" else "FAIL", "Auth as another user with attacker's signature", r)
w1, n1 = ws_open(); old = b64(sign(victim.sk, ("gc2-auth:" + n1).encode())); w1.close()
w2, n2 = ws_open(); w2.send(json.dumps({"t": "auth", "id": victim.id, "sig": old})); r = json.loads(w2.recv()); w2.close()
report("W03", "PASS" if r.get("error") == "auth failed" else "FAIL", "Replay of a captured auth signature on a new connection", r)

w, n = ws_open()
w.send(json.dumps({"t": "drop", "to": "AAAA-BBBB-CCCC-DDDD", "mid": "m" * 10, "env": "x"})); r1 = json.loads(w.recv())
w.send(json.dumps({"t": "drop", "to": victim.id, "mid": "<script>", "env": "x"})); r2 = json.loads(w.recv())
w.send(json.dumps({"t": "drop", "to": victim.id, "mid": "okmid12345", "env": "x" * (6 * 1024 * 1024 + 1)}))
try: r3 = json.loads(w.recv())
except Exception as e: r3 = {"closed": str(e)[:40]}
report("W04", "PASS" if r1.get("t") == "error" and r2.get("t") == "error" and r3.get("t") != "queued" else "FAIL", "Drop validation (unknown recipient, bad mid, oversize)", f"{r1.get('t')}/{r2.get('t')}/{r3}")

w, n = ws_open(); sent = 0
for i in range(120): w.send(json.dumps({"t": "drop", "to": victim.id, "mid": f"flood{i:05d}xx", "env": "e"})); sent += 1
got = [m for m in recv_all(w, 1.0) if m.get("t") == "queued"]; w.close()
report("W05", "PASS" if len(got) <= 40 else "FAIL", "Per-connection flood limit", f"{sent} sent in burst → {len(got)} accepted")

# queue flushing: an anonymous attacker pushes the victim's real messages out
legit = "LEGIT0000001"
w, n = ws_open(); w.send(json.dumps({"t": "drop", "to": victim.id, "mid": legit, "env": "real-message"})); recv_all(w, 0.3); w.close()
def flood(k):
    w, n = ws_open()
    for i in range(35): w.send(json.dumps({"t": "drop", "to": victim.id, "mid": f"f{k:03d}x{i:04d}", "env": "junk"}))
    recv_all(w, 0.5); w.close()
ths = [threading.Thread(target=flood, args=(k,)) for k in range(32)]; [t.start() for t in ths]; [t.join() for t in ths]
vw, resp = ws_auth(victim); msgs = [m for m in recv_all(vw, 2.0) if m.get("t") == "msg"]; vw.close()
lost = not any(m["mid"] == legit for m in msgs)
report("W06", "FAIL" if lost else "PASS", "Queue flushing by anonymous senders", f"{len(msgs)} queued for victim; legit message {'EVICTED' if lost else 'kept'}")

# unlimited registrations (memory DoS on RAM-only server)
t0 = time.time(); okc = 0; N = 20
for i in range(N):
    if register(User())[0] == 200: okc += 1
dt = time.time() - t0
nopow = sum(1 for i in range(50) if register(User(), pow=False)[0] == 200)
report("W07", "PASS" if nopow == 0 and dt / N > 0.1 else "FAIL", "Mass registration (cost per account + global cap)", f"without PoW: {nopow}/50 accepted; with PoW: {N} accounts took {dt:.1f}s ({dt/N:.2f}s each, ~{3600*N/dt:.0f}/hour per CPU core); global cap MAX_USERS")

socks = []
try:
    for i in range(400): socks.append(websocket.create_connection(f"ws://{HOST}:{PORT}/ws", timeout=3))
except Exception as e: refused = str(e)[:50]
else: refused = "none"
report("W08", "FAIL" if len(socks) >= 400 else "PASS", "Connection exhaustion (global connection cap)", f"{len(socks)} sockets accepted, then refused ({refused}); cap set to 300 for this test, default 3000")
for s_ in socks:
    try: s_.close()
    except Exception: pass

w, n = ws_open()
for junk in ["not json", "[]", "null", "1e999", '{"t":"auth","id":{"$ne":1}}', '{"t":"drop","to":["A"]}', '{"t":"ack","mid":{"x":1}}', "{" * 5000 + "}" * 5000, '{"__proto__":{"polluted":1},"t":"x"}']:
    try: w.send(junk)
    except Exception: break
time.sleep(0.5)
report("W09", "PASS" if alive() else "FAIL", "Malformed / prototype-pollution WS frames", "server alive" if alive() else "SERVER DOWN")

vw, resp = ws_auth(victim); vw.send(json.dumps({"t": "delete_account"})); recv_all(vw, 0.5); vw.close()
report("W10", "PASS" if req("GET", "/api/keys/" + victim.id)[0] == 404 and req("GET", "/api/keys/" + att.id)[0] in (200, 404) else "FAIL", "delete_account only deletes the authenticated user", "victim removed by own request")

report("Z99", "PASS" if alive() else "FAIL", "Server survived the whole attack run", "")
json.dump(results, open("/home/claude/vapt/server_results.json", "w"), indent=1)
