// GhostChat v4 client. All cryptography runs here, on the user's device.
//
// Encryption is HYBRID: classic + post-quantum. To read a message an attacker must break BOTH.
//   classic:       ECDH/ECDSA P-384, HKDF-SHA-384, AES-256-GCM   (NSA CNSA suite)
//   post-quantum:  ML-KEM-768 (NIST FIPS 203)                      -> safe against "harvest now, decrypt later"
//
// Message protocol (X3DH-style prekeys + Signal-style sealed sender):
//  * Each user has an identity signing key, an identity DH key, and a signed prekey (P-384 + ML-KEM-768)
//    that rotates every 24 h. Old prekeys are destroyed after 9 days -> forward secrecy.
//  * Every message uses a fresh ephemeral key E and a fresh ML-KEM encapsulation (ss):
//      outer key = HKDF(DH(E,SPK) || ss)                     -> hides the sender's ID from the server
//      inner key = HKDF(DH(E,SPK) || DH(IKd_sender,SPK) || ss) -> proves the sender to the recipient
//  * Everything is padded to fixed sizes; dummy "cover traffic" hides when you really talk.
// Device storage: two identical-looking encrypted vault slots in IndexedDB. One is your account;
// the other is random noise — or a hidden DECOY account opened by a different passcode.
"use strict";
// Apple's WebKit (Onion Browser / every iPhone browser) hides crypto.subtle on http://….onion pages,
// although Tor already encrypts and authenticates .onion connections. There we use our bundled,
// audited implementation (pq.js), which is byte-for-byte compatible with the browser's own.
const IS_ONION = /\.onion$/i.test(location.hostname);
const BUILTIN_CRYPTO = !crypto.subtle && IS_ONION && !!(self.PQ && self.PQ.subtle);
const subtle = crypto.subtle || (BUILTIN_CRYPTO ? self.PQ.subtle : undefined);
const $ = (s) => document.querySelector(s);
const enc = new TextEncoder(), dec = new TextDecoder();

const CURVE = "P-384";
const ECDSA = { name: "ECDSA", namedCurve: CURVE }, ECDH = { name: "ECDH", namedCurve: CURVE }, SIG = { name: "ECDSA", hash: "SHA-384" };
const PBKDF2_ITER = 600000;
const SPK_ROTATE = 24 * 3600e3, SPK_KEEP = 9 * 24 * 3600e3;
const PAD_BUCKETS = [1024, 4096, 16384, 65536, 262144, 524288];
const VAULT_BUCKET = 65536;
const AUTO_LOCK = 3 * 60e3;
const MAX_FAILS = 10;
const MIN_PASS = 10;
// VAPT fix K2: a stolen vault can be attacked offline, so refuse passcodes that are short or trivially guessable
function weakPass(p) {
  if (p.length < MIN_PASS) return `Use at least ${MIN_PASS} characters — a few random words is best`;
  if (/^(.)\1+$/.test(p) || /^(0123456789|1234567890|qwertyuiop|password|asdfghjkl)/i.test(p)) return "Too easy to guess — try a few random words";
  if (new Set(p).size < 5) return "Too repetitive — try a few random words";
  return "";
}
const MAX_PHOTO = 420 * 1024;

// ---------------- byte helpers ----------------
const b64 = (buf) => { const a = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ""; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const bin = atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const rid = (n = 12) => b64(rand(n)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B32 = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function base32(bytes) { let bits = 0, val = 0, out = ""; for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) % B32.length]; bits -= 5; } } return out; }
async function idFromSignKey(raw) { const h = new Uint8Array(await subtle.digest("SHA-384", raw)); return base32(h.slice(0, 10)).slice(0, 16).match(/.{4}/g).join("-"); }
// 16 characters ≈ 79 bits: forging a key that matches someone's ID is out of reach (VAPT fix K1)
const ID_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const ID_FIND = /[A-Z2-9]{4}-?[A-Z2-9]{4}-?[A-Z2-9]{4}-?[A-Z2-9]{4}/;
const GID_RE = /^G[A-Za-z0-9_-]{8,24}$/, MID_RE = /^[A-Za-z0-9_-]{4,40}$/; // VAPT fix C02/C03
const safeMid = (x) => (typeof x === "string" && MID_RE.test(x) ? x : rid(12));

// Proof-of-work for signup (VAPT fix W07): makes creating accounts in bulk expensive.
function sha256(msg) {
  const K = sha256.K || (sha256.K = Uint32Array.from([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]));
  const l = msg.length, nb = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(nb); m.set(msg); m[l] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(nb - 4, l * 8);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let o = 0; o < nb; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const a = w[i - 15], b = w[i - 2]; w[i] = (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) + w[i - 16] + (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)) + w[i - 7]; }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7];
}
function solvePow(sign, bits) {
  const pre = "gc-pow:" + sign + ":";
  for (let n = 0; ; n++) {
    const h = sha256(enc.encode(pre + n.toString(36)))[0];
    if (bits <= 32 ? h >>> (32 - bits) === 0 : false) return n.toString(36);
  }
}

// ---------------- native Android app bridge (absent in a browser) ----------------
// In the Android app the code is bundled INSIDE the app (never downloaded), and the server
// address is configured once. In a browser, the server is wherever the page came from.
const NATIVE = window.GhostNative || null;
const BASE = () => (NATIVE ? String(NATIVE.server() || "").replace(/\/+$/, "") : location.origin);
window.ghostMeshReceive = (to, mid, env) => { if (S && !wiping && to === S.me.id) onEnvelope({ mid, env }, true); };

// ---------------- crypto primitives ----------------
const importPub = (raw, alg, usages = []) => subtle.importKey("raw", raw, alg, false, usages);
const dh = async (priv, pub) => new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: pub }, priv, 384));
async function hkdf(ikm, salt, info) {
  const k = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-384", salt, info: enc.encode(info) }, k, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const aesEnc = async (key, iv, data, aad) => new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, ...(aad ? { additionalData: aad } : {}) }, key, data));
const aesDec = async (key, iv, data, aad) => new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv, ...(aad ? { additionalData: aad } : {}) }, key, data));
// pad to a size bucket (padding lives INSIDE the encryption, so zeros are fine)
function padTo(data, size) { const o = new Uint8Array(size); new DataView(o.buffer).setUint32(0, data.length); o.set(data, 4); return o; }
function pad(str) { const d = enc.encode(str), need = d.length + 4; return padTo(d, PAD_BUCKETS.find((b) => b >= need) || Math.ceil(need / 65536) * 65536); }
function unpadBytes(b) { const n = new DataView(b.buffer, b.byteOffset).getUint32(0); return b.subarray(4, 4 + n); }
const unpad = (b) => dec.decode(unpadBytes(b));
async function randomBytes(n) { // fast, indistinguishable from ciphertext
  const k = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  return aesEnc(k, rand(12), new Uint8Array(Math.max(0, n - 16)));
}

// ---------------- small settings (localStorage) ----------------
const LS = {
  get: (k) => { try { return localStorage.getItem("gc3_" + k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem("gc3_" + k, v); return true; } catch { return false; } },
  del: (k) => { try { localStorage.removeItem("gc3_" + k); } catch {} },
};

// ---------------- vault slots (IndexedDB) ----------------
const IDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open("gc", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => { this.db = r.result; res(this.db); }; r.onerror = () => rej(r.error);
    });
  },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const r = db.transaction("kv").objectStore("kv").get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); },
};
// Some privacy browsers (Onion Browser on iPhone) switch IndexedDB off. Then the (already
// encrypted) vault is kept in localStorage, or — if that's blocked too — only in memory.
const MEM = new Map();
let STORAGE_MODE = window.indexedDB ? "indexeddb" : "local";
const FALLBACK = {
  async get(k) {
    if (STORAGE_MODE === "memory") return MEM.get(k);
    try { const v = localStorage.getItem("gc3_vault_" + k); return v ? fromB64Blob(v) : undefined; } catch { STORAGE_MODE = "memory"; return MEM.get(k); }
  },
  async set(k, v) {
    if (STORAGE_MODE !== "memory") { try { localStorage.setItem("gc3_vault_" + k, toB64Blob(v)); return; } catch { STORAGE_MODE = "memory"; } }
    MEM.set(k, v);
  },
};
if (!window.indexedDB) { IDB.get = FALLBACK.get; IDB.set = FALLBACK.set; }
let S = null, vaultKey = null, vaultSalt = null, slot = "a"; // S = decrypted state, memory only
const otherSlot = () => (slot === "a" ? "b" : "a");
async function deriveVaultKey(pass, salt, iter) {
  const base = await subtle.importKey("raw", enc.encode(pass.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-384" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function sealVault(state = S, key = vaultKey, salt = vaultSalt) {
  const data = enc.encode(JSON.stringify(state)), iv = rand(12);
  const ct = await aesEnc(key, iv, padTo(data, Math.ceil((data.length + 4) / VAULT_BUCKET) * VAULT_BUCKET), enc.encode("gc3-vault"));
  return { v: 3, salt, iter: PBKDF2_ITER, iv, ct };
}
async function openVault(blob, pass) {
  const key = await deriveVaultKey(pass, blob.salt, blob.iter);
  const pt = await aesDec(key, blob.iv, blob.ct, enc.encode("gc3-vault")); // throws on wrong passcode / dummy slot
  return { state: JSON.parse(dec.decode(unpadBytes(pt))), key, salt: blob.salt };
}
const dummyLike = async (ctLen) => ({ v: 3, salt: rand(16), iter: PBKDF2_ITER, iv: rand(12), ct: await randomBytes(ctLen) });
async function writeVault() {
  const blob = await sealVault();
  if (!S || wiping) return;
  await IDB.set(slot, blob);
  // keep the empty slot the same size as the real one, so nobody can tell which slot is used
  if (S.settings.other === "dummy") await IDB.set(otherSlot(), await dummyLike(blob.ct.length));
}
let saveT = null, saving = Promise.resolve();
function persist() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { saving = saving.then(() => (S && !wiping ? writeVault() : null)).catch(() => toast("Couldn't save — device storage full?")); }, 250);
}
async function flush() { clearTimeout(saveT); await saving; if (S && !wiping) await writeVault(); }
const toB64Blob = (b) => JSON.stringify({ v: 3, salt: b64(b.salt), iter: b.iter, iv: b64(b.iv), ct: b64(b.ct) });
const fromB64Blob = (s) => { const j = JSON.parse(s); return { v: 3, salt: unb64(j.salt), iter: j.iter, iv: unb64(j.iv), ct: unb64(j.ct) }; };

// ---------------- identity & prekeys ----------------
let K = null; // live keys: {sign, ecdh, spk: Map(id -> {ecdh, kem})}
async function genSpk() {
  const kp = await subtle.generateKey(ECDH, true, ["deriveBits"]);
  const pub = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  const pq = PQ.kem.keygen();
  const id = rid(9);
  const sig = await subtle.sign(SIG, K.sign, concat(enc.encode(id), pub, pq.publicKey));
  return { id, priv: await subtle.exportKey("jwk", kp.privateKey), pub: b64(pub), kem: b64(pq.publicKey), kemPriv: b64(pq.secretKey), sig: b64(sig), created: Date.now() };
}
const spkPublic = (s) => ({ id: s.id, pub: s.pub, kem: s.kem, sig: s.sig });
async function newIdentity(name) {
  const s = await subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  const e = await subtle.generateKey(ECDH, true, ["deriveBits"]);
  const signPub = new Uint8Array(await subtle.exportKey("raw", s.publicKey)), ecdhPub = new Uint8Array(await subtle.exportKey("raw", e.publicKey));
  K = { sign: s.privateKey, ecdh: e.privateKey, spk: new Map() };
  const me = {
    name, id: await idFromSignKey(signPub),
    signPriv: await subtle.exportKey("jwk", s.privateKey), ecdhPriv: await subtle.exportKey("jwk", e.privateKey),
    signPub: b64(signPub), ecdhPub: b64(ecdhPub), sig: b64(await subtle.sign(SIG, s.privateKey, ecdhPub)),
  };
  const state = { v: 4, me, spks: [], contacts: {}, msgs: {}, outbox: [], settings: { burnRemote: true, cover: true } };
  state.spks.push(await genSpk());
  return state;
}
async function loadKeys() {
  K = {
    sign: await subtle.importKey("jwk", S.me.signPriv, ECDSA, false, ["sign"]),
    ecdh: await subtle.importKey("jwk", S.me.ecdhPriv, ECDH, false, ["deriveBits"]),
    spk: new Map(),
  };
}
async function spkPriv(id) {
  if (K.spk.has(id)) return K.spk.get(id);
  const s = S.spks.find((x) => x.id === id); if (!s) return null;
  const k = { ecdh: await subtle.importKey("jwk", s.priv, ECDH, false, ["deriveBits"]), kem: unb64(s.kemPriv) };
  K.spk.set(id, k); return k;
}
async function register(state = S) {
  const cur = state.spks[state.spks.length - 1];
  if (!state.me.pow) { state.me.pow = solvePow(state.me.signPub, 18); if (state === S) persist(); } // solved once per account
  const send = () => fetch(BASE() + "/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sign: state.me.signPub, ecdh: state.me.ecdhPub, sig: state.me.sig, spk: spkPublic(cur), pow: state.me.pow }) });
  let r = await send(), j = await r.json().catch(() => ({}));
  if (r.status === 400 && j.bits) { await sleep(0); state.me.pow = solvePow(state.me.signPub, j.bits); if (state === S) persist(); r = await send(); j = await r.json().catch(() => ({})); }
  if (r.status === 503) throw new Error("The server is full right now — try again later");
  if (!r.ok || j.id !== state.me.id) throw new Error("Couldn't reach the server");
}
async function maintainKeys() {
  const now = Date.now(); let changed = false;
  const cur = S.spks[S.spks.length - 1];
  if (!cur || now - cur.created > SPK_ROTATE) {
    const s = await genSpk(); S.spks.push(s); changed = true;
    if (ready) inbox.send(JSON.stringify({ t: "spk", spk: spkPublic(s) }));
  }
  const before = S.spks.length;
  S.spks = S.spks.filter((s, i) => i === S.spks.length - 1 || now - s.created < SPK_KEEP); // destroy old prekeys
  if (S.spks.length !== before) { K.spk.clear(); changed = true; }
  if (changed) persist();
}

// ---------------- contacts' keys (verified) ----------------
async function fetchVerifiedKeys(id) {
  const r = await fetch(BASE() + "/api/keys/" + encodeURIComponent(id));
  if (!r.ok) throw new Error("No user with that ID");
  const k = await r.json();
  const signRaw = unb64(k.sign);
  if ((await idFromSignKey(signRaw)) !== id) throw new Error("Key mismatch — possible tampering");
  const sk = await importPub(signRaw, ECDSA, ["verify"]);
  if (!(await subtle.verify(SIG, sk, unb64(k.sig), unb64(k.ecdh)))) throw new Error("Bad identity signature — possible tampering");
  if (!k.spk || !k.spk.kem || !(await subtle.verify(SIG, sk, unb64(k.spk.sig), concat(enc.encode(k.spk.id), unb64(k.spk.pub), unb64(k.spk.kem))))) throw new Error("Bad prekey signature — possible tampering");
  return { sign: k.sign, ecdh: k.ecdh, spk: { id: k.spk.id, pub: k.spk.pub, kem: k.spk.kem }, spkAt: Date.now() };
}
async function freshSpk(c) {
  if (!c.spk || Date.now() - (c.spkAt || 0) > 10 * 60e3) {
    const k = await fetchVerifiedKeys(c.id);
    if (k.sign !== c.sign || k.ecdh !== c.ecdh) throw new Error("This contact's identity changed — not sending");
    c.spk = k.spk; c.spkAt = k.spkAt; if (c.id !== S.me.id) persist();
  }
  return c.spk;
}
const selfContact = () => { const s = S.spks[S.spks.length - 1]; return { id: S.me.id, sign: S.me.signPub, ecdh: S.me.ecdhPub, spk: { id: s.id, pub: s.pub, kem: s.kem }, spkAt: Date.now() }; };

// ---------------- Double Ratchet (Signal-style: a new key for EVERY message) ----------------
// Each contact pair keeps a ratchet session. Every message advances a chain (new message key,
// old one destroyed) and every reply performs a fresh Diffie-Hellman step. Result:
//  * forward secrecy per message  — stealing today's keys can't decrypt yesterday's messages
//  * post-compromise security     — after a stolen key, the chat "heals" within one round trip
// The session is started from the hybrid (P-384 + ML-KEM-768) prekey handshake, and every message
// still travels inside the post-quantum sealed-sender envelope.
async function hmac48(key, byte) { const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-384" }, false, ["sign"]); return new Uint8Array(await subtle.sign("HMAC", k, new Uint8Array([byte]))); }
async function kdfCK(ckB64) { const ck = unb64(ckB64); return [b64((await hmac48(ck, 2)).slice(0, 32)), (await hmac48(ck, 1)).slice(0, 32)]; } // [next chain, message key]
async function hkdfBits(ikm, salt, info, bits) { const k = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]); return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-384", salt, info: enc.encode(info) }, k, bits)); }
async function kdfRK(rkB64, dhOut) { const o = await hkdfBits(dhOut, unb64(rkB64), "gc4-ratchet", 512); return [b64(o.slice(0, 32)), b64(o.slice(32))]; }
async function genDH() { const kp = await subtle.generateKey(ECDH, true, ["deriveBits"]); return { pub: b64(await subtle.exportKey("raw", kp.publicKey)), priv: await subtle.exportKey("jwk", kp.privateKey) }; }
async function dhJ(privJwk, pubB64) { return dh(await subtle.importKey("jwk", privJwk, ECDH, false, ["deriveBits"]), await importPub(unb64(pubB64), ECDH)); }
const mkKey = (mk) => subtle.importKey("raw", mk, "AES-GCM", false, ["encrypt", "decrypt"]);
const MAX_SKIP = 300;
const locks = {};
function withLock(id, fn) { const p = (locks[id] || Promise.resolve()).then(fn, fn); locks[id] = p.catch(() => {}); return p; }
const sessFor = (cid) => (S.sessions = S.sessions || {})[cid] || (S.sessions[cid] = { active: null, s: {} });
async function skipKeys(st, until) {
  if (!st.CKr) return;
  if (until - st.Nr > MAX_SKIP) throw new Error("too many skipped");
  while (st.Nr < until) { const [ck, mk] = await kdfCK(st.CKr); st.CKr = ck; st.skipped[st.DHr + "|" + st.Nr] = b64(mk); st.Nr++; }
  const ks = Object.keys(st.skipped); if (ks.length > 500) for (const k of ks.slice(0, ks.length - 500)) delete st.skipped[k];
}
async function ratchetStep(st, theirDh) {
  st.PN = st.Ns; st.Ns = 0; st.Nr = 0; st.DHr = theirDh;
  [st.RK, st.CKr] = await kdfRK(st.RK, await dhJ(st.DHs.priv, st.DHr));
  st.DHs = await genDH();
  [st.RK, st.CKs] = await kdfRK(st.RK, await dhJ(st.DHs.priv, st.DHr));
}
const x3dhSK = (dh1, dh2, ss, ephRaw) => hkdfBits(concat(dh1, dh2, ss), ephRaw, "gc4-x3dh", 256);

// ---------------- seal / unseal (hybrid PQ sealed sender + ratchet) ----------------
// mode "x": one-shot (cover traffic to yourself).  mode "r": ratchet message to a contact.
async function seal(c, body) {
  const spk = await freshSpk(c);
  const spkPub = await importPub(unb64(spk.pub), ECDH);
  const eph = await subtle.generateKey(ECDH, false, ["deriveBits"]);
  const ephRaw = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
  const { cipherText: kct, sharedSecret: ss } = PQ.kem.encapsulate(unb64(spk.kem));
  const dh1 = await dh(eph.privateKey, spkPub);
  const route = S.me.id + ">" + c.id;
  let inner;
  if (c.id === S.me.id) {
    const dh2 = await dh(K.ecdh, spkPub), iv = rand(12);
    const ct = await aesEnc(await hkdf(concat(dh1, dh2, ss), ephRaw, "gc3-inner|" + route), iv, enc.encode(JSON.stringify(body)), enc.encode(route));
    inner = { m: "x", iv: b64(iv), ct: b64(ct) };
  } else {
    inner = await withLock(c.id, async () => {
      const ss_ = sessFor(c.id);
      let st = ss_.active && ss_.s[ss_.active];
      if (!st) { // start a new session from this envelope's handshake
        const sk = await x3dhSK(dh1, await dh(K.ecdh, spkPub), ss, ephRaw);
        st = { sid: rid(9), RK: b64(sk), DHs: await genDH(), DHr: spk.pub, CKr: null, Ns: 0, Nr: 0, PN: 0, skipped: {}, init: { spk: spk.id, e: b64(ephRaw), q: b64(kct) }, created: Date.now() };
        [st.RK, st.CKs] = await kdfRK(st.RK, await dhJ(st.DHs.priv, st.DHr));
        ss_.s[st.sid] = st; ss_.active = st.sid;
      }
      const [ck, mk] = await kdfCK(st.CKs); st.CKs = ck;
      const h = { sid: st.sid, dh: st.DHs.pub, n: st.Ns, pn: st.PN, ...(st.init ? { init: st.init } : {}) };
      st.Ns++;
      const iv = rand(12);
      const ct = await aesEnc(await mkKey(mk), iv, enc.encode(JSON.stringify(body)), enc.encode(route + JSON.stringify(h)));
      persist();
      return { m: "r", h, iv: b64(iv), ct: b64(ct) };
    });
  }
  const outerKey = await hkdf(concat(dh1, ss), ephRaw, "gc3-outer");
  const iv1 = rand(12);
  const outer = await aesEnc(outerKey, iv1, pad(JSON.stringify({ from: S.me.id, ...inner })), concat(ephRaw, kct));
  return JSON.stringify({ v: 4, spk: spk.id, e: b64(ephRaw), q: b64(kct), iv: b64(iv1), ct: b64(outer) });
}
async function unseal(envStr) {
  const env = JSON.parse(envStr);
  const priv = await spkPriv(env.spk); if (!priv) throw new Error("expired prekey");
  const ephRaw = unb64(env.e), kct = unb64(env.q);
  const ss = PQ.kem.decapsulate(kct, priv.kem);
  const dh1 = await dh(priv.ecdh, await importPub(ephRaw, ECDH));
  const outer = JSON.parse(unpad(await aesDec(await hkdf(concat(dh1, ss), ephRaw, "gc3-outer"), unb64(env.iv), unb64(env.ct), concat(ephRaw, kct))));
  const from = String(outer.from || "");
  if (!ID_RE.test(from)) throw new Error("bad sender");
  const route = from + ">" + S.me.id;
  if (outer.m === "x") {
    if (from !== S.me.id) throw new Error("one-shot only for self");
    const dh2 = await dh(priv.ecdh, await importPub(unb64(S.me.ecdhPub), ECDH));
    JSON.parse(dec.decode(await aesDec(await hkdf(concat(dh1, dh2, ss), ephRaw, "gc3-inner|" + route), unb64(outer.iv), unb64(outer.ct), enc.encode(route))));
    return { self: true };
  }
  if (outer.m !== "r" || from === S.me.id) throw new Error("bad mode");
  const known = S.contacts[from] || (S.hidden || {})[from];
  const keys = known || (await fetchVerifiedKeys(from));
  const h = outer.h || {};
  const body = await withLock(from, async () => {
    const ss_ = sessFor(from);
    let st = ss_.s[h.sid] ? structuredClone(ss_.s[h.sid]) : null;
    if (!st) {
      if (!h.init) { const e = new Error("unknown session"); e.heal = from; throw e; }
      const sp = S.spks.find((x) => x.id === h.init.spk); if (!sp) { const e = new Error("expired prekey"); e.heal = from; throw e; }
      const p0 = await spkPriv(sp.id), e0 = unb64(h.init.e);
      const sk = await x3dhSK(await dh(p0.ecdh, await importPub(e0, ECDH)), await dh(p0.ecdh, await importPub(unb64(keys.ecdh), ECDH)), PQ.kem.decapsulate(unb64(h.init.q), p0.kem), e0);
      st = { sid: h.sid, RK: b64(sk), DHs: { pub: sp.pub, priv: sp.priv }, DHr: null, CKs: null, CKr: null, Ns: 0, Nr: 0, PN: 0, skipped: {}, created: Date.now() };
    }
    let mk = null; const sk = h.dh + "|" + h.n;
    if (st.skipped[sk]) { mk = unb64(st.skipped[sk]); delete st.skipped[sk]; }
    else {
      if (h.dh !== st.DHr) { await skipKeys(st, h.pn); await ratchetStep(st, h.dh); }
      await skipKeys(st, h.n);
      const [ck, m2] = await kdfCK(st.CKr); st.CKr = ck; st.Nr++; mk = m2;
    }
    let pt;
    try { pt = await aesDec(await mkKey(mk), unb64(outer.iv), unb64(outer.ct), enc.encode(route + JSON.stringify(h))); }
    catch { throw new Error("bad message"); } // replay or forgery: drop silently, never reset the session
    delete st.init;               // they replied on it: stop sending the handshake
    ss_.s[st.sid] = st; ss_.active = st.sid; // the session we last heard on becomes the one we send on
    const ids = Object.keys(ss_.s); // keep only the 3 newest sessions
    if (ids.length > 3) ids.sort((a, b) => ss_.s[a].created - ss_.s[b].created).slice(0, ids.length - 3).forEach((id) => delete ss_.s[id]);
    persist();
    return JSON.parse(dec.decode(pt));
  });
  const isNew = !known;
  return { from, keys, body, isNew };
}
// A session broke (e.g. restored an old backup): drop it and start fresh so the chat heals.
const healAt = {};
async function heal(cid) {
  if (!S || Date.now() - (healAt[cid] || 0) < 60e3) return; healAt[cid] = Date.now();
  const c = S.contacts[cid] || (S.hidden || {})[cid]; if (!c) return;
  // VAPT fix C05: anyone can forge the outer "from" field, so never delete sessions here.
  // Keep them (in-flight messages still decrypt) and simply open a new one alongside.
  if (S.sessions && S.sessions[cid]) S.sessions[cid].active = null;
  post(c, { k: "heal", mid: rid() }).catch(() => {});
}

// ---------------- network ----------------
let inbox = null, drop = null, ready = false, dropReady = false, retry = 1000;
const wsUrl = () => BASE().replace(/^http/, "ws") + "/ws";
function connect() {
  if (!S) return;
  inbox = new WebSocket(wsUrl());
  inbox.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "challenge") {
      const sig = await subtle.sign(SIG, K.sign, enc.encode("gc2-auth:" + m.nonce));
      inbox.send(JSON.stringify({ t: "auth", id: S.me.id, sig: b64(sig) }));
    } else if (m.t === "ready") {
      ready = true; retry = 1000; setConn();
      const cur = S.spks[S.spks.length - 1];
      if (m.spk !== cur.id) inbox.send(JSON.stringify({ t: "spk", spk: spkPublic(cur) }));
    } else if (m.t === "msg") onEnvelope(m);
    else if (m.t === "deleted") { if (onDeleted) onDeleted(); }
    else if (m.t === "error" && m.error === "auth failed") register().then(() => inbox.close()).catch(() => {}); // RAM-only server restarted
  };
  inbox.onclose = () => { ready = false; setConn(); if (S && !wiping) setTimeout(connect, retry); retry = Math.min(retry * 2, 8000); };
}
function connectDrop() {
  drop = new WebSocket(wsUrl());
  drop.onopen = () => { dropReady = true; setConn(); flushOutbox(); };
  drop.onmessage = (ev) => {
    const m = JSON.parse(ev.data); if (!S) return;
    const i = S.outbox.findIndex((o) => o.mid === m.mid); if (i < 0) return;
    if (m.t === "error" && m.error === "busy") { clearTimeout(retryT); retryT = setTimeout(flushOutbox, 30e3 + Math.random() * 30e3); return; }
    const o = S.outbox.splice(i, 1)[0];
    if (o.local) setStatus(o.conv || o.to, o.local, m.t === "queued" ? "sent" : "failed");
    persist();
  };
  drop.onclose = () => { dropReady = false; setConn(); if (S && !wiping) setTimeout(connectDrop, 1500 + Math.random() * 2000); };
}
let retryT = null;
const dropSend = (o) => drop.send(JSON.stringify({ t: "drop", to: o.to, mid: o.mid, env: o.env }));
function flushOutbox() { if (dropReady && S) S.outbox.forEach(dropSend); }
function setConn() { const c = $("#conn"); const on = ready && dropReady; c.classList.toggle("off", !on); c.title = on ? "Connected" : "Connecting…"; }

// Cover traffic: at random moments, send yourself a dummy message. It looks exactly like a
// real one to the server (same padding, same path), so your real activity hides in the noise.
let noiseT = null;
function scheduleNoise() {
  clearTimeout(noiseT);
  noiseT = setTimeout(async () => {
    try {
      if (S && !wiping && S.settings.cover !== false && dropReady && ready) {
        dropSend({ to: S.me.id, mid: rid(16), env: await seal(selfContact(), { k: "noise", n: rid(8) }) });
      }
    } catch {}
    scheduleNoise();
  }, 15e3 + Math.random() * 75e3);
}

// ---------------- messaging (1-to-1 and groups) ----------------
// A conversation id is either a contact ID (XXXX-XXXX-XXXX) or a group id ("G…").
// Groups are end-to-end encrypted by "fan-out": each message is sealed separately for every member
// through that member's own ratchet session, so the server can't even tell a group exists.
const msgs = (id) => (S.msgs[id] = S.msgs[id] || []);
const isGroup = (id) => typeof id === "string" && GID_RE.test(id);
const conv = (id) => (isGroup(id) ? (S.groups || {})[id] : S.contacts[id]);
const peer = (id) => S.contacts[id] || (S.hidden || {})[id];
const displayName = (c) => (c.gid ? c.name || "Group" : c.customName || c.name || "Anonymous " + c.id.slice(0, 4));
const memberName = (id) => (id === S.me.id ? "You" : peer(id) ? displayName(peer(id)) : "Anonymous " + id.slice(0, 4));
const preview = (m) => (m.kind === "img" ? (m.once ? "📷 View-once photo" : "📷 Photo") : m.text);
async function ensurePeer(id) {
  if (id === S.me.id || peer(id)) return peer(id);
  S.hidden = S.hidden || {};
  S.hidden[id] = { id, ...(await fetchVerifiedKeys(id)), name: "" };
  return S.hidden[id];
}
const others = (g) => g.members.filter((x) => x !== S.me.id);
async function post(c, body, local, convId) {
  const o = { to: c.id, mid: rid(16), env: await seal(c, body), local, conv: convId || c.id };
  S.outbox.push(o); persist();
  if (dropReady) dropSend(o);
  if (window.GhostNative && GhostNative.meshSend) try { GhostNative.meshSend(o.to, o.mid, o.env); } catch {} // offline Bluetooth path
}
async function fanout(g, body, local) { // send to every other member of a group
  await Promise.all(others(g).map(async (id) => { try { await post(await ensurePeer(id), body, local, g.gid); } catch {} }));
}
async function sendBody(id, local, body, msg) {
  const c = conv(id); if (!c) return;
  msgs(id).push(msg);
  c.last = { text: preview(msg), ts: msg.ts, me: true }; c.request = false; persist();
  renderMessages(); renderList();
  try {
    if (isGroup(id)) { if (!others(c).length) setStatus(id, local, "sent"); await fanout(c, { ...body, gid: id }, local); }
    else await post(c, body, local);
  } catch (e) { setStatus(id, local, "failed"); toast(e.message); }
}
async function sendText(text) {
  const c = conv(current); if (!c) return;
  const ts = Date.now(), local = rid(12), timer = c.timer || 0;
  await sendBody(current, local, { k: "text", mid: local, text, name: S.me.name, ts, timer }, { mid: local, me: true, text, ts, status: "sending", exp: timer ? ts + timer : 0 });
}
async function sendPhoto(id, photo, once) {
  const c = conv(id); if (!c) return;
  const ts = Date.now(), local = rid(12), timer = c.timer || 0;
  const body = { k: "img", mid: local, data: photo.data, w: photo.w, h: photo.h, once, name: S.me.name, ts, timer };
  await sendBody(id, local, body, { mid: local, me: true, kind: "img", once, data: once ? null : photo.data, w: photo.w, h: photo.h, ts, status: "sending", exp: timer ? ts + timer : 0 });
}

// group admin actions — only the admin's group "state" messages are accepted by members
async function pushGroupState(g, extraTo = []) {
  g.v = (g.v || 0) + 1;
  const st = { k: "gstate", gid: g.gid, name: g.name, members: g.members, admin: g.admin, timer: g.timer || 0, v: g.v, name_: S.me.name };
  await Promise.all([...new Set([...others(g), ...extraTo])].map(async (id) => { try { await post(await ensurePeer(id), { ...st, name: g.name, mid: rid() }, null, g.gid); } catch {} }));
}
async function createGroup(name, ids) {
  for (const id of ids) await ensurePeer(id);
  const gid = "G" + rid(12);
  S.groups = S.groups || {};
  const g = (S.groups[gid] = { gid, name, members: [S.me.id, ...ids], admin: S.me.id, timer: 0, v: 0, unread: 0, added: Date.now() });
  msgs(gid).push({ mid: rid(), sys: true, text: `You created "${name}"`, ts: Date.now() });
  persist(); await pushGroupState(g); renderList(); openChat(gid);
}
const sysMsg = (id, text) => msgs(id).push({ mid: rid(), sys: true, text, ts: Date.now() });

async function onEnvelope(m, viaMesh) {
  let res;
  try { res = await unseal(m.env); }
  catch (e) { if (!viaMesh) inbox.send(JSON.stringify({ t: "ack", mid: m.mid })); if (e && e.heal) heal(e.heal); return; }
  if (!viaMesh) inbox.send(JSON.stringify({ t: "ack", mid: m.mid }));
  if (res.self) return; // cover traffic: discard
  const { from, keys, body } = res;
  const k = body.k;
  const nm = typeof body.name_ === "string" ? body.name_ : typeof body.name === "string" ? body.name : "";
  // group traffic doesn't create a 1-to-1 chat; it only remembers the member's keys
  const groupish = ["gstate", "gleave"].includes(k) || (body.gid && isGroup(body.gid));
  let c = peer(from);
  if (!c) {
    if (groupish) { S.hidden = S.hidden || {}; c = S.hidden[from] = { id: from, ...keys, name: "" }; }
    else c = S.contacts[from] = { id: from, ...keys, name: "", request: true, timer: 0, unread: 0, added: Date.now() };
  }
  if (nm && !(groupish && k === "gstate")) c.name = nm.slice(0, 30);
  if (k === "gstate" && body.name_) c.name = String(body.name_).slice(0, 30);
  if (k === "heal") { persist(); return; }
  if (k === "burn") { // their panic button: erase them everywhere
    delete S.contacts[from]; delete S.msgs[from]; if (S.hidden) delete S.hidden[from]; if (S.sessions) delete S.sessions[from];
    for (const g of Object.values(S.groups || {})) { S.msgs[g.gid] = msgs(g.gid).filter((x) => x.from !== from); g.members = g.members.filter((x) => x !== from); }
    if (current === from) closeChat(); persist(); renderList(); if (current) renderMessages(); return;
  }
  const cid = body.gid && isGroup(body.gid) ? body.gid : from;
  if (k === "rcpt") { for (const id of [].concat(body.mids || []).slice(0, 50)) if (typeof id === "string" && MID_RE.test(id)) markDelivered(cid, id, from); persist(); return; }

  if (k === "gstate") {
    if (!isGroup(body.gid) || !Array.isArray(body.members) || body.members.length > 256 || body.admin !== from) return;
    S.groups = S.groups || {};
    const g = S.groups[body.gid];
    if (g && g.admin !== from) return;            // only the admin may change a group
    if (g && (+body.v || 0) <= (g.v || 0)) return; // stale
    const members = body.members.filter((x) => ID_RE.test(x)).slice(0, 256);
    if (!members.includes(S.me.id)) { if (g) { sysMsg(g.gid, "You were removed from this group"); g.members = []; g.removed = true; } persist(); renderList(); if (current === body.gid) renderMessages(); return; }
    const name = String(body.name || "Group").slice(0, 40), timer = TIMERS.some((t) => t[0] === +body.timer) ? +body.timer : 0;
    if (!g) {
      S.groups[body.gid] = { gid: body.gid, name, members, admin: from, timer, v: +body.v, unread: 1, request: !S.contacts[from], added: Date.now() };
      sysMsg(body.gid, `${displayName(c)} added you to "${name}"`);
    } else {
      const added = members.filter((x) => !g.members.includes(x)), gone = g.members.filter((x) => !members.includes(x));
      if (g.name !== name) sysMsg(g.gid, `Group renamed to "${name}"`);
      if (added.length) sysMsg(g.gid, `${added.map(memberName).join(", ")} joined`);
      if (gone.length) sysMsg(g.gid, `${gone.map(memberName).join(", ")} left`);
      if ((g.timer || 0) !== timer) sysMsg(g.gid, timer ? `Disappearing messages: ${timerLabel(timer)}` : "Disappearing messages off");
      Object.assign(g, { name, members, timer, v: +body.v });
    }
    for (const id of members) ensurePeer(id).catch(() => {});
    persist(); renderList(); if (current === body.gid) renderMessages(); return;
  }
  if (k === "gleave") {
    const g = (S.groups || {})[body.gid]; if (!g || !g.members.includes(from)) return;
    g.members = g.members.filter((x) => x !== from);
    if (g.admin === from) g.admin = g.members[0] || null; // next member becomes admin
    sysMsg(g.gid, `${displayName(c)} left`); persist(); renderList(); if (current === g.gid) renderMessages(); return;
  }

  const target = conv(cid);
  if (!target) return;
  if (isGroup(cid) && !target.members.includes(from)) return; // not a member: ignore
  const list = msgs(cid), mid = safeMid(body.mid);
  if (list.some((x) => x.mid === mid)) return;
  const ts = Date.now(), timer = +body.timer || 0, exp = timer ? ts + timer : 0;
  let msg;
  if (k === "timer" && !isGroup(cid)) {
    target.timer = TIMERS.some((t) => t[0] === +body.timer) ? +body.timer : 0;
    list.push({ mid, sys: true, text: target.timer ? `${displayName(c)} turned on disappearing messages (${timerLabel(target.timer)})` : `${displayName(c)} turned off disappearing messages`, ts });
  } else if (k === "text") msg = { mid, from, me: false, text: String(body.text || "").slice(0, 4000), ts, exp };
  else if (k === "img" && typeof body.data === "string" && body.data.length < 700000) msg = { mid, from, me: false, kind: "img", data: body.data, once: !!body.once, w: +body.w || 0, h: +body.h || 0, ts, exp };
  else return;
  if (msg) {
    list.push(msg); target.last = { text: (isGroup(cid) ? displayName(c) + ": " : "") + preview(msg), ts, me: false };
    if (current !== cid || document.hidden) { target.unread = (target.unread || 0) + 1; notify(); }
    post(c, { k: "rcpt", mids: [mid], ...(isGroup(cid) ? { gid: cid } : {}) }, null, cid).catch(() => {});
  }
  persist(); renderList(); if (current === cid) renderMessages();
}
function markDelivered(cid, mid, by) {
  const m = S && msgs(cid).find((x) => x.mid === mid); if (!m || !m.me) return;
  if (isGroup(cid)) {
    m.dl = [...new Set([...(m.dl || []), by])];
    const g = conv(cid); if (g && others(g).every((x) => m.dl.includes(x))) m.status = "delivered";
    else if (m.status !== "delivered") m.status = "sent";
  } else m.status = "delivered";
  if (current === cid) renderMessages();
}
function setStatus(cid, mid, status, quiet) {
  const m = S && msgs(cid).find((x) => x.mid === mid); if (!m || m.status === "delivered") return;
  if (status === "sent" && m.status === "failed") return;
  m.status = status; if (!quiet) persist();
  if (current === cid) renderMessages();
}
function notify() {
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    try { new Notification(LS.get("disguise") ? "Calculator" : "GhostChat", { body: "New activity", tag: "gc" }); } catch {}
  }
}
function sweep() {
  if (!S) return; const now = Date.now(); let changed = false;
  for (const id of Object.keys(S.msgs)) {
    const list = S.msgs[id], kept = list.filter((m) => !m.exp || m.exp > now);
    if (kept.length !== list.length) {
      S.msgs[id] = kept; changed = true;
      const c = conv(id); const l = [...kept].reverse().find((x) => !x.sys);
      if (c) c.last = l ? { text: preview(l), ts: l.ts, me: l.me } : null;
    }
  }
  if (changed) { persist(); renderList(); if (current) renderMessages(); }
}

// ---------------- photos: re-encoding strips ALL metadata (GPS, camera, time) ----------------
async function processImage(file) {
  if (!file || !file.type.startsWith("image/")) throw new Error("Choose a photo");
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  let max = 1600, q = 0.78, out = null, w = 0, h = 0;
  for (let i = 0; i < 6; i++) {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    w = Math.round(bmp.width * s); h = Math.round(bmp.height * s);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
    out = new Uint8Array(await (await new Promise((r) => cv.toBlob(r, "image/jpeg", q))).arrayBuffer());
    if (out.length <= MAX_PHOTO) break;
    max = Math.round(max * 0.8); q = Math.max(0.5, q - 0.08);
  }
  bmp.close && bmp.close();
  if (out.length > MAX_PHOTO) throw new Error("Photo too large");
  return { data: b64(out), w, h };
}
const urlCache = new Map();
function photoUrl(mid, data) {
  if (!urlCache.has(mid)) urlCache.set(mid, URL.createObjectURL(new Blob([unb64(data)], { type: "image/jpeg" })));
  return urlCache.get(mid);
}
function photoDialog(file) {
  const id = current; if (!conv(id)) return;
  processImage(file).then((photo) => {
    modal("Send photo", `<img class="pv" id="pv" alt="" /><p class="muted small">Location, camera model and time stamps are removed.</p><label class="opt"><input type="checkbox" id="once" /> View once — disappears after it's opened</label>`,
      [["Send", () => sendPhoto(id, photo, $("#once").checked), "primary"], ["Cancel", () => {}]]);
    $("#pv").src = URL.createObjectURL(new Blob([unb64(photo.data)], { type: "image/jpeg" }));
  }).catch((e) => toast(e.message || "Couldn't read photo"));
}
function viewPhoto(mid) {
  const m = msgs(current).find((x) => x.mid === mid); if (!m || !m.data) return;
  const v = $("#viewer"); $("#viewer-img").src = photoUrl(mid, m.data); v.classList.remove("hidden");
  v.onclick = () => {
    v.classList.add("hidden"); $("#viewer-img").removeAttribute("src");
    if (m.once && !m.me) { // view-once: destroy after viewing
      URL.revokeObjectURL(urlCache.get(mid)); urlCache.delete(mid);
      m.data = null; m.opened = true; persist(); renderMessages();
    }
  };
}

// ---------------- UI ----------------
let current = null;
const colorClass = (id) => "c" + ([...id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 8);
const initials = (c) => { const n = displayName(c); return n.startsWith("Anonymous") ? "?" : n.trim().slice(0, 1).toUpperCase(); };
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  return d.toDateString() === y.toDateString() ? "Yesterday" : d.toLocaleDateString([], { day: "numeric", month: "short" });
}
function show(id) { for (const s of ["onboard", "lock", "main", "calc"]) $("#" + s).classList.toggle("hidden", s !== id); }

function renderList() {
  if (!S) return;
  const q = $("#search").value.trim().toLowerCase();
  const all = [...Object.values(S.contacts), ...Object.values(S.groups || {})];
  const items = all.filter((c) => !q || displayName(c).toLowerCase().includes(q) || (c.id || "").toLowerCase().includes(q))
    .sort((a, b) => (b.last?.ts || b.added || 0) - (a.last?.ts || a.added || 0));
  $("#empty-list").classList.toggle("hidden", all.length > 0);
  $("#chat-list").innerHTML = items.map((c) => { const key = c.gid || c.id; return `
    <div class="chat-item ${key === current ? "active" : ""}" data-id="${esc(key)}">
      <div class="avatar ${colorClass(key)}">${c.gid ? "👥" : esc(initials(c))}</div>
      <div class="meta">
        <div class="row"><span class="name">${esc(displayName(c))}${c.request ? '<span class="tag">new</span>' : ""}</span><span class="time">${c.last ? fmtTime(c.last.ts) : ""}</span></div>
        <div class="row"><span class="last">${c.last ? (c.last.me ? "You: " : "") + esc(c.last.text) : '<span class="muted">' + (c.gid ? c.members.length + " members" : c.id) + "</span>"}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ""}</div>
      </div>
    </div>`; }).join("");
}
function headerFor(c) {
  const key = c.gid || c.id;
  const av = $("#chat-avatar"); av.className = "avatar " + colorClass(key); av.textContent = c.gid ? "👥" : initials(c);
  $("#chat-name").textContent = displayName(c);
  $("#chat-sub").textContent = (c.gid ? c.members.map(memberName).join(", ") : c.id) + (c.timer ? " · ⏱ " + timerLabel(c.timer) : "");
}
function openChat(id) {
  current = id; const c = conv(id); c.unread = 0; persist();
  $("#main").classList.add("in-chat"); $("#no-chat").classList.add("hidden"); $("#chat").classList.remove("hidden");
  renderMessages(); renderList();
  if (matchMedia("(min-width: 800px)").matches) $("#msg-input").focus();
}
function closeChat() { current = null; $("#main").classList.remove("in-chat"); $("#chat").classList.add("hidden"); $("#no-chat").classList.remove("hidden"); renderList(); }
const TICK = { sending: "🕓", sent: "✓", delivered: "✓✓", failed: "⚠" };
function bubbleBody(m) {
  if (m.kind !== "img") return esc(m.text);
  if (m.data && !m.once) return `<img class="photo" src="${esc(photoUrl(m.mid, m.data))}" data-mid="${esc(m.mid)}" alt="Photo" />`;
  if (m.me) return `<span class="once">📷 View-once photo</span>`;
  if (m.data) return `<button class="once open" data-mid="${esc(m.mid)}">📷 View-once photo · tap to open</button>`;
  return `<span class="once muted">📷 Opened</span>`;
}
function renderMessages() {
  const c = S && conv(current); if (!c) return;
  headerFor(c);
  const grp = !!c.gid;
  let html = `<div class="sys">🔒 Hybrid post-quantum, sealed-sender encryption. The server can't read these messages or see who sent them.</div>`;
  if (c.request) html += `<div class="sys">${grp ? "Someone you haven't added put you in this group." : "Someone you haven't added messaged you."} They only know your anonymous ID. Reply to accept, or ${grp ? "leave the group" : "delete the chat"}.</div>`;
  if (c.removed) html += `<div class="sys">You're no longer a member of this group.</div>`;
  let lastDay = "";
  for (const m of msgs(current)) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { html += `<div class="day">${new Date(m.ts).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</div>`; lastDay = day; }
    if (m.sys) { html += `<div class="sys">${esc(m.text)}</div>`; continue; }
    const tick = m.me ? `<span class="tick ${m.status}">${TICK[m.status] || ""}</span>` : "";
    const who = grp && !m.me && m.from ? `<span class="who ${colorClass(m.from)}t">${esc(memberName(m.from))}</span>` : "";
    html += `<div class="msg ${m.me ? "me" : "them"} ${m.kind === "img" ? "img" : ""}">${who}${bubbleBody(m)}<span class="foot">${m.exp ? '<span class="timer-ico">⏱</span>' : ""}${new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${tick}</span></div>`;
  }
  const box = $("#messages"); box.innerHTML = html; box.scrollTop = box.scrollHeight;
}
$("#messages").addEventListener("click", (e) => { const t = e.target.closest("[data-mid]"); if (t) viewPhoto(t.dataset.mid); });

function noSpell(root = document) {
  root.querySelectorAll("input, textarea").forEach((e) => { e.spellcheck = false; e.setAttribute("autocorrect", "off"); e.setAttribute("autocapitalize", e.id === "add-id" || e.id === "gids" ? "characters" : "off"); if (e.type !== "password") e.setAttribute("autocomplete", "off"); });
}
function modal(title, bodyHtml, actions = []) {
  $("#modal-title").textContent = title; $("#modal-body").innerHTML = bodyHtml; noSpell($("#modal-body"));
  const a = $("#modal-actions"); a.innerHTML = "";
  for (const [label, fn, cls] of actions) {
    const b = document.createElement("button"); b.className = "btn " + (cls || "ghost"); b.textContent = label;
    b.onclick = async () => { b.disabled = true; const keep = await fn(); b.disabled = false; if (keep !== true) closeModal(); };
    a.appendChild(b);
  }
  $("#modal").classList.remove("hidden");
}
function menu(title, sub, items) {
  modal(title, sub, []);
  const a = $("#modal-actions");
  for (const [l, fn, cls] of items) { const b = document.createElement("button"); b.className = "menu-item " + (cls || ""); b.textContent = l; b.onclick = () => { closeModal(); fn(); }; a.appendChild(b); }
}
function closeModal() { $("#modal").classList.add("hidden"); $("#modal-body").innerHTML = ""; }
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
let toastT;
function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.remove("hidden"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add("hidden"), 2600); }
async function copy(text, msg = "Copied") {
  try { await navigator.clipboard.writeText(text); return toast(msg); } catch {}
  try { // fallback for pages the browser doesn't consider "secure" (iPhone .onion)
    const t = document.createElement("textarea"); t.value = text; t.setAttribute("readonly", ""); t.className = "offscreen";
    document.body.appendChild(t); t.select(); t.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy"); t.remove(); toast(ok ? msg : "Select the text and copy it");
  } catch { toast("Select the text and copy it"); }
}
const TIMERS = [[0, "Off"], [30e3, "30 seconds"], [300e3, "5 minutes"], [3600e3, "1 hour"], [86400e3, "24 hours"], [604800e3, "7 days"]];
const timerLabel = (ms) => (TIMERS.find((t) => t[0] === ms) || [0, Math.round(ms / 60000) + " min"])[1];
const err = (id, t) => { const e = $(id); if (e) e.textContent = t; return true; };

// ---------------- dialogs ----------------
async function addContact(raw) {
  const m = String(raw || "").toUpperCase().match(ID_FIND);
  if (!m) throw new Error("That doesn't look like a GhostChat ID");
  const id = m[0].replace(/-/g, "").match(/.{4}/g).join("-");
  if (id === S.me.id) throw new Error("That's your own ID");
  if (!S.contacts[id]) { S.contacts[id] = { id, ...(await fetchVerifiedKeys(id)), name: "", request: false, timer: 0, unread: 0, added: Date.now() }; persist(); }
  renderList(); openChat(id);
}
function newChatDialog() {
  modal("New chat", `<p class="muted">Enter their GhostChat ID or paste their invite link.</p><input id="add-id" placeholder="XXXX-XXXX-XXXX-XXXX" autocapitalize="characters" /><p id="add-err" class="err"></p>`,
    [["Start chat", async () => { try { await addContact($("#add-id").value); } catch (e) { return err("#add-err", e.message); } }, "primary"], ["Cancel", () => {}]]);
  setTimeout(() => $("#add-id") && $("#add-id").focus(), 50);
}
const inviteLink = () => BASE() + "/?add=" + S.me.id;
function myIdDialog() {
  modal("Your anonymous ID", `<div class="idbox">${S.me.id}</div><p class="muted small">Share this ID or your invite link. It isn't linked to your phone, email or name.</p>${STORAGE_MODE !== "indexeddb" ? `<p class="small warn">⚠️ This browser may erase GhostChat when it closes. Save a backup now: Menu → 💾 Encrypted backup.</p>` : ""}<p class="small">Nickname: <b>${esc(S.me.name || "(none)")}</b></p>`,
    [["Copy ID", () => { copy(S.me.id); return true; }, "primary"], ["Copy invite link", () => { copy(inviteLink(), "Invite link copied"); return true; }], ["Close", () => {}]]);
}
function renameSelf() {
  modal("Nickname", `<p class="muted small">Only people you message see it — it travels inside encrypted messages.</p><input id="nick" maxlength="30" />`,
    [["Save", () => { S.me.name = $("#nick").value.trim(); persist(); toast("Saved"); }, "primary"], ["Cancel", () => {}]]);
  $("#nick").value = S.me.name || "";
}
async function backupDialog() {
  await flush();
  const key = "GHOST3:" + btoa(toB64Blob(await IDB.get(slot)));
  modal("Encrypted backup", `
    <p>Your ID, keys, contacts and messages, <b>locked with your passcode</b>. To restore it you need this backup and your passcode.</p>
    <p class="muted small">Tor Browser erases site data when it closes. Keep this backup somewhere safe to restore your account next time.</p>
    <div class="keybox" id="bk"></div>`,
    [["Copy backup", () => { copy(key, "Backup copied"); return true; }, "primary"],
     ["Download as file", () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([key], { type: "text/plain" })); a.download = "backup.txt"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); return true; }],
     ["Done", () => {}]]);
  $("#bk").textContent = key.slice(0, 500) + "…";
}
function restoreDialog() {
  modal("Restore from backup", `<p class="muted small">Paste your backup (starts with GHOST3:) or open the backup file, then enter its passcode.</p>
    <textarea id="rk" rows="4"></textarea><input id="rf" type="file" accept=".txt,text/plain" class="mt" /><input id="rp" class="mt" type="password" placeholder="Passcode" /><p id="re" class="err"></p>`,
    [["Restore", async () => {
      try {
        let raw = $("#rk").value.trim();
        if (!raw && $("#rf").files[0]) raw = (await $("#rf").files[0].text()).trim();
        if (!raw.startsWith("GHOST3:")) throw new Error("Not a GhostChat v4 backup");
        if (NATIVE && !NATIVE.server()) { const sv = $("#ob-server").value.trim().replace(/\/+$/, ""); if (!/^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/[a-z2-7]{56}\.onion(:\d+)?|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(sv)) throw new Error("Enter the server address on the first screen"); NATIVE.setServer(sv); }
        err("#re", "Unlocking…");
        const blob = fromB64Blob(atob(raw.slice(7)));
        const v = await openVault(blob, $("#rp").value).catch(() => { throw new Error("Wrong passcode or damaged backup"); });
        slot = Math.random() < 0.5 ? "a" : "b";
        v.state.settings = { ...(v.state.settings || {}), other: "dummy" };
        await IDB.set(slot, blob); await IDB.set(otherSlot(), await dummyLike(blob.ct.length));
        LS.set("fails", "0"); LS.set("seen", String(Date.now()));
        await enter(v);
        persist();
      } catch (e) { return err("#re", e.message); }
    }, "primary"], ["Cancel", () => {}]]);
}
function passDialog() {
  modal("Change passcode", `<input id="np1" type="password" placeholder="New passcode (min 10)" /><input id="np2" class="mt" type="password" placeholder="Confirm" /><p id="npe" class="err"></p>`,
    [["Change", async () => {
      const p = $("#np1").value; if (weakPass(p)) return err("#npe", weakPass(p));
      if (p !== $("#np2").value) return err("#npe", "Passcodes don't match");
      err("#npe", "Checking…");
      if (await openVault(await IDB.get(otherSlot()), p).then(() => true, () => false)) return err("#npe", "Choose a different passcode");
      vaultSalt = rand(16); vaultKey = await deriveVaultKey(p, vaultSalt, PBKDF2_ITER); await flush(); toast("Passcode changed");
    }, "primary"], ["Cancel", () => {}]]);
}
function wipeDialog() {
  modal("Erase everything?", `<p>Destroys your ID, keys, contacts and messages on this device, deletes your ID from the server${S.settings.burnRemote !== false ? ", and erases your chats from your contacts' phones" : ""}.</p><p class="muted small">Tip: next time, just <b>hold the 🔒 button for 2 seconds</b> — no questions asked.</p>`,
    [["Erase now", () => panicWipe(), "danger"], ["Cancel", () => {}]]);
}
function securityDialog() {
  const cur = S.spks[S.spks.length - 1];
  modal("Security", `
    <div class="kv"><b>Key exchange</b><span>ECDH P-384 + ML-KEM-768 (hybrid)</span><b>Post-quantum</b><span>✓ NIST FIPS 203</span><b>Per-message keys</b><span>✓ Double Ratchet (self-healing)</span><b>Encryption</b><span>AES-256-GCM</span><b>Key derivation</b><span>HKDF-SHA-384</span><b>Signatures</b><span>ECDSA P-384</span><b>Device vault</b><span>PBKDF2-SHA-384 ×600k</span><b>Crypto engine</b><span>${BUILTIN_CRYPTO ? "GhostChat built-in (audited @noble)" : "Browser built-in"}</span><b>Prekey age</b><span>${Math.round((Date.now() - cur.created) / 3600e3)} h (rotates daily)</span><b>App code</b><span>${NATIVE ? "Bundled in the app ✓" : "Loaded from server"}</span><b>Screenshots</b><span>${NATIVE ? "Blocked ✓" : "Not blockable in a browser"}</span><b>Cover traffic</b><span>${S.settings.cover !== false ? "On ✓" : "Off"}</span><b>Connection</b><span>${location.hostname.endsWith(".onion") ? "Tor onion service ✓" : "⚠ Not via Tor"}</span></div>
    <p class="small"><b>Sealed sender:</b> the server can't see who sent a message. <b>Padding:</b> it can't tell how long a message is. <b>Cover traffic:</b> it can't tell when you're really chatting.</p>
    <p class="muted small">No app can protect you if your phone itself is hacked, if someone sees your screen, or if the person you're messaging shares your messages.</p>`,
    [["Close", () => {}]]);
}

// ---------------- offline Bluetooth mesh (Android app) ----------------
function meshDialog() {
  let st = {}; try { st = JSON.parse(NATIVE.meshStatus()); } catch {}
  modal("Offline Bluetooth mesh", `
    <p class="small">When there's no internet, GhostChat passes your <b>already-encrypted</b> messages phone-to-phone over Bluetooth. Phones in between can carry messages for others but can't read them or see who sent them.</p>
    <div class="kv"><b>Bluetooth</b><span>${st.bt ? "On ✓" : "Off"}</span><b>Nearby GhostChat phones met</b><span>${st.peers || 0}</span><b>Messages being carried</b><span>${st.pool || 0}</span></div>
    <p class="muted small">Works automatically with phones you've paired in Bluetooth settings. To reach unpaired phones, tap "Make me visible" (lasts 5 minutes).</p>`,
    [["Make me visible", () => { NATIVE.meshVisible(); return true; }, "primary"], ["Close", () => {}]]);
}

// ---------------- groups UI ----------------
function parseIds(text) {
  return [...new Set((String(text).toUpperCase().match(new RegExp(ID_FIND.source, "g")) || []).map((x) => x.replace(/-/g, "").match(/.{4}/g).join("-")))].filter((x) => x !== S.me.id);
}
function newGroupDialog() {
  const cs = Object.values(S.contacts);
  modal("New group", `<label class="field"><span>Group name</span><input id="gn" maxlength="40" placeholder="e.g. Team" /></label>
    ${cs.length ? `<p class="small">Members from your chats:</p>` + cs.map((c) => `<label class="opt"><input type="checkbox" class="gm" value="${c.id}" /> ${esc(displayName(c))} <span class="muted small mono">${c.id}</span></label>`).join("") : ""}
    <p class="small mt">Or add IDs (one per line):</p><textarea id="gids" rows="2" placeholder="XXXX-XXXX-XXXX-XXXX"></textarea><p id="ge" class="err"></p>`,
    [["Create group", async () => {
      const name = $("#gn").value.trim(); if (!name) return err("#ge", "Give the group a name");
      const ids = [...new Set([...[...document.querySelectorAll(".gm:checked")].map((x) => x.value), ...parseIds($("#gids").value)])];
      if (!ids.length) return err("#ge", "Add at least one member"); if (ids.length > 100) return err("#ge", "Max 100 members");
      err("#ge", "Creating…");
      try { await createGroup(name, ids); } catch (e) { return err("#ge", e.message); }
    }, "primary"], ["Cancel", () => {}]]);
}
function groupMenu(g) {
  const admin = g.admin === S.me.id;
  menu(displayName(g), `<p class="muted small">${g.members.length} members${admin ? " · you're the admin" : ""}</p>`, [
    ["👥  Members", () => membersDialog(g)],
    ...(admin && !g.removed ? [["➕  Add members", () => addMembersDialog(g)], ["✏️  Rename group", () => renameGroup(g)], ["⏱  Disappearing messages", timerDialog]] : []),
    [g.removed ? "🗑️  Delete group" : "🚪  Leave group", () => leaveGroup(g), "danger"],
  ]);
}
function membersDialog(g) {
  const admin = g.admin === S.me.id;
  modal("Members", g.members.map((id) => `<div class="opt"><span class="flex1">${esc(memberName(id))}${id === g.admin ? ' <span class="tag">admin</span>' : ""}<br><span class="muted small mono">${id}</span></span>${admin && id !== S.me.id ? `<button class="btn ghost small rm" data-id="${id}">Remove</button>` : ""}</div>`).join(""), [["Close", () => {}]]);
  document.querySelectorAll(".rm").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.id; g.members = g.members.filter((x) => x !== id);
    sysMsg(g.gid, `You removed ${memberName(id)}`); persist(); closeModal(); renderMessages(); renderList();
    await pushGroupState(g, [id]); // the removed member is told too
  }));
}
function addMembersDialog(g) {
  const cs = Object.values(S.contacts).filter((c) => !g.members.includes(c.id));
  modal("Add members", (cs.length ? cs.map((c) => `<label class="opt"><input type="checkbox" class="gm" value="${c.id}" /> ${esc(displayName(c))}</label>`).join("") : "") +
    `<p class="small mt">Or IDs:</p><textarea id="gids" rows="2"></textarea><p id="ge" class="err"></p>`,
    [["Add", async () => {
      const ids = [...new Set([...[...document.querySelectorAll(".gm:checked")].map((x) => x.value), ...parseIds($("#gids").value)])].filter((x) => !g.members.includes(x));
      if (!ids.length) return err("#ge", "Pick someone");
      try { for (const id of ids) await ensurePeer(id); } catch (e) { return err("#ge", e.message); }
      g.members.push(...ids); sysMsg(g.gid, `You added ${ids.map(memberName).join(", ")}`); persist(); renderMessages(); renderList();
      await pushGroupState(g);
    }, "primary"], ["Cancel", () => {}]]);
}
function renameGroup(g) {
  modal("Rename group", `<input id="rg" maxlength="40" />`, [["Save", async () => { const n = $("#rg").value.trim(); if (!n) return true; g.name = n; sysMsg(g.gid, `You renamed the group to "${n}"`); persist(); renderMessages(); renderList(); await pushGroupState(g); }, "primary"], ["Cancel", () => {}]]);
  $("#rg").value = g.name;
}
function leaveGroup(g) {
  modal(g.removed ? "Delete group?" : "Leave group?", `<p>${g.removed ? "Delete this group's messages from this device?" : "You'll stop receiving messages and the group's messages are deleted from this device."}</p>`,
    [[g.removed ? "Delete" : "Leave", async () => {
      if (!g.removed) await Promise.all(others(g).map(async (id) => { try { await post(await ensurePeer(id), { k: "gleave", gid: g.gid, mid: rid() }, null, g.gid); } catch {} }));
      delete S.groups[g.gid]; delete S.msgs[g.gid]; persist(); closeChat();
    }, "danger"], ["Cancel", () => {}]]);
}

// ---------------- stealth: calculator disguise, decoy account, cover traffic ----------------
async function codeHash(code, salt) {
  const base = await subtle.importKey("raw", enc.encode(String(code).normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return b64(await subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-384" }, base, 256));
}
async function matches(lsKey, code) {
  try { const d = JSON.parse(LS.get(lsKey) || "null"); return !!d && (await codeHash(code, unb64(d.salt))) === d.hash; } catch { return false; }
}
async function storeCode(lsKey, code) { const salt = rand(16); LS.set(lsKey, JSON.stringify({ salt: b64(salt), hash: await codeHash(code, salt) })); }
function stealthDialog() {
  const disg = !!LS.get("disguise"), hasDecoy = S.settings.other === "decoy";
  modal("Stealth", `
    <p class="small"><b>🧮 Calculator disguise</b> ${disg ? "✅ on" : ""}<br><span class="muted">The app opens as a working calculator called "Calculator". Type your secret number and press <b>=</b> to reach the passcode screen. Hold <b>C</b> for 2 s to erase everything.</span></p>
    <input id="st-code" inputmode="numeric" placeholder="${disg ? "New secret number (blank = keep)" : "Secret number, e.g. 7319"}" />
    <p class="small mt"><b>🎭 Decoy account</b> ${hasDecoy ? "✅ set up" : ""}<br><span class="muted">A second, fully working account opened by a different passcode. Both accounts look identical on the device — nobody can prove the other exists. Chat a little in it so it looks lived-in.</span></p>
    ${hasDecoy ? `<p class="small">A decoy account is set up on this device.</p>` : `<button class="btn ghost" id="st-decoy">Create decoy account</button>`}
    <label class="opt mt"><input type="checkbox" id="st-cover" ${S.settings.cover !== false ? "checked" : ""}/> 📡 Cover traffic (send dummy messages at random times)</label>
    <p id="st-err" class="err"></p>`,
    [["Save", async () => {
      const code = $("#st-code").value.trim();
      if (code) {
        if (!/^\d{4,12}$/.test(code)) return err("#st-err", "Secret number: 4–12 digits");
        await storeCode("disguise", code); applyDisguise();
      }
      S.settings.cover = $("#st-cover").checked; persist(); toast("Saved");
    }, "primary"],
    ...(disg ? [["Turn off calculator disguise", () => { LS.del("disguise"); applyDisguise(); toast("Disguise off"); }]] : []),
    ["Cancel", () => {}]]);
  const d = $("#st-decoy"); if (d) d.onclick = () => { closeModal(); decoyDialog(); };
}
function decoyDialog() {
  modal("Create decoy account", `<p class="muted small">Pick a passcode you could "give up" under pressure. It opens the decoy account instead of this one.</p>
    <label class="field"><span>Decoy nickname</span><input id="dn" maxlength="30" placeholder="e.g. Rahul" /></label>
    <input id="dp1" type="password" placeholder="Decoy passcode (min 10)" /><input id="dp2" class="mt" type="password" placeholder="Confirm" /><p id="de" class="err"></p>`,
    [["Create", async () => {
      const p = $("#dp1").value;
      if (weakPass(p)) return err("#de", weakPass(p));
      if (p !== $("#dp2").value) return err("#de", "Passcodes don't match");
      err("#de", "Creating…");
      if (await openVault(await IDB.get(slot), p).then(() => true, () => false)) return err("#de", "Must be different from your real passcode");
      if (await matches("duress", p)) return err("#de", "Must be different from your duress passcode");
      const keep = K;
      const st = await newIdentity($("#dn").value.trim().slice(0, 30)); K = keep;
      st.settings.other = "decoy";
      try { await register(st); } catch (e) { return err("#de", e.message); }
      const salt = rand(16), key = await deriveVaultKey(p, salt, PBKDF2_ITER);
      S.settings.other = "decoy"; await flush();
      await IDB.set(otherSlot(), await sealVault(st, key, salt));
      toast("Decoy account created");
    }, "primary"], ["Cancel", () => {}]]);
}
const CALC_ICON = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#333"/><rect x="12" y="10" width="40" height="14" rx="3" fill="#9fd"/><g fill="#ff9f0a"><circle cx="18" cy="36" r="5"/><circle cx="32" cy="36" r="5"/><circle cx="46" cy="36" r="5"/><circle cx="18" cy="50" r="5"/><circle cx="32" cy="50" r="5"/><circle cx="46" cy="50" r="5"/></g></svg>');
function applyDisguise() {
  const on = !!LS.get("disguise");
  document.title = on ? "Calculator" : "GhostChat";
  $("link[rel=icon]").href = on ? CALC_ICON : "/icon.svg";
  $("meta[name=theme-color]").content = on ? "#000000" : "#0b1117";
  if (NATIVE) try { NATIVE.setDisguise(on); } catch {} // swaps the real launcher icon + name to "Calculator"
}
// working calculator
let calcExpr = "";
function calcEval(expr) {
  const t = expr.match(/\d+\.?\d*|[+\-×÷]/g) || [], out = [], ops = [], P = { "+": 1, "-": 1, "×": 2, "÷": 2 };
  const ap = () => { const o = ops.pop(), b = out.pop(), a = out.pop(); out.push(o === "+" ? a + b : o === "-" ? a - b : o === "×" ? a * b : a / b); };
  for (const x of t) { if (x in P) { while (ops.length && P[ops[ops.length - 1]] >= P[x]) ap(); ops.push(x); } else out.push(parseFloat(x)); }
  while (ops.length) ap();
  const r = out[0]; return r === undefined || !isFinite(r) ? "Error" : String(+r.toPrecision(10));
}
async function calcKey(k) {
  const d = $("#calc-display");
  if (k === "C") calcExpr = "";
  else if (k === "=") {
    if (/^\d{4,12}$/.test(calcExpr) && (await matches("disguise", calcExpr))) { calcExpr = ""; d.textContent = "0"; show("lock"); setTimeout(() => $("#unlock-pass").focus(), 50); return; }
    calcExpr = calcEval(calcExpr); if (calcExpr === "Error") { d.textContent = "Error"; calcExpr = ""; return; }
  } else if ("+-×÷".includes(k)) { if (calcExpr && !"+-×÷".includes(calcExpr.slice(-1))) calcExpr += k; }
  else if (k === "±") { if (/^-?\d+\.?\d*$/.test(calcExpr)) calcExpr = String(-parseFloat(calcExpr)); }
  else if (k === "%") { if (/^-?\d+\.?\d*$/.test(calcExpr)) calcExpr = String(parseFloat(calcExpr) / 100); }
  else if (calcExpr.length < 24) calcExpr += k;
  d.textContent = calcExpr || "0";
}
$("#calc-keys").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) calcKey(b.dataset.k); });

// ---------------- PANIC ----------------
let wiping = false, onDeleted = null;
async function panicWipe(dest = "/wipe") {
  if (wiping) return; wiping = true;
  $("#shield").classList.remove("hidden"); document.title = "New Tab"; closeModal();
  try {
    if (S) {
      const jobs = [];
      if (S.settings.burnRemote !== false && dropReady) for (const c of Object.values({ ...(S.hidden || {}), ...S.contacts })) jobs.push(post(c, { k: "burn", mid: rid() }).catch(() => {}));
      if (ready) jobs.push(new Promise((res) => { onDeleted = res; inbox.send(JSON.stringify({ t: "delete_account" })); }));
      await Promise.race([Promise.all(jobs), sleep(3000)]);
      for (let i = 0; i < 20 && drop && drop.bufferedAmount > 0; i++) await sleep(50);
      await sleep(150);
    }
  } catch {}
  if (!NATIVE) { try { await fetch("/wipe", { method: "POST", headers: { "X-GC-Wipe": "1" } }); } catch {} } // browser clears ALL site data
  await localErase();
  if (NATIVE) { try { NATIVE.panic(); } catch {} return; } // native: wipe all app data + ask Android to uninstall
  location.replace(dest);
}
async function localErase() {
  S = null; K = null; vaultKey = null; vaultSalt = null; clearTimeout(saveT); clearTimeout(noiseT);
  try { inbox && inbox.close(); drop && drop.close(); } catch {}
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
  MEM.clear();
  try { IDB.db && IDB.db.close(); IDB.db = null; await new Promise((r) => { const q = indexedDB.deleteDatabase("gc"); q.onsuccess = q.onerror = q.onblocked = () => r(); }); } catch {}
  try { if (indexedDB.databases) for (const d of await indexedDB.databases()) indexedDB.deleteDatabase(d.name); } catch {}
  try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch {}
  for (const u of urlCache.values()) URL.revokeObjectURL(u); urlCache.clear();
  $("#app").innerHTML = "";
}
function holdToWipe(el) {
  let t = null;
  const cancel = () => { if (t) { clearTimeout(t); t = null; } el.classList.remove("arming"); };
  el.addEventListener("pointerdown", () => { el.classList.add("arming"); t = setTimeout(() => { t = null; panicWipe(); }, 2000); });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => el.addEventListener(ev, cancel));
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}
function panicSettings() {
  const ae = +LS.get("autoerase") || 0, hasDuress = !!LS.get("duress");
  modal("Panic settings", `
    <p class="small"><b>Ways to trigger a full wipe:</b></p>
    <ul class="small plist">
      <li>Hold the <b>🔒</b> button for 2 seconds</li>
      <li>On the lock screen, hold the <b>ghost logo</b> for 2 seconds</li>
      <li>In calculator disguise, hold <b>C</b> for 2 seconds</li>
      <li>Type your <b>duress passcode</b> on the lock screen ${hasDuress ? "✅" : "(not set)"}</li>
      <li>10 wrong passcodes in a row</li>
      <li>Menu → Erase everything</li>
    </ul>
    <label class="opt"><input type="checkbox" id="ps-burn" ${S.settings.burnRemote !== false ? "checked" : ""}/> Also erase my chats from my contacts' phones</label>
    <p class="small mt"><b>Auto-erase</b> if the app isn't unlocked for:</p>
    ${[[0, "Never"], [3, "3 days"], [7, "7 days"], [30, "30 days"]].map(([d, l]) => `<label class="opt"><input type="radio" name="ae" value="${d}" ${ae === d ? "checked" : ""}/> ${l}</label>`).join("")}
    <p class="small mt"><b>Duress passcode</b> — if someone forces you to unlock, type this instead. The app quietly erases itself and opens like a fresh install.</p>
    <input id="ps-duress" type="password" placeholder="${hasDuress ? "New duress passcode (blank = keep)" : "Set a duress passcode (optional)"}" />
    <p id="ps-err" class="err"></p>`,
    [["Save", async () => {
      S.settings.burnRemote = $("#ps-burn").checked; persist();
      LS.set("autoerase", document.querySelector("input[name=ae]:checked").value);
      const d = $("#ps-duress").value;
      if (d) {
        if (d.length < 4) return err("#ps-err", "At least 4 characters");
        err("#ps-err", "Checking…");
        const clash = await Promise.all(["a", "b"].map(async (s) => { const bl = await IDB.get(s); return bl ? openVault(bl, d).then(() => true, () => false) : false; }));
        if (clash.some(Boolean)) return err("#ps-err", "Must be different from your account passcodes");
        await storeCode("duress", d);
      }
      toast("Panic settings saved");
    }, "primary"],
    ...(hasDuress ? [["Remove duress passcode", () => { LS.del("duress"); toast("Removed"); }]] : []),
    ["Cancel", () => {}]]);
}
function mainMenu() {
  menu("Menu", "", [
    ["🪪  My ID & invite link", myIdDialog], ["✏️  Nickname", renameSelf], ["💾  Encrypted backup", backupDialog],
    ["🔑  Change passcode", passDialog], ["🕵️  Stealth (disguise, decoy)", stealthDialog], ["🚨  Panic settings", panicSettings],
    ["🛡️  Security details", securityDialog], ...(NATIVE ? [["📶  Offline Bluetooth mesh", meshDialog]] : []), ["🔔  Enable notifications", enableNotifs],
    ["🔒  Lock now", lockNow], ["🔥  Erase everything (panic)", wipeDialog, "danger"],
  ]);
}
function chatMenu() {
  const c = conv(current); if (!c) return;
  if (c.gid) return groupMenu(c);
  menu(displayName(c), `<p class="muted small mono">${c.id}</p>`, [
    ["⏱  Disappearing messages", timerDialog], ["🛡️  Verify safety number", safetyDialog],
    ["✏️  Rename contact", renameContact], ["🗑️  Delete chat", deleteChat, "danger"],
  ]);
}
function timerDialog() {
  const c = conv(current);
  if (c.gid && c.admin !== S.me.id) return toast("Only the group admin can change this");
  modal("Disappearing messages", `<p class="muted small">New messages vanish from both devices after this time.</p>` +
    TIMERS.map(([ms, l]) => `<label class="opt"><input type="radio" name="tmr" value="${ms}" ${(c.timer || 0) === ms ? "checked" : ""}/> ${l}</label>`).join(""),
    [["Save", async () => {
      const v = +document.querySelector("input[name=tmr]:checked").value; if (v === (c.timer || 0)) return;
      c.timer = v;
      msgs(c.gid || c.id).push({ mid: rid(), sys: true, text: v ? `You turned on disappearing messages (${timerLabel(v)})` : "You turned off disappearing messages", ts: Date.now() });
      persist(); renderMessages();
      if (c.gid) await pushGroupState(c); else await post(c, { k: "timer", mid: rid(), timer: v, name: S.me.name }).catch((e) => toast(e.message));
    }, "primary"], ["Cancel", () => {}]]);
}
async function safetyNumber(c) {
  const h = new Uint8Array(await subtle.digest("SHA-384", enc.encode([S.me.signPub, c.sign].sort().join("|"))));
  const g = []; for (let i = 0; i < 24; i += 2) g.push(String(((h[i] << 8) | h[i + 1]) % 100000).padStart(5, "0"));
  return g.slice(0, 6).join(" ") + "\n" + g.slice(6).join(" ");
}
async function safetyDialog() {
  const c = S.contacts[current];
  modal("Safety number", `<p class="muted small">Compare with ${esc(displayName(c))} in person. If both screens match, no one is intercepting your chat.</p><div class="safety" id="sn"></div>`, [["Close", () => {}]]);
  $("#sn").innerText = await safetyNumber(c);
}
function renameContact() {
  const c = S.contacts[current];
  modal("Rename contact", `<input id="cname" maxlength="30" />`, [["Save", () => { c.customName = $("#cname").value.trim(); persist(); renderList(); renderMessages(); }, "primary"], ["Cancel", () => {}]]);
  $("#cname").value = c.customName || ""; $("#cname").placeholder = c.name || "Name";
}
function deleteChat() {
  const c = conv(current); if (c.gid) return leaveGroup(c);
  modal("Delete chat?", `<p>Delete all messages with ${esc(displayName(c))} from this device?</p>`,
    [["Delete", () => { delete S.contacts[c.id]; delete S.msgs[c.id]; persist(); closeChat(); }, "danger"], ["Cancel", () => {}]]);
}
async function enableNotifs() {
  if (!("Notification" in window)) return toast("Not supported here");
  toast((await Notification.requestPermission()) === "granted" ? "On — notifications never show names or text" : "Blocked");
}

// ---------------- lock / unlock ----------------
async function lockNow() { if (wiping) return; await flush(); if (NATIVE) try { NATIVE.meshStop(); } catch {} location.reload(); }
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (!wiping) $("#shield").classList.toggle("hidden", !document.hidden || !S);
  if (document.hidden) hiddenAt = Date.now();
  else {
    if (S && hiddenAt && Date.now() - hiddenAt > AUTO_LOCK) return lockNow();
    if (S && current && conv(current)) { conv(current).unread = 0; persist(); renderList(); }
  }
});
window.addEventListener("pagehide", () => { if (S) flush(); });

$("#unlock-form").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("#unlock-btn"), pass = $("#unlock-pass").value;
  btn.disabled = true; err("#unlock-err", ""); btn.textContent = BUILTIN_CRYPTO ? "Unlocking… (up to ~10 s on iPhone)" : "Unlocking…";
  // try both slots at once: same time and same work whichever one (if any) opens
  const [a, b, duress] = await Promise.all([
    IDB.get("a").then((bl) => (bl ? openVault(bl, pass) : null)).catch(() => null),
    IDB.get("b").then((bl) => (bl ? openVault(bl, pass) : null)).catch(() => null),
    matches("duress", pass),
  ]);
  if (duress) return panicWipe("/wipe?home=1");
  const v = a || b;
  if (v) {
    slot = a ? "a" : "b";
    LS.set("fails", "0"); LS.set("seen", String(Date.now())); $("#unlock-pass").value = "";
    await enter(v);
  } else {
    const fails = (+LS.get("fails") || 0) + 1; LS.set("fails", String(fails));
    if (fails >= MAX_FAILS) return panicWipe("/wipe?home=1");
    err("#unlock-err", `Wrong passcode. ${MAX_FAILS - fails} attempt${MAX_FAILS - fails === 1 ? "" : "s"} left before everything is erased.`);
  }
  btn.disabled = false; btn.textContent = "Unlock";
};

// ---------------- onboarding ----------------
$("#ob-create").onclick = async () => {
  const p1 = $("#ob-pass").value, p2 = $("#ob-pass2").value, b = $("#ob-create");
  if (weakPass(p1)) return err("#ob-err", weakPass(p1));
  if (p1 !== p2) return err("#ob-err", "Passcodes don't match");
  if (NATIVE) {
    const sv = $("#ob-server").value.trim().replace(/\/+$/, "");
    if (!/^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/[a-z2-7]{56}\.onion(:\d+)?|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(sv)) return err("#ob-err", "Enter the server address, e.g. http://abc…xyz.onion");
    NATIVE.setServer(sv);
  }
  err("#ob-err", ""); b.disabled = true; b.textContent = "Generating keys…";
  try {
    S = await newIdentity($("#ob-name").value.trim().slice(0, 30));
    S.settings.other = "dummy";
    slot = Math.random() < 0.5 ? "a" : "b";
    vaultSalt = rand(16); vaultKey = await deriveVaultKey(p1, vaultSalt, PBKDF2_ITER);
    await register(); await flush(); LS.set("fails", "0"); LS.set("seen", String(Date.now()));
    $("#ob-pass").value = $("#ob-pass2").value = "";
    await start(); setTimeout(myIdDialog, 250);
  } catch (e) { S = null; err("#ob-err", e.message || "Something went wrong"); b.disabled = false; b.textContent = "Create anonymous ID"; }
};
$("#ob-restore").onclick = restoreDialog;

async function enter(v) {
  S = v.state; vaultKey = v.key; vaultSalt = v.salt;
  S.settings = S.settings || {};
  await loadKeys(); await start();
  register().catch(() => {});
}
let started = false;
async function start() {
  if (!K) await loadKeys();
  show("main"); renderList(); await maintainKeys(); connect(); connectDrop(); sweep();
  if (NATIVE) try { NATIVE.meshStart(S.me.id); } catch {}
  if (!started) { started = true; setInterval(sweep, 5000); setInterval(() => maintainKeys().catch(() => {}), 3600e3); scheduleNoise(); }
  const add = new URLSearchParams(location.search).get("add");
  if (add) { history.replaceState(null, "", "/"); addContact(add).catch((e) => toast(e.message)); }
}

// ---------------- wiring ----------------
$("#btn-menu").onclick = mainMenu; $("#btn-chat-menu").onclick = chatMenu; $("#btn-lock").onclick = lockNow;
holdToWipe($("#btn-lock")); holdToWipe($("#lock-logo")); holdToWipe($("#calc-clear"));
$("#fab").onclick = () => menu("Start", "", [["💬  New chat", newChatDialog], ["👥  New group", newGroupDialog]]); $("#btn-share-empty").onclick = myIdDialog; $("#btn-back").onclick = closeChat;
$("#btn-attach").onclick = () => $("#file").click();
$("#file").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) photoDialog(f); };
$("#search").oninput = renderList;
$("#chat-list").onclick = (e) => { const it = e.target.closest(".chat-item"); if (it) openChat(it.dataset.id); };
const input = $("#msg-input");
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && matchMedia("(min-width: 800px)").matches) { e.preventDefault(); $("#composer").requestSubmit(); } });
$("#composer").onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; if (conv(current)?.removed) return toast("You're no longer in this group"); input.value = ""; input.style.height = "auto"; sendText(t); input.focus(); };

(async function boot() {
  if (!subtle || !self.PQ) {
    const miss = [!self.PQ && "crypto bundle (pq.js) didn't load", !subtle && (IS_ONION ? "crypto engine" : "secure connection (use the .onion address in Tor/Onion Browser)")].filter(Boolean);
    document.body.textContent = "GhostChat v5.3 can't start here. Missing: " + miss.join("; ") + ".";
    return;
  }
  try { for (const k of Object.keys(localStorage)) if (/^gc2?_/.test(k)) localStorage.removeItem(k); } catch {} // old versions
  if (!NATIVE && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  applyDisguise(); noSpell();
  if (NATIVE) { $("#ob-server-wrap").classList.remove("hidden"); $("#ob-server").value = NATIVE.server() || ""; }
  let has = false;
  try {
    // don't even create an (empty) database until there's something to store
    const exists = !window.indexedDB ? true : indexedDB.databases ? (await indexedDB.databases()).some((d) => d.name === "gc") : true;
    has = exists && !!((await IDB.get("a")) || (await IDB.get("b")));
  } catch {}
  const ae = +LS.get("autoerase") || 0, seen = +LS.get("seen") || 0;
  if (has && ae && seen && Date.now() - seen > ae * 86400e3) { wiping = true; await localErase(); location.replace("/wipe?home=1"); return; } // dead-man's switch
  if (!has) return show("onboard");
  show(LS.get("disguise") ? "calc" : "lock");
})();
