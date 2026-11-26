// GhostChat v2 relay server — built to run as a Tor onion service.
//
// What this server knows:     an anonymous ID's public keys, and locked blobs waiting for that ID.
// What it never knows:        phone, email, IP (behind Tor every visitor is 127.0.0.1), message content,
//                             message size (padded), or WHO sent a message (sealed sender).
// With DATA_FILE=memory it never writes anything to disk; a restart erases everything.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { webcrypto, createHash } = require("crypto");
const { WebSocketServer } = require("ws");
const subtle = webcrypto.subtle;

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";           // localhost only: reachable only through Tor
const DATA_FILE = process.env.DATA_FILE || "memory";     // "memory" = RAM only, nothing on disk
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_ENV = 6 * 1024 * 1024;             // max size of one sealed envelope (base64): photos ~0.7 MB, files up to 2 MB become ~3.6 MB
const MAX_QUEUE_BYTES = 25 * 1024 * 1024;    // max waiting data per user
const MAX_QUEUE = 1000;                      // max waiting envelopes per user
const QUEUE_TTL = 7 * 24 * 3600 * 1000;      // undelivered envelopes are destroyed after 7 days
const CURVE = { name: "ECDSA", namedCurve: "P-384" }, SIG = { name: "ECDSA", hash: "SHA-384" };
const RAW_LEN = 97;                          // uncompressed P-384 public key
const KEM_LEN = 1184;                        // ML-KEM-768 public key (post-quantum)
// --- abuse limits (VAPT fixes W06–W08) ---
const POW_BITS = +process.env.POW_BITS || 18;                      // signup proof-of-work (~0.3–3 s per account)
const MAX_USERS = +process.env.MAX_USERS || 100000;                // global account cap (RAM safety)
const MAX_CONNS = +process.env.MAX_CONNS || 3000;                  // global socket cap
const GLOBAL_QUEUE_BYTES = +process.env.GLOBAL_QUEUE_BYTES || 512 * 1024 * 1024;
const DROPS_PER_MIN = +process.env.DROPS_PER_MIN || 120;           // per recipient
const IDLE_MS = 15 * 60 * 1000;                                    // close silent sockets

// ---------- storage ----------
const persistent = DATA_FILE !== "memory";
let db = { users: {}, queue: {} };
if (persistent) { try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {} }
let saveTimer = null;
function save() {
  if (!persistent) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE + ".tmp", JSON.stringify(db), { mode: 0o600 }, (e) => { if (!e) fs.rename(DATA_FILE + ".tmp", DATA_FILE, () => {}); });
  }, 300);
}

// ---------- helpers ----------
const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(String(s || ""), "base64"));
const B32 = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function base32(bytes) {
  let bits = 0, val = 0, out = "";
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) % B32.length]; bits -= 5; } }
  return out;
}
async function idFromSignKey(raw) {
  const h = new Uint8Array(await subtle.digest("SHA-384", raw));
  return base32(h.slice(0, 10)).slice(0, 16).match(/.{4}/g).join("-");
}
async function verify(rawSignPub, sigB64, data) {
  try {
    const key = await subtle.importKey("raw", rawSignPub, CURVE, false, ["verify"]);
    return await subtle.verify(SIG, key, unb64(sigB64), data);
  } catch { return false; }
}
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const validId = (id) => typeof id === "string" && /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(id);
const powOk = (sign, pow) => {
  if (typeof pow !== "string" || pow.length > 32) return false;
  const h = createHash("sha256").update("gc-pow:" + sign + ":" + pow).digest();
  let bits = 0; for (const b of h) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
  return bits >= POW_BITS;
};
let queueBytes = 0; // total bytes waiting in all queues
const dropRate = new Map(); // recipient -> {t, n}
const validSpk = (s) => s && typeof s.id === "string" && /^[A-Za-z0-9_-]{4,24}$/.test(s.id) && unb64(s.pub).length === RAW_LEN && unb64(s.kem).length === KEM_LEN && typeof s.sig === "string";
// prekey = classic P-384 key + post-quantum ML-KEM-768 key, both signed by the identity key
const spkOk = (signRaw, s) => validSpk(s) && verify(signRaw, s.sig, concat(new TextEncoder().encode(s.id), unb64(s.pub), unb64(s.kem)));
const pubSpk = (s) => ({ id: s.id, pub: s.pub, kem: s.kem, sig: s.sig });

setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(db.queue)) {
    db.queue[id] = db.queue[id].filter((m) => (m.exp > now ? true : ((queueBytes -= m.env.length), false)));
    if (!db.queue[id].length) delete db.queue[id];
  }
  dropRate.clear();
  save();
}, 10 * 60 * 1000);
for (const q of Object.values(db.queue)) for (const m of q) queueBytes += m.env.length;

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png" };
function headers(res, host) {
  const h = /^[a-z0-9.-]+(:\d+)?$/i.test(host || "") ? host : "";
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=(), interest-cohort=()");
  res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src blob:; connect-src 'self'${h ? ` ws://${h} wss://${h}` : ""}; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.setHeader("Cache-Control", "no-store");
  res.removeHeader("X-Powered-By");
}
function sendJson(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { const e = new Error("big"); e.code = 413; reject(e); req.pause(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  headers(res, req.headers.host);
  if (!["GET", "HEAD", "POST", "OPTIONS"].includes(req.method)) { res.writeHead(405, { Allow: "GET, POST" }); return res.end(); }
  const url = new URL(req.url, "http://x");
  // The Android app runs its bundled code from this origin and calls the API cross-origin.
  if (url.pathname.startsWith("/api/") && req.headers.origin === "https://appassets.androidplatform.net") {
    res.setHeader("Access-Control-Allow-Origin", "https://appassets.androidplatform.net");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (req.headers["access-control-request-private-network"]) res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  }
  try {
    if (req.method === "POST" && url.pathname === "/api/register") {
      const { sign, ecdh, sig, spk, pow } = await readBody(req);
      const signRaw = unb64(sign), ecdhRaw = unb64(ecdh);
      if (signRaw.length !== RAW_LEN || ecdhRaw.length !== RAW_LEN) return sendJson(res, 400, { error: "bad request" });
      if (!(await verify(signRaw, sig, ecdhRaw)) || !(await spkOk(signRaw, spk))) return sendJson(res, 400, { error: "bad request" });
      if (!powOk(sign, pow)) return sendJson(res, 400, { error: "proof of work required", bits: POW_BITS });
      const id = await idFromSignKey(signRaw);
      const u = db.users[id];
      if (!u && Object.keys(db.users).length >= MAX_USERS) return sendJson(res, 503, { error: "server full" });
      if (!u) db.users[id] = { sign, ecdh, sig, spk: pubSpk(spk) };
      else if (u.sign === sign) { u.ecdh = ecdh; u.sig = sig; u.spk = pubSpk(spk); }
      save();
      return sendJson(res, 200, { id });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/keys/")) {
      const id = decodeURIComponent(url.pathname.slice(10)).toUpperCase();
      const u = validId(id) && db.users[id];
      if (!u) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, { id, sign: u.sign, ecdh: u.ecdh, sig: u.sig, spk: u.spk });
    }
    // Panic. POST /wipe tells the browser to delete EVERYTHING this site stored (storage, cache, cookies,
    // service workers). It needs a custom header, which other websites cannot send (VAPT fix H14), so a
    // malicious link can no longer wipe someone's account. GET /wipe is just the blank landing page.
    if (url.pathname === "/wipe") {
      if (req.method === "POST") {
        const site = req.headers["sec-fetch-site"];
        if (req.headers["x-gc-wipe"] !== "1" || (site && site !== "same-origin")) { res.writeHead(403); return res.end(); }
        res.setHeader("Clear-Site-Data", '"cache", "cookies", "storage"');
        res.writeHead(204); return res.end();
      }
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return res.end(url.searchParams.has("home")
        ? '<!doctype html><meta http-equiv="refresh" content="0;url=/"><title>GhostChat</title>'
        : '<!doctype html><meta name="viewport" content="width=device-width"><title>New Tab</title>');
    }
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, b2) => { if (e2) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(b2); });
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  } catch (e) {
    const big = e && e.code === 413;
    if (big) res.setHeader("Connection", "close");
    sendJson(res, big ? 413 : 400, { error: big ? "too large" : "bad request" });
  }
});

// ---------- WebSocket ----------
// Two kinds of sockets, same endpoint:
//  * an INBOX socket proves it owns an ID (signs a challenge) and receives that ID's envelopes;
//  * a DROP socket never identifies itself and only posts sealed envelopes to an ID.
// The app sends through a drop socket, so the server cannot link a message to its sender.
const wss = new WebSocketServer({
  server, path: "/ws", maxPayload: MAX_ENV + 4096,
  verifyClient: (_info, done) => done(wss.clients.size < MAX_CONNS, 503, "busy"), // refuse at the handshake (VAPT fix W08)
});
const online = new Map();
const deliver = (id, obj) => { const s = JSON.stringify(obj); for (const ws of online.get(id) || []) if (ws.readyState === 1) ws.send(s); };
const randomId = () => b64(webcrypto.getRandomValues(new Uint8Array(32)));

wss.on("connection", (ws) => {
  ws.nonce = randomId(); ws.uid = null; ws.bucket = { t: Date.now(), n: 0 }; ws.last = Date.now();
  ws.send(JSON.stringify({ t: "challenge", nonce: ws.nonce }));

  ws.on("message", async (raw) => { try { await onFrame(ws, raw); } catch { /* never let one bad frame take the server down (VAPT fix W09) */ } });
  async function onFrame(ws, raw) {
    const now = Date.now(); ws.last = now;
    if (now - ws.bucket.t > 5000) ws.bucket = { t: now, n: 0 };
    if (++ws.bucket.n > 40) return; // flood: silently drop
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object" || Array.isArray(m)) return;

    if (m.t === "auth") {
      const id = String(m.id || "").toUpperCase();
      const u = validId(id) && db.users[id];
      if (!u || !(await verify(unb64(u.sign), m.sig, new TextEncoder().encode("gc2-auth:" + ws.nonce)))) return ws.send(JSON.stringify({ t: "error", error: "auth failed" }));
      ws.uid = id;
      if (!online.has(id)) online.set(id, new Set());
      online.get(id).add(ws);
      ws.send(JSON.stringify({ t: "ready", spk: u.spk && u.spk.id }));
      for (const q of db.queue[id] || []) ws.send(JSON.stringify({ t: "msg", mid: q.mid, env: q.env }));
      return;
    }

    if (m.t === "drop") { // anonymous: no sender recorded anywhere
      const to = String(m.to || "").toUpperCase();
      if (!validId(to) || !db.users[to] || typeof m.env !== "string" || m.env.length > MAX_ENV || typeof m.mid !== "string" || !/^[A-Za-z0-9_-]{8,40}$/.test(m.mid)) {
        return ws.send(JSON.stringify({ t: "error", error: "not delivered", mid: m.mid }));
      }
      const q = (db.queue[to] = db.queue[to] || []);
      if (!q.some((x) => x.mid === m.mid)) {
        // VAPT fix W06: never evict waiting messages. A full queue or a burst refuses NEW drops
        // ("busy"); the sender's app keeps the message and retries later.
        const r = dropRate.get(to) || { t: now, n: 0 }; if (now - r.t > 60000) { r.t = now; r.n = 0; }
        const qBytes = q.reduce((n, x) => n + x.env.length, 0);
        if (++r.n > DROPS_PER_MIN || q.length >= MAX_QUEUE || qBytes + m.env.length > MAX_QUEUE_BYTES || queueBytes + m.env.length > GLOBAL_QUEUE_BYTES) {
          dropRate.set(to, r); return ws.send(JSON.stringify({ t: "error", error: "busy", mid: m.mid }));
        }
        dropRate.set(to, r);
        q.push({ mid: m.mid, env: m.env, exp: now + QUEUE_TTL }); queueBytes += m.env.length; save();
        deliver(to, { t: "msg", mid: m.mid, env: m.env });
      }
      return ws.send(JSON.stringify({ t: "queued", mid: m.mid }));
    }

    if (!ws.uid) return;
    if (m.t === "ack") { // recipient has it: destroy the server copy
      const q = db.queue[ws.uid];
      if (q) { const i = q.findIndex((x) => x.mid === m.mid); if (i >= 0) { queueBytes -= q[i].env.length; q.splice(i, 1); if (!q.length) delete db.queue[ws.uid]; save(); } }
      return;
    }
    if (m.t === "spk") { // rotate signed prekey (forward secrecy)
      const u = db.users[ws.uid];
      if (u && (await spkOk(unb64(u.sign), m.spk))) { u.spk = pubSpk(m.spk); save(); }
      return;
    }
    if (m.t === "delete_account") {
      for (const x of db.queue[ws.uid] || []) queueBytes -= x.env.length;
      delete db.users[ws.uid]; delete db.queue[ws.uid]; save();
      ws.send(JSON.stringify({ t: "deleted" })); ws.close();
    }
  }

  ws.on("close", () => {
    if (ws.uid && online.has(ws.uid)) { online.get(ws.uid).delete(ws); if (!online.get(ws.uid).size) online.delete(ws.uid); }
  });
  ws.on("error", () => {});
});
setInterval(() => {
  const now = Date.now();
  wss.clients.forEach((ws) => {
    if (!ws.uid && now - (ws.last || 0) > IDLE_MS) return ws.terminate(); // silent anonymous sockets
    if (ws.readyState === 1) ws.ping();
  });
}, 25000);
process.on("unhandledRejection", () => {}); // defence in depth: never crash on a stray promise

server.listen(PORT, HOST, () => {
  // The only log line. No requests, IDs or addresses are ever logged.
  console.log(`GhostChat v5 listening on ${HOST}:${PORT} (storage: ${persistent ? "disk" : "RAM only"})`);
});
