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
const PAD_BUCKETS = [1024, 4096, 16384, 65536, 262144, 524288, 1048576, 2097152, 3145728, 4194304];
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
const MAX_ENV = 6 * 1024 * 1024; // must match the server
const MAX_FILE = () => (STORAGE_MODE === "indexeddb" ? 2 * 1048576 : 400 * 1024); // small vault when the browser only allows localStorage
const MAX_VOICE_S = 120;

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
// A small, allocation-free SHA-256 core: also used for the vault key on phones whose browser
// hides WebCrypto (Onion Browser), where every hash runs in plain JavaScript, often without JIT.
const SHA_K = Int32Array.from([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const SHA_IV = Int32Array.from([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
// compress one 64-byte block (first 16 words of W) into state H, in place
function shaBlock(H, W) {
  for (let i = 16; i < 64; i++) { const a = W[i - 15], b = W[i - 2]; W[i] = ((((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) + W[i - 16] + (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)) + W[i - 7]) | 0; }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + SHA_K[i] + W[i]) | 0;
    const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}
// hash bytes `m` continuing from state H (already absorbed `done` bytes); returns new state
function shaFinish(H0, m, done) {
  const H = Int32Array.from(H0), W = new Int32Array(64), l = m.length, nb = ((l + 9 + 63) >> 6) << 6, p = new Uint8Array(nb);
  p.set(m); p[l] = 0x80; const bits = (done + l) * 8; p[nb - 4] = bits >>> 24; p[nb - 3] = bits >>> 16; p[nb - 2] = bits >>> 8; p[nb - 1] = bits;
  for (let o = 0; o < nb; o += 64) { for (let i = 0; i < 16; i++) W[i] = (p[o + 4 * i] << 24) | (p[o + 4 * i + 1] << 16) | (p[o + 4 * i + 2] << 8) | p[o + 4 * i + 3]; shaBlock(H, W); }
  return H;
}
function shaAbsorb(m) { // hash the whole 64-byte blocks of m; returns [state, leftover bytes]
  const H = Int32Array.from(SHA_IV), W = new Int32Array(64), full = m.length & ~63;
  for (let o = 0; o < full; o += 64) { for (let i = 0; i < 16; i++) W[i] = (m[o + 4 * i] << 24) | (m[o + 4 * i + 1] << 16) | (m[o + 4 * i + 2] << 8) | m[o + 4 * i + 3]; shaBlock(H, W); }
  return [H, m.subarray(full), full];
}
const sha256 = (m) => Array.from(shaFinish(SHA_IV, m, 0), (x) => x >>> 0);
let powStop = false;
async function solvePow(sign, bits) {
  const [mid, rest, done] = shaAbsorb(enc.encode("gc-pow:" + sign + ":")); // hash the fixed prefix only once
  const tail = new Uint8Array(rest.length + 16); tail.set(rest);
  for (let n = 0; ; n++) {
    const ns = n.toString(36); for (let i = 0; i < ns.length; i++) tail[rest.length + i] = ns.charCodeAt(i);
    const h = shaFinish(mid, tail.subarray(0, rest.length + ns.length), done)[0];
    if ((h >>> (32 - bits)) === 0) return ns;
    if ((n & 4095) === 4095) { await sleep(0); if (powStop) throw new Error("stopped"); } // keep the page responsive
  }
}
// PBKDF2-HMAC-SHA-256, 32-byte output (gives exactly the same result as WebCrypto's PBKDF2)
async function pbkdf2s256(pass, salt, iter) {
  let key = pass.length > 64 ? Uint8Array.from(sha256(pass).flatMap((x) => [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255])) : pass;
  const kp = new Uint8Array(64); kp.set(key);
  const pad = (v) => shaAbsorb(kp.map((x) => x ^ v))[0];
  const IP = pad(0x36), OP = pad(0x5c), W = new Int32Array(64), I = new Int32Array(8), O = new Int32Array(8), T = new Int32Array(8);
  const hmacWords = (U) => { // U (8 words, 32-byte message) -> HMAC, in place
    I.set(IP); W.fill(0); W.set(U); W[8] = 0x80000000 | 0; W[15] = 768; shaBlock(I, W);
    O.set(OP); W.fill(0); W.set(I); W[8] = 0x80000000 | 0; W[15] = 768; shaBlock(O, W); U.set(O);
  };
  const s1 = concat(salt, new Uint8Array([0, 0, 0, 1]));
  const inner = shaFinish(IP, s1, 64), U = new Int32Array(8);
  const outer = shaFinish(OP, Uint8Array.from(Array.from(inner).flatMap((x) => [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255])), 64);
  U.set(outer); T.set(U);
  for (let i = 1; i < iter; i++) { hmacWords(U); for (let j = 0; j < 8; j++) T[j] ^= U[j]; if ((i & 1023) === 0) await sleep(0); }
  return Uint8Array.from(Array.from(T).flatMap((x) => [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]));
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
// Vault key settings. Normal browsers: PBKDF2-SHA-384, 600k rounds (WebCrypto, fast).
// Built-in crypto (Onion Browser): PBKDF2-SHA-256 with rounds tuned to ~3 s on this phone,
// because plain JavaScript there can be 50–100× slower and 600k rounds would take minutes.
let vaultKdf = { iter: PBKDF2_ITER, h: "SHA-384" };
async function localKdf() {
  if (!BUILTIN_CRYPTO) return { iter: PBKDF2_ITER, h: "SHA-384" };
  const t = performance.now(); await pbkdf2s256(enc.encode("calibrate"), rand(16), 3000); const ms = Math.max(1, performance.now() - t);
  return { iter: Math.min(PBKDF2_ITER, Math.max(20000, Math.round((3000 * 3000) / ms / 1000) * 1000)), h: "SHA-256" };
}
async function deriveVaultKey(pass, salt, iter, h = "SHA-384") {
  if (h === "SHA-256" && BUILTIN_CRYPTO) return subtle.importKey("raw", await pbkdf2s256(enc.encode(pass.normalize("NFKC")), salt, iter), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const base = await subtle.importKey("raw", enc.encode(pass.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: h }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function sealVault(state = S, key = vaultKey, salt = vaultSalt, kdf = vaultKdf) {
  const data = enc.encode(JSON.stringify(state)), iv = rand(12);
  const ct = await aesEnc(key, iv, padTo(data, Math.ceil((data.length + 4) / VAULT_BUCKET) * VAULT_BUCKET), enc.encode("gc3-vault"));
  return { v: 3, salt, iter: kdf.iter, h: kdf.h, iv, ct };
}
async function openVault(blob, pass) {
  const kdf = { iter: blob.iter, h: blob.h || "SHA-384" };
  const key = await deriveVaultKey(pass, blob.salt, kdf.iter, kdf.h);
  const pt = await aesDec(key, blob.iv, blob.ct, enc.encode("gc3-vault")); // throws on wrong passcode / dummy slot
  return { state: JSON.parse(dec.decode(unpadBytes(pt))), key, salt: blob.salt, kdf };
}
const dummyLike = async (ctLen) => ({ v: 3, salt: rand(16), iter: vaultKdf.iter, h: vaultKdf.h, iv: rand(12), ct: await randomBytes(ctLen) });
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
const toB64Blob = (b) => JSON.stringify({ v: 3, salt: b64(b.salt), iter: b.iter, ...(b.h && b.h !== "SHA-384" ? { h: b.h } : {}), iv: b64(b.iv), ct: b64(b.ct) });
const fromB64Blob = (s) => { const j = JSON.parse(s); return { v: 3, salt: unb64(j.salt), iter: j.iter, h: j.h === "SHA-256" ? "SHA-256" : "SHA-384", iv: unb64(j.iv), ct: unb64(j.ct) }; };

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
  if (!state.me.pow) { state.me.pow = await solvePow(state.me.signPub, 18); if (state === S) persist(); } // solved once per account
  const send = () => fetch(BASE() + "/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sign: state.me.signPub, ecdh: state.me.ecdhPub, sig: state.me.sig, spk: spkPublic(cur), pow: state.me.pow, ...(state.me.consent ? { consent: state.me.consent } : {}) }) });
  let r = await send(), j = await r.json().catch(() => ({}));
  if (r.status === 400 && j.bits) { await sleep(0); state.me.pow = await solvePow(state.me.signPub, j.bits); if (state === S) persist(); r = await send(); j = await r.json().catch(() => ({})); }
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
function flushOutbox() {
  if (!dropReady || !S) return;
  // never let one oversized message block the queue (the server would drop the connection)
  for (const o of S.outbox.filter((x) => x.env.length > MAX_ENV)) { S.outbox.splice(S.outbox.indexOf(o), 1); if (o.local) setStatus(o.conv || o.to, o.local, "failed"); persist(); }
  S.outbox.forEach(dropSend);
}
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
const preview = (m) => (m.deleted ? "Message deleted" : m.kind === "img" ? (m.once ? "📷 View-once photo" : "📷 Photo") : m.kind === "file" ? "📄 " + (m.name || "File") : m.kind === "voice" ? "🎤 Voice message (" + fmtDur(m.dur || 0) + ")" : m.text);
async function ensurePeer(id) {
  if (id === S.me.id || peer(id)) return peer(id);
  S.hidden = S.hidden || {};
  S.hidden[id] = { id, ...(await fetchVerifiedKeys(id)), name: "" };
  return S.hidden[id];
}
const others = (g) => g.members.filter((x) => x !== S.me.id);
async function post(c, body, local, convId) {
  const o = { to: c.id, mid: rid(16), env: await seal(c, body), local, conv: convId || c.id };
  if (o.env.length > MAX_ENV) throw new Error("Too large to send");
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
function takeReply() { const r = replyTo; cancelReply(); return r ? { re: r } : {}; }
async function sendText(text) {
  const c = conv(current); if (!c) return;
  const ts = Date.now(), local = rid(12), timer = c.timer || 0, re = takeReply();
  await sendBody(current, local, { k: "text", mid: local, text, name: S.me.name, ts, timer, ...re }, { mid: local, me: true, text, ts, status: "sending", exp: timer ? ts + timer : 0, ...re });
}
async function sendKind(id, kind, fields) { // files and voice messages
  const c = conv(id); if (!c) return;
  const ts = Date.now(), local = rid(12), timer = c.timer || 0, re = takeReply();
  const { name: fname, ...rest } = fields; // "name" in the wire format is the sender's nickname
  await sendBody(id, local, { k: kind, mid: local, ...rest, ...(fname ? { fname } : {}), name: S.me.name, ts, timer, ...re }, { mid: local, me: true, kind, ...fields, ts, status: "sending", exp: timer ? ts + timer : 0, ...re });
}
async function sendCtl(id, body) { // reactions & deletions: no bubble of their own
  const c = conv(id); if (!c) return;
  try { if (isGroup(id)) await fanout(c, { ...body, gid: id }); else await post(c, body); } catch (e) { toast(e.message); }
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
  if (k === "react" || k === "del") {
    const ref = String(body.ref || ""), m = list.find((x) => x.mid === ref); if (!m) return;
    if (k === "react") { const e = String(body.e || "").slice(0, 8); m.rx = m.rx || {}; if (e && !/[<>&"']/.test(e)) m.rx[from] = e; else delete m.rx[from]; }
    else if (!m.me && m.from === from) { for (const f of ["text", "data", "name", "kind", "re", "rx", "once", "dur", "size", "mime"]) delete m[f]; m.deleted = true; }
    persist(); renderList(); if (current === cid) renderMessages(true); return;
  }
  const ts = Date.now(), timer = +body.timer || 0, exp = timer ? ts + timer : 0;
  const re = body.re && typeof body.re === "object" ? { re: { mid: safeMid(body.re.mid), who: ID_RE.test(body.re.who) ? body.re.who : "", text: String(body.re.text || "").slice(0, 140) } } : {};
  let msg;
  if (k === "timer" && !isGroup(cid)) {
    target.timer = TIMERS.some((t) => t[0] === +body.timer) ? +body.timer : 0;
    list.push({ mid, sys: true, text: target.timer ? `${displayName(c)} turned on disappearing messages (${timerLabel(target.timer)})` : `${displayName(c)} turned off disappearing messages`, ts });
  } else if (k === "text") msg = { mid, from, me: false, text: String(body.text || "").slice(0, 4000), ts, exp, ...re };
  else if (k === "img" && typeof body.data === "string" && body.data.length < 700000) msg = { mid, from, me: false, kind: "img", data: body.data, once: !!body.once, w: +body.w || 0, h: +body.h || 0, ts, exp, ...re };
  else if (k === "file" && typeof body.data === "string" && body.data.length < 2.9e6) msg = { mid, from, me: false, kind: "file", data: body.data, name: String(body.fname || "file").replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 80), mime: String(body.mime || "").slice(0, 80), size: +body.size || 0, ts, exp, ...re };
  else if (k === "voice" && typeof body.data === "string" && body.data.length < 1.6e6) msg = { mid, from, me: false, kind: "voice", data: body.data, mime: String(body.mime || "audio/mp4").slice(0, 60), dur: Math.min(600, +body.dur || 0), ts, exp, ...re };
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

// ---- generated avatars: a unique, symmetric pattern derived from the ID (no photos, nothing to leak) ----
const icCache = new Map();
function identicon(key) {
  if (icCache.has(key)) return icCache.get(key);
  const h = sha256(enc.encode("gc-avatar:" + key)), b = h.flatMap((x) => [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]);
  const hue = Math.round((b[0] / 256) * 360), hue2 = (hue + 25 + (b[1] % 40)) % 360;
  const fg = `hsl(${hue},62%,70%)`, fg2 = `hsl(${hue2},70%,82%)`, bg = `hsl(${hue},28%,15%)`;
  let cells = "";
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    const bit = (b[2 + y] >> x) & 1; if (!bit) continue;
    const col = (b[8 + y * 3 + x] & 1) ? fg : fg2;
    for (const xx of x === 2 ? [2] : [x, 4 - x]) cells += `<rect x="${1 + xx * 1.2}" y="${1 + y * 1.2}" width="1.05" height="1.05" rx=".28" fill="${col}"/>`;
  }
  const svg = `<svg viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8" fill="${bg}"/>${cells}</svg>`;
  icCache.set(key, svg); return svg;
}
const avatarHtml = (key, grp) => `<div class="avatar ${grp ? "group" : ""}">${identicon(key)}</div>`;
const IC = { // small line icons
  pin: '<svg viewBox="0 0 24 24"><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3zM12 14v7"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4.5"/><path d="m11.2 11.8 8.3-8.3M16 7l2.5 2.5M14 9l2 2"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M4 19h16"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.4 4-6.5 8-6.5s7.2 2.1 8 6.5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19.5 8.5a2.8 2.8 0 0 0-4-4L4 16z"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3M7.5 7.5 12 3l4.5 4.5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  qr: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.2"/><path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  ghost: '<svg viewBox="0 0 24 24"><path d="M12 3a7 7 0 0 0-7 7v10l2.3-1.8L9.7 20l2.3-1.8 2.3 1.8 2.4-1.8L19 20V10a7 7 0 0 0-7-7z"/><circle cx="9.5" cy="10.5" r=".8"/><circle cx="14.5" cy="10.5" r=".8"/></svg>',
  siren: '<svg viewBox="0 0 24 24"><path d="M7 18v-6a5 5 0 0 1 10 0v6M5 18h14v3H5zM12 3v2M4.5 6l1.4 1.4M19.5 6l-1.4 1.4"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><path d="M7 10V7a5 5 0 0 1 10 0v3"/><rect x="4.5" y="10" width="15" height="11" rx="2.5"/></svg>',
  fire: '<svg viewBox="0 0 24 24"><path d="M12 21c4 0 7-2.8 7-6.8 0-3.9-3-6.2-4.3-9.7-.6 2.4-2 3.6-3.4 4.4C10.6 6.6 9 5 9 3c-3.3 2.6-5 6.1-5 9.6C4 17.6 7.6 21 12 21z"/></svg>',
  bt: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10-5 4V3l5 4L7 17"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.1"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.4-7.5 10-7.5 10z"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  dot: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 16.5v.1"/></svg>',
  reply: '<svg viewBox="0 0 24 24"><path d="M10 6 4 12l6 6M4 12h10a6 6 0 0 1 6 6"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
  photo: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8L10 4h4l1.7 2h1.8A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.5"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z"/></svg>',
  group: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18.2 14.8c1.9.8 3 2.5 3.3 5.2"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 18.5V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8.5z"/></svg>',
  read: '<svg viewBox="0 0 24 24"><path d="m3 12.5 4.5 4.5L17 7.5M11.5 16l1 1L22 7.5"/></svg>',
  timer: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/></svg>',
};
const rowItem = (icon, label, sub, attrs = "", cls = "") =>
  `<button class="row-item menu-item ${cls}" ${attrs}><span class="ri">${IC[icon] || ""}</span><span class="rt">${label}${sub ? `<span class="rs">${sub}</span>` : ""}</span>${cls.includes("danger") ? "" : IC.chev}</button>`;

// ---- tabs ----
let tab = "chats", listFilter = "all";
function setTab(t) {
  tab = t;
  for (const v of ["chats", "security", "you"]) $("#view-" + v).classList.toggle("hidden", v !== t);
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  if (t === "you") renderYou(); else if (t === "security") renderSecurity(); else renderList();
}
const chatKey = (c) => c.gid || c.id;
function renderList() {
  if (!S) return;
  const q = $("#search").value.trim().toLowerCase();
  const all = [...Object.values(S.contacts), ...Object.values(S.groups || {})];
  const unreadChats = all.filter((c) => c.unread).length, unreadMsgs = all.reduce((n, c) => n + (c.unread || 0), 0);
  $("#unread-n").textContent = unreadChats || "";
  const tb = $("#tab-badge"); tb.textContent = unreadMsgs > 99 ? "99+" : unreadMsgs; tb.classList.toggle("hidden", !unreadMsgs);
  $("#tab-av").innerHTML = identicon(S.me.id);
  const items = all.filter((c) => (!q || displayName(c).toLowerCase().includes(q) || (c.id || "").toLowerCase().includes(q)) &&
      (listFilter === "all" || (listFilter === "unread" && c.unread) || (listFilter === "groups" && c.gid) || (listFilter === "pinned" && c.pinned)))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.pinned || 0) - (a.pinned || 0) || (b.last?.ts || b.added || 0) - (a.last?.ts || a.added || 0));
  $("#empty-list").classList.toggle("hidden", all.length > 0);
  const html = items.map((c) => { const key = chatKey(c); return `
    <div class="chat-item ${key === current ? "active" : ""} ${c.unread ? "unread" : ""}" data-id="${esc(key)}">
      ${avatarHtml(key, !!c.gid)}
      <div class="meta">
        <div class="row"><span class="name">${esc(displayName(c))}${c.request ? '<span class="tag">NEW</span>' : ""}</span><span class="time">${c.last ? fmtTime(c.last.ts) : ""}</span></div>
        <div class="row"><span class="last">${c.last ? (c.last.me ? "You: " : "") + esc(c.last.text) : '<span class="muted">' + (c.gid ? c.members.length + " members" : esc(c.id)) + "</span>"}</span>
          <span class="icons">${c.timer ? IC.timer : ""}${c.pinned ? IC.pin : ""}${c.unread ? `<span class="badge">${c.unread}</span>` : ""}</span></div>
      </div>
    </div>`; }).join("");
  $("#chat-list").innerHTML = html || (all.length ? `<div class="list-empty">Nothing here${listFilter !== "all" ? " — try “All”" : ""}.</div>` : "");
}
function chatItemMenu(id) {
  const c = conv(id); if (!c) return;
  menu(displayName(c), "", [
    [c.pinned ? "📌  Unpin chat" : "📌  Pin chat", () => { c.pinned = c.pinned ? 0 : Date.now(); persist(); renderList(); }],
    [c.unread ? "✓  Mark as read" : "●  Mark as unread", () => { c.unread = c.unread ? 0 : 1; persist(); renderList(); }],
    [c.gid ? "🚪  Leave group" : "🗑️  Delete chat", () => { current = id; c.gid ? leaveGroup(c) : deleteChat(); }, "danger"],
  ]);
}

// ---- You ----
function renderYou() {
  if (!S) return;
  $("#you-body").innerHTML = `
    <div class="me-hero">
      <div class="me-av">${identicon(S.me.id)}</div>
      <button class="me-name" id="you-name">${esc(S.me.name || "Add a nickname")} ${IC.edit}</button>
      <div class="me-id" id="you-id">${S.me.id}</div>
      <div class="me-actions">
        <button id="you-qr">${IC.qr}QR code</button>
        <button id="you-share">${IC.share}Share link</button>
        <button id="you-copy">${IC.copy}Copy ID</button>
      </div>
    </div>
    ${STORAGE_MODE !== "indexeddb" ? `<div class="notice">⚠️ This browser may erase GhostChat when it closes. Keep an encrypted backup.</div>` : ""}
    <div class="card-h">Account</div>
    <div class="card">
      ${rowItem("save", "Encrypted backup", S.settings.backupAt ? "Last saved " + fmtTime(S.settings.backupAt) : "Not saved yet", 'data-act="backup"')}
      ${rowItem("key", "Change passcode", "", 'data-act="pass"')}
      ${rowItem("user", "My ID & invite link", "", 'data-act="myid"')}
    </div>
    <div class="card-h">Messages</div>
    <div class="card">
      ${rowItem("star", "Starred messages", "", 'data-act="starred"')}
      ${rowItem("bell", "Notifications", "Never show names or text", 'data-act="notif"')}
      ${NATIVE ? rowItem("bt", "Offline Bluetooth mesh", "", 'data-act="mesh"') : ""}
    </div>
    <div class="card-h">About</div>
    <div class="card">
      ${rowItem("shield", "Privacy & your data", "Your rights, consent, grievance officer", 'data-act="privacy"')}
      ${rowItem("info", "Security details", "Encryption, keys and connection", 'data-act="secinfo"')}
      ${rowItem("heart", "Invite a friend", "Share your private invite link", 'data-act="invite"')}
    </div>
    <p class="ver">GhostChat 6.1 · no phone · no email · no trace</p>`;
  $("#you-name").onclick = renameSelf;
  $("#you-qr").onclick = myQrDialog;
  $("#you-share").onclick = shareInvite;
  $("#you-copy").onclick = () => copy(S.me.id, "ID copied");
}
async function shareInvite() {
  const url = inviteLink();
  if (navigator.share) { try { await navigator.share({ title: "GhostChat", text: "Message me privately on GhostChat:", url }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
  copy(url, "Invite link copied");
}
function myQrDialog() {
  modal("Scan to chat with me", `<div class="qr">${self.QR ? QR(inviteLink(), "#141210") : ""}</div><div class="idbox">${S.me.id}</div><p class="muted small center">Anyone who scans this can message you. It contains only your anonymous ID.</p>`,
    [["Share link", () => { shareInvite(); return true; }, "primary"], ["Copy ID", () => { copy(S.me.id); return true; }], ["Close", () => {}]]);
}
function starredDialog() {
  const out = [];
  for (const [cid, list] of Object.entries(S.msgs)) for (const m of list) if (m.star && !m.sys) out.push({ cid, m });
  out.sort((a, b) => b.m.ts - a.m.ts);
  modal("Starred messages", out.length ? out.map(({ cid, m }) => `<div class="starred-item" data-c="${esc(cid)}" data-m="${esc(m.mid)}"><b>${esc(conv(cid) ? displayName(conv(cid)) : "Chat")} · ${fmtTime(m.ts)}</b><div>${esc(preview(m))}</div></div>`).join("") : `<p class="muted">Long-press any message and choose <b>Star</b> to keep it here.</p>`, [["Close", () => {}]]);
  document.querySelectorAll(".starred-item").forEach((el) => el.onclick = () => { closeModal(); setTab("chats"); openChat(el.dataset.c); jumpTo(el.dataset.m); });
}

// ---- Security center ----
function renderSecurity() {
  if (!S) return;
  const checks = [
    [true, "End-to-end encrypted", "Post-quantum, sealed sender, new key for every message"],
    [true, "Locked vault", "Everything on this device is encrypted with your passcode"],
    [!!S.settings.backupAt, "Encrypted backup saved", "So you can recover if this device is lost", "backup", "Back up"],
    [!!LS.get("duress"), "Duress passcode", "A second passcode that silently erases everything", "panic", "Set up"],
    [(+LS.get("autoerase") || 0) > 0, "Auto-erase", "Wipe the app if it isn't unlocked for a while", "panic", "Turn on"],
    [S.settings.burnRemote !== false, "Remote erase", "Panic also erases your chats from contacts' phones", "panic", "Turn on"],
    [IS_ONION, IS_ONION ? "Hidden connection (Tor)" : "Fast connection", IS_ONION ? "Your IP address is hidden from the server" : "Messages are encrypted, but the server can see your IP. Use the .onion address for full anonymity."],
  ];
  const ok = checks.filter((c) => c[0]).length, pct = Math.round((ok / checks.length) * 100), C = 2 * Math.PI * 30;
  $("#sec-body").innerHTML = `
    <div class="shield-card">
      <div class="score"><svg viewBox="0 0 74 74"><circle cx="37" cy="37" r="30" stroke="#2a2a2f" stroke-width="7" fill="none"/><circle cx="37" cy="37" r="30" stroke="url(#sg)" stroke-width="7" fill="none" stroke-linecap="round" stroke-dasharray="${(C * pct) / 100} ${C}"/><defs><linearGradient id="sg"><stop offset="0" stop-color="#f3dc9b"/><stop offset="1" stop-color="#a7843c"/></linearGradient></defs></svg><b>${pct}</b></div>
      <div><h3>${pct >= 85 ? "Fortress mode" : pct >= 60 ? "Well protected" : "Basic protection"}</h3><p>${ok} of ${checks.length} protections active. Finish the rest for maximum safety.</p></div>
    </div>
    <div class="card">${checks.map(([on, t, d, act, btn]) => `<div class="check ${on ? "ok" : "todo"}"><span class="ck">${on ? IC.ok : IC.dot}</span><span class="ct">${t}<small>${d}</small></span>${!on && act ? `<button data-act="${act}">${btn}</button>` : ""}</div>`).join("")}</div>
    <div class="card-h">Protection</div>
    <div class="card">
      ${rowItem("siren", "Panic settings", "Duress passcode, auto-erase, wipe gestures", 'data-act="panic"')}
      ${rowItem("ghost", "Stealth", "Calculator disguise, decoy account", 'data-act="stealth"')}
      ${rowItem("shield", "Security details", "", 'data-act="secinfo"')}
      ${rowItem("lock", "Lock now", "", 'data-act="lock"')}
    </div>
    <div class="card">${rowItem("fire", "Erase everything", "Instantly destroys this account and all chats", 'data-act="wipe"', "danger")}</div>`;
}
const ACTIONS = { backup: () => backupDialog(), pass: () => passDialog(), myid: () => myIdDialog(), starred: () => starredDialog(), notif: () => enableNotifs(), mesh: () => meshDialog(),
  secinfo: () => securityDialog(), privacy: () => privacyDialog(), invite: () => shareInvite(), panic: () => panicSettings(), stealth: () => stealthDialog(), lock: () => lockNow(), wipe: () => wipeDialog() };
for (const id of ["#you-body", "#sec-body"]) $(id).addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b && ACTIONS[b.dataset.act]) ACTIONS[b.dataset.act](); });

function headerFor(c) {
  const key = chatKey(c);
  const av = $("#chat-avatar"); av.className = "avatar" + (c.gid ? " group" : ""); av.innerHTML = identicon(key);
  $("#chat-name").textContent = displayName(c);
  $("#chat-sub").textContent = (c.gid ? c.members.map(memberName).join(", ") : c.id) + (c.timer ? " · ⏱ " + timerLabel(c.timer) : "");
}
function openChat(id) {
  if (current !== id) { cancelReply(); closeFind(); seen = new Set(); seenFor = null; }
  current = id; const c = conv(id); c.unread = 0; persist();
  $("#main").classList.add("in-chat"); $("#no-chat").classList.add("hidden"); $("#chat").classList.remove("hidden");
  renderMessages(); renderList();
  if (matchMedia("(min-width: 800px)").matches) $("#msg-input").focus();
}
function closeChat() { current = null; cancelReply(); closeFind(); stopVoice(); $("#main").classList.remove("in-chat"); $("#chat").classList.add("hidden"); $("#no-chat").classList.remove("hidden"); renderList(); }
const TICK = { sending: "🕓", sent: "✓", delivered: "✓✓", failed: "⚠" };
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const fmtDur = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
function waveBars(m) { // stable pseudo-waveform from the audio bytes
  const d = m.data || ""; let out = "";
  for (let i = 0; i < 28; i++) { const c = d.charCodeAt(Math.floor((i + 1) * d.length / 30)) || 70; out += `<i class="h${(c * 37 + i * 13) % 9}"></i>`; }
  return out;
}
function bubbleBody(m) {
  if (m.deleted) return `<span class="deleted">This message was deleted</span>`;
  if (m.kind === "file") {
    const ext = (String(m.name || "").split(".").pop() || "FILE").slice(0, 4).toUpperCase();
    return `<button class="filecard" data-file="${esc(m.mid)}"><span class="fi">${esc(ext)}</span><span><span class="fn">${esc(m.name || "file")}</span><span class="fs">${fmtSize(m.size || 0)} · tap to save</span></span></button>`;
  }
  if (m.kind === "voice") return `<div class="voice" data-voice="${esc(m.mid)}"><button class="play" data-play="${esc(m.mid)}" aria-label="Play">${playing === m.mid ? IC.pause : IC.play}</button><div class="wave">${waveBars(m)}</div><span class="vd">${fmtDur(m.dur || 0)}</span></div>`;
  if (m.kind !== "img") return esc(m.text);
  if (m.data && !m.once) return `<img class="photo" src="${esc(photoUrl(m.mid, m.data))}" data-mid="${esc(m.mid)}" alt="Photo" />`;
  if (m.me) return `<span class="once">📷 View-once photo</span>`;
  if (m.data) return `<button class="once open" data-mid="${esc(m.mid)}">📷 View-once photo · tap to open</button>`;
  return `<span class="once muted">📷 Opened</span>`;
}
let findQ = "", seen = new Set(), seenFor = null;
function renderMessages(keepScroll) {
  const c = S && conv(current); if (!c) return;
  headerFor(c);
  const grp = !!c.gid, box = $("#messages"), prev = box.scrollTop, atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  let html = `<div class="sys">🔒 Post-quantum, sealed-sender encryption. The server can't read these messages or see who sent them.</div>`;
  if (c.request) html += `<div class="sys">${grp ? "Someone you haven't added put you in this group." : "Someone you haven't added messaged you."} They only know your anonymous ID. Reply to accept, or ${grp ? "leave the group" : "delete the chat"}.</div>`;
  if (c.removed) html += `<div class="sys">You're no longer a member of this group.</div>`;
  let lastDay = "", hits = 0;
  const q = findQ.toLowerCase();
  for (const m of msgs(current)) {
    if (q && (m.sys || !String(m.kind === "file" ? m.name : m.text || "").toLowerCase().includes(q))) continue;
    hits++;
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { html += `<div class="day">${new Date(m.ts).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</div>`; lastDay = day; }
    if (m.sys) { html += `<div class="sys">${esc(m.text)}</div>`; continue; }
    const tick = m.me && !m.deleted ? `<span class="tick ${m.status}">${TICK[m.status] || ""}</span>` : "";
    const who = grp && !m.me && m.from ? `<span class="who ${colorClass(m.from)}t">${esc(memberName(m.from))}</span>` : "";
    const quote = m.re && !m.deleted ? `<span class="quote" data-jump="${esc(m.re.mid)}"><b>${esc(m.re.who === S.me.id ? "You" : memberName(m.re.who))}</b>${esc(m.re.text)}</span>` : "";
    const fresh = seenFor === current && !seen.has(m.mid); seen.add(m.mid);
    html += `<div class="msg ${m.me ? "me" : "them"} ${m.kind === "img" && !m.deleted ? "img" : ""} ${fresh ? "pop" : ""}" data-m="${esc(m.mid)}">${who}${quote}${bubbleBody(m)}<span class="foot">${m.star ? `<span class="star-ico">${IC.star}</span>` : ""}${m.exp ? "⏱" : ""}${new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${tick}</span></div>`;
    const rx = Object.entries(m.rx || {});
    if (rx.length) {
      const counts = {}; for (const [, e] of rx) counts[e] = (counts[e] || 0) + 1;
      html += `<div class="rx">${Object.entries(counts).map(([e, n]) => `<span class="${m.rx[S.me.id] === e ? "mine" : ""}">${esc(e)}${n > 1 ? " " + n : ""}</span>`).join("")}</div>`;
    }
  }
  seenFor = current;
  if (q) $("#find-n").textContent = hits ? hits + " found" : "No matches";
  box.innerHTML = html;
  box.scrollTop = keepScroll && !atBottom ? prev : box.scrollHeight;
}
function jumpTo(mid) {
  const el = document.querySelector(`.msg[data-m="${CSS.escape(mid)}"]`); if (!el) return toast("Message no longer available");
  el.scrollIntoView({ block: "center", behavior: "smooth" }); el.classList.add("hl"); setTimeout(() => el.classList.remove("hl"), 1400);
}
$("#messages").addEventListener("click", (e) => {
  if (longFired) return;
  const j = e.target.closest("[data-jump]"); if (j) return jumpTo(j.dataset.jump);
  const p = e.target.closest("[data-play]"); if (p) return toggleVoice(p.dataset.play);
  const f = e.target.closest("[data-file]"); if (f) return saveFile(f.dataset.file);
  const t = e.target.closest("[data-mid]"); if (t) viewPhoto(t.dataset.mid);
});

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


// ---------------- message actions: long-press / right-click ----------------
let longFired = false;
function onLongPress(root, selector, cb) {
  let t = null, sx = 0, sy = 0;
  root.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(selector); if (!el || e.button > 0) return;
    longFired = false; sx = e.clientX; sy = e.clientY;
    clearTimeout(t); t = setTimeout(() => { longFired = true; if (navigator.vibrate) navigator.vibrate(12); cb(el); }, 430);
  });
  const cancel = () => clearTimeout(t);
  root.addEventListener("pointerup", () => { cancel(); setTimeout(() => (longFired = false), 50); });
  root.addEventListener("pointercancel", cancel);
  root.addEventListener("pointermove", (e) => { if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 10) cancel(); });
  root.addEventListener("contextmenu", (e) => { const el = e.target.closest(selector); if (el) { e.preventDefault(); cb(el); } });
}
const REACTS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
function msgMenu(mid) {
  const id = current, m = msgs(id).find((x) => x.mid === mid); if (!m || m.sys) return;
  const mine = (m.rx || {})[S.me.id];
  const items = [];
  if (!m.deleted) items.push(["↩️  Reply", () => startReply(m)]);
  if (!m.deleted && m.text) items.push(["📋  Copy text", () => copy(m.text, "Copied")]);
  if (!m.deleted && m.kind === "file") items.push(["⬇️  Save file", () => saveFile(m.mid)]);
  if (!m.deleted) items.push([m.star ? "☆  Unstar" : "⭐  Star", () => { m.star = !m.star; persist(); renderMessages(true); }]);
  items.push(["🗑️  Delete for me", () => { removeMsg(id, mid); }, "danger"]);
  if (m.me && !m.deleted) items.push(["🔥  Delete for everyone", () => deleteForAll(id, m), "danger"]);
  menu("", `${m.deleted ? "" : `<div class="emoji-row">${REACTS.map((e) => `<button data-e="${e}" class="${mine === e ? "on" : ""}">${e}</button>`).join("")}</div>`}<div class="preview-msg">${esc(preview(m))}</div>`, items);
  document.querySelectorAll(".emoji-row button").forEach((b) => b.onclick = () => { closeModal(); react(id, m, b.dataset.e); });
}
function react(id, m, e) {
  m.rx = m.rx || {};
  const next = m.rx[S.me.id] === e ? "" : e;
  if (next) m.rx[S.me.id] = next; else delete m.rx[S.me.id];
  persist(); renderMessages(true);
  sendCtl(id, { k: "react", mid: rid(), ref: m.mid, e: next, name: S.me.name });
}
function removeMsg(id, mid) {
  S.msgs[id] = msgs(id).filter((x) => x.mid !== mid);
  const c = conv(id), l = [...S.msgs[id]].reverse().find((x) => !x.sys); if (c) c.last = l ? { text: preview(l), ts: l.ts, me: l.me } : null;
  persist(); renderMessages(true); renderList();
}
function deleteForAll(id, m) {
  for (const f of ["text", "data", "name", "kind", "re", "rx", "once", "dur", "size", "mime"]) delete m[f];
  m.deleted = true; persist(); renderMessages(true); renderList();
  sendCtl(id, { k: "del", mid: rid(), ref: m.mid, name: S.me.name });
}
let replyTo = null;
function startReply(m) {
  replyTo = { mid: m.mid, who: m.me ? S.me.id : m.from || current, text: preview(m).slice(0, 140) };
  $("#rb-who").textContent = replyTo.who === S.me.id ? "Replying to yourself" : "Replying to " + memberName(replyTo.who);
  $("#rb-text").textContent = replyTo.text; $("#reply-bar").classList.remove("hidden"); $("#msg-input").focus();
}
function cancelReply() { replyTo = null; $("#reply-bar").classList.add("hidden"); }

// ---------------- in-chat search ----------------
function openFind() { $("#find-bar").classList.remove("hidden"); $("#find-input").value = ""; $("#find-n").textContent = ""; $("#find-input").focus(); }
function closeFind() { findQ = ""; $("#find-bar").classList.add("hidden"); if (current) renderMessages(); }

// ---------------- attach: photo, camera, file ----------------
function attachSheet() {
  modal("", `<div class="attach-grid">
      <button data-a="photo"><span class="ai">${IC.photo}</span>Photo</button>
      <button data-a="camera"><span class="ai">${IC.camera}</span>Camera</button>
      <button data-a="file"><span class="ai">${IC.doc}</span>Document</button>
    </div><p class="muted small center mt">Photos are cleaned of location and camera data. Files up to ${fmtSize(MAX_FILE())}.</p>`, [["Cancel", () => {}]]);
  document.querySelectorAll(".attach-grid button").forEach((b) => b.onclick = () => {
    closeModal(); const f = $("#file");
    if (b.dataset.a === "file") return $("#file-doc").click();
    if (b.dataset.a === "camera") f.setAttribute("capture", "environment"); else f.removeAttribute("capture");
    f.click();
  });
}
function fileDialog(file) {
  const id = current; if (!conv(id)) return;
  if (file.size > MAX_FILE()) return toast(`Too large — the limit is ${fmtSize(MAX_FILE())}`);
  const name = String(file.name || "file").replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 80);
  modal("Send file", `<div class="filecard wide"><span class="fi">${esc((name.split(".").pop() || "FILE").slice(0, 4).toUpperCase())}</span><span><span class="fn">${esc(name)}</span><span class="fs">${fmtSize(file.size)}</span></span></div><p class="muted small mt">Encrypted end to end. Only the people in this chat can open it.</p>`,
    [["Send", async () => { const data = b64(new Uint8Array(await file.arrayBuffer())); await sendKind(id, "file", { data, name, mime: String(file.type || "").slice(0, 80), size: file.size }); }, "primary"], ["Cancel", () => {}]]);
}
const SAFE_TYPES = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", txt: "text/plain" };
function saveFile(mid) {
  const m = msgs(current).find((x) => x.mid === mid); if (!m || !m.data) return;
  const ext = String(m.name || "").split(".").pop().toLowerCase();
  if (NATIVE && NATIVE.saveFile) { try { NATIVE.saveFile(m.name || "file", SAFE_TYPES[ext] || m.mime || "", m.data); return; } catch {} }
  // never hand the browser something it could run as a web page (html, svg…): unknown types download as raw bytes
  const url = URL.createObjectURL(new Blob([unb64(m.data)], { type: SAFE_TYPES[ext] || "application/octet-stream" }));
  const a = document.createElement("a"); a.href = url; a.download = m.name || "file"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------- voice messages ----------------
const CAN_RECORD = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && window.isSecureContext);
let rec = null, recChunks = [], recStart = 0, recTimer = null, recStream = null, recSend = false;
async function startRecording() {
  if (rec) return;
  try { recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { return toast("Microphone access was blocked"); }
  const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || "";
  rec = new MediaRecorder(recStream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
  recChunks = []; recSend = false; recStart = Date.now();
  rec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  rec.onstop = async () => {
    const dur = (Date.now() - recStart) / 1000, mime = rec.mimeType || type || "audio/mp4", id = current, send = recSend;
    recStream.getTracks().forEach((t) => t.stop()); rec = null; clearInterval(recTimer);
    $("#rec-bar").classList.add("hidden"); $("#composer").classList.remove("hidden");
    if (!send || dur < 0.6) return;
    const buf = new Uint8Array(await new Blob(recChunks, { type: mime }).arrayBuffer());
    if (buf.length * 1.34 > 1.55e6) return toast("Voice message too long");
    await sendKind(id, "voice", { data: b64(buf), mime: mime.split(";")[0], dur: Math.round(dur) });
  };
  rec.start(250);
  $("#composer").classList.add("hidden"); $("#rec-bar").classList.remove("hidden"); $("#rec-time").textContent = "0:00";
  recTimer = setInterval(() => { const s = (Date.now() - recStart) / 1000; $("#rec-time").textContent = fmtDur(s); if (s >= MAX_VOICE_S) stopRecording(true); }, 250);
}
function stopRecording(send) { if (!rec) return; recSend = send; try { rec.stop(); } catch {} }
let playing = null;
const audioUrls = new Map();
function toggleVoice(mid) {
  const p = $("#player");
  if (playing === mid) { stopVoice(); return; }
  stopVoice();
  const m = msgs(current).find((x) => x.mid === mid); if (!m || !m.data) return;
  if (!audioUrls.has(mid)) audioUrls.set(mid, URL.createObjectURL(new Blob([unb64(m.data)], { type: m.mime || "audio/mp4" })));
  p.src = audioUrls.get(mid); playing = mid;
  p.play().catch(() => { toast("This device can't play that recording"); stopVoice(); });
  p.ontimeupdate = () => {
    const el = document.querySelector(`[data-voice="${CSS.escape(mid)}"]`); if (!el || !p.duration) return;
    const bars = el.querySelectorAll(".wave i"), n = Math.round((p.currentTime / (isFinite(p.duration) ? p.duration : m.dur || 1)) * bars.length);
    bars.forEach((b, i) => b.classList.toggle("p", i < n)); el.querySelector(".vd").textContent = fmtDur(p.currentTime);
  };
  p.onended = () => stopVoice();
  renderMessages(true);
}
function stopVoice() { const p = $("#player"); if (!playing) return; p.pause(); p.removeAttribute("src"); playing = null; if (current) renderMessages(true); }

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
const inviteLink = () => BASE() + "/app?add=" + S.me.id;
function myIdDialog() {
  modal("Your anonymous ID", `<div class="idbox">${S.me.id}</div><p class="muted small">Share this ID or your invite link. It isn't linked to your phone, email or name.</p>${STORAGE_MODE !== "indexeddb" ? `<p class="small warn">⚠️ This browser may erase GhostChat when it closes. Save a backup now: Menu → 💾 Encrypted backup.</p>` : ""}<p class="small">Nickname: <b>${esc(S.me.name || "(none)")}</b></p>`,
    [["Copy ID", () => { copy(S.me.id); return true; }, "primary"], ["Copy invite link", () => { copy(inviteLink(), "Invite link copied"); return true; }], ["Close", () => {}]]);
}
function renameSelf() {
  modal("Nickname", `<p class="muted small">Only people you message see it — it travels inside encrypted messages.</p><input id="nick" maxlength="30" />`,
    [["Save", () => { S.me.name = $("#nick").value.trim(); persist(); toast("Saved"); }, "primary"], ["Cancel", () => {}]]);
  $("#nick").value = S.me.name || "";
}
function markBackup() { S.settings.backupAt = Date.now(); persist(); if (tab !== "chats") setTab(tab); }
async function backupDialog() {
  await flush();
  const key = "GHOST3:" + btoa(toB64Blob(await IDB.get(slot)));
  modal("Encrypted backup", `
    <p>Your ID, keys, contacts and messages, <b>locked with your passcode</b>. To restore it you need this backup and your passcode.</p>
    <p class="muted small">Tor Browser erases site data when it closes. Keep this backup somewhere safe to restore your account next time.</p>
    <p class="small warn">Tap “Copy backup”, then paste it into Notes. If copying doesn't work: tap the box below, Select All, Copy.</p>
    <textarea class="keybox" id="bk" rows="6" readonly></textarea>`,
    [["Copy backup", () => { copy(key, "Backup copied — paste it into Notes"); markBackup(); return true; }, "primary"],
     ...(BUILTIN_CRYPTO ? [] : [["Download as file", () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([key], { type: "text/plain" })); a.download = "backup.txt"; a.click(); markBackup(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); return true; }]]),
     ["Done", () => {}]]);
  const bk = $("#bk"); bk.value = key; bk.onfocus = bk.onclick = () => { bk.select(); bk.setSelectionRange(0, key.length); };
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
        err("#re", BUILTIN_CRYPTO ? "Unlocking… a backup made on a computer can take a few minutes on iPhone — keep this screen open" : "Unlocking…");
        const blob = fromB64Blob(atob(raw.slice(7)));
        const v = await openVault(blob, $("#rp").value).catch(() => { throw new Error("Wrong passcode or damaged backup"); });
        slot = Math.random() < 0.5 ? "a" : "b";
        v.state.settings = { ...(v.state.settings || {}), other: "dummy" };
        const local = await localKdf();
        if (local.h !== v.kdf.h || local.iter !== v.kdf.iter) { // re-lock it with settings that are quick on this device
          vaultKdf = local; v.kdf = local; v.salt = rand(16); v.key = await deriveVaultKey($("#rp").value, v.salt, local.iter, local.h);
          vaultKey = v.key; vaultSalt = v.salt; S = v.state; await IDB.set(slot, await sealVault(S, v.key, v.salt, local)); S = null;
        } else { vaultKdf = v.kdf; await IDB.set(slot, blob); }
        await IDB.set(otherSlot(), await dummyLike(blob.ct.length));
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
      vaultSalt = rand(16); vaultKey = await deriveVaultKey(p, vaultSalt, vaultKdf.iter, vaultKdf.h); await flush(); toast("Passcode changed");
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
      const salt = rand(16), key = await deriveVaultKey(p, salt, vaultKdf.iter, vaultKdf.h);
      S.settings.other = "decoy"; await flush();
      await IDB.set(otherSlot(), await sealVault(st, key, salt, vaultKdf));
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
    [c.pinned ? "📌  Unpin chat" : "📌  Pin chat", () => { c.pinned = c.pinned ? 0 : Date.now(); persist(); renderList(); toast(c.pinned ? "Pinned" : "Unpinned"); }],
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

// ---------------- DPDP consent ----------------
const NOTICE_V = "2026-11"; // version of the privacy notice at /privacy
let memConsent = null; // when the browser blocks storage, /signin hands consent over in the link (?c=version.time)
(function () {
  const q = new URLSearchParams(location.search), c = q.get("c"), m = c && c.match(/^([\w-]{1,20})\.(\d{10,14})$/);
  if (!m) return;
  memConsent = { v: m[1], ts: +m[2], via: "web" };
  if (!LS.get("consent")) LS.set("consent", JSON.stringify(memConsent));
  q.delete("c"); history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : ""));
})();
function consentRec() {
  try { const c = JSON.parse(LS.get("consent") || "null"); if (c && c.v === NOTICE_V) return c; } catch {}
  return memConsent && memConsent.v === NOTICE_V ? memConsent : null;
}
function privacyDialog() {
  const c = S.me.consent || consentRec();
  modal("Privacy & your data", `
    <p class="small">GhostChat never asks for your name, phone number or email. What exists about you:</p>
    <div class="kv"><b>On our server</b><span>Your anonymous ID and public keys; encrypted messages waiting to be delivered (max 7 days)</span>
    <b>On this device</b><span>Your chats and keys, locked with your passcode</span><b>Never stored</b><span>Message contents (we can't read them), contacts, location, IP logs</span></div>
    <p class="small">Consent: ${c ? `given ${new Date(c.ts).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })} (notice ${esc(c.v)})` : "recorded on this device"}.</p>
    <p class="small muted">Your rights under the DPDP Act, 2023: access, correction, erasure, nomination and grievance redressal. Withdrawing consent erases this account everywhere.</p>`,
    [["Read the full privacy notice", () => { window.open(BASE() + "/privacy", "_blank", "noopener"); return true; }],
     ["Grievance officer & contact", () => { window.open(BASE() + "/contact", "_blank", "noopener"); return true; }],
     ["Withdraw consent & erase account", () => wipeDialog(), "danger"], ["Close", () => {}]]);
}

// ---------------- onboarding ----------------
// Make the keys and the signup proof-of-work in the background while the person types:
// on iPhone (plain-JavaScript crypto) this hides ~20–40 s of work.
let PRE = null;
function prepIdentity() {
  if (PRE) return;
  PRE = (async () => { const st = await newIdentity(""); const keys = K; st.me.pow = await solvePow(st.me.signPub, 18); return { st, keys }; })();
  PRE.catch(() => {});
}
$("#ob-create").onclick = async () => {
  const p1 = $("#ob-pass").value, p2 = $("#ob-pass2").value, b = $("#ob-create");
  if (!consentRec()) {
    if (!$("#ob-consent").checked || !$("#ob-adult").checked) return err("#ob-err", "Please accept the privacy notice and confirm you are 18 or older");
    LS.set("consent", JSON.stringify({ v: NOTICE_V, ts: Date.now(), via: "app" }));
  }
  if (weakPass(p1)) return err("#ob-err", weakPass(p1));
  if (p1 !== p2) return err("#ob-err", "Passcodes don't match");
  if (NATIVE) {
    const sv = $("#ob-server").value.trim().replace(/\/+$/, "");
    if (!/^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/[a-z2-7]{56}\.onion(:\d+)?|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(sv)) return err("#ob-err", "Enter the server address, e.g. http://abc…xyz.onion");
    NATIVE.setServer(sv);
  }
  err("#ob-err", ""); b.disabled = true; b.textContent = "Generating keys…";
  try {
    if (BUILTIN_CRYPTO) b.textContent = "Generating keys… (up to a minute on iPhone)";
    const pre = PRE && (await PRE.catch(() => null));
    powStop = false;
    if (pre) { S = pre.st; K = pre.keys; S.me.name = $("#ob-name").value.trim().slice(0, 30); }
    else S = await newIdentity($("#ob-name").value.trim().slice(0, 30));
    const cr = consentRec(); if (cr) S.me.consent = { v: cr.v, ts: cr.ts };
    S.settings.other = "dummy";
    slot = Math.random() < 0.5 ? "a" : "b";
    vaultKdf = await localKdf();
    vaultSalt = rand(16); vaultKey = await deriveVaultKey(p1, vaultSalt, vaultKdf.iter, vaultKdf.h);
    if (BUILTIN_CRYPTO) b.textContent = "Almost done…";
    await register(); await flush(); LS.set("fails", "0"); LS.set("seen", String(Date.now()));
    $("#ob-pass").value = $("#ob-pass2").value = "";
    await start(); setTimeout(myIdDialog, 250);
  } catch (e) { S = null; err("#ob-err", e.message || "Something went wrong"); b.disabled = false; b.textContent = "Create anonymous ID"; }
};
$("#ob-restore").onclick = () => { powStop = true; restoreDialog(); }; // free the CPU for the restore

async function enter(v) {
  S = v.state; vaultKey = v.key; vaultSalt = v.salt; vaultKdf = v.kdf || vaultKdf;
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
document.querySelectorAll(".tab").forEach((b) => b.onclick = () => setTab(b.dataset.tab));
$("#chips").onclick = (e) => { const c = e.target.closest(".chip"); if (!c) return; listFilter = c.dataset.f; document.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === c)); renderList(); };
$("#btn-chat-menu").onclick = chatMenu; $("#chat-head").onclick = chatMenu; $("#btn-lock").onclick = lockNow;
holdToWipe($("#btn-lock")); holdToWipe($("#lock-logo")); holdToWipe($("#calc-clear"));
$("#fab").onclick = () => menu("Start", "", [["💬  New chat", newChatDialog], ["👥  New group", newGroupDialog], ["🔳  Show my QR code", myQrDialog]]);
$("#btn-qr").onclick = myQrDialog; $("#btn-new-group").onclick = newGroupDialog;
$("#btn-share-empty").onclick = myQrDialog; $("#btn-back").onclick = closeChat;
$("#btn-plus").onclick = attachSheet;
$("#btn-attach").onclick = () => $("#file").click();
$("#file").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) photoDialog(f); };
$("#file-doc").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) (f.type.startsWith("image/") && /\.(jpe?g|png|heic|webp)$/i.test(f.name) ? photoDialog(f) : fileDialog(f)); };
$("#search").oninput = renderList;
$("#chat-list").onclick = (e) => { if (longFired) return; const it = e.target.closest(".chat-item"); if (it) openChat(it.dataset.id); };
onLongPress($("#chat-list"), ".chat-item", (el) => chatItemMenu(el.dataset.id));
onLongPress($("#messages"), ".msg", (el) => msgMenu(el.dataset.m));
$("#messages").addEventListener("dblclick", (e) => { const el = e.target.closest(".msg"); if (el) { const m = msgs(current).find((x) => x.mid === el.dataset.m); if (m && !m.deleted) react(current, m, "❤️"); } });
$("#btn-find").onclick = openFind; $("#find-close").onclick = closeFind;
$("#find-input").oninput = (e) => { findQ = e.target.value.trim(); renderMessages(); };
$("#rb-close").onclick = cancelReply;
if (!CAN_RECORD) $("#composer").classList.add("no-mic");
$("#btn-mic").onclick = () => { if (conv(current)?.removed) return toast("You're no longer in this group"); startRecording(); };
$("#rec-cancel").onclick = () => stopRecording(false); $("#rec-send").onclick = () => stopRecording(true);
const input = $("#msg-input");
const syncComposer = () => $("#composer").classList.toggle("has-text", !!input.value.trim());
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; syncComposer(); });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && matchMedia("(min-width: 800px)").matches) { e.preventDefault(); $("#composer").requestSubmit(); } });
$("#composer").onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; if (conv(current)?.removed) return toast("You're no longer in this group"); input.value = ""; input.style.height = "auto"; syncComposer(); sendText(t); input.focus(); };

(async function boot() {
  if (!subtle || !self.PQ) {
    const miss = [!self.PQ && "crypto bundle (pq.js) didn't load", !subtle && (IS_ONION ? "crypto engine" : "secure connection (use the .onion address in Tor/Onion Browser)")].filter(Boolean);
    document.body.textContent = "GhostChat v6.1 can't start here. Missing: " + miss.join("; ") + ".";
    return;
  }
  try { for (const k of Object.keys(localStorage)) if (/^gc2?_/.test(k)) localStorage.removeItem(k); } catch {} // old versions
  if (!NATIVE && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  applyDisguise(); noSpell();
  if (NATIVE) { $("#ob-server").value = NATIVE.server() || ""; if (!NATIVE.server()) $("#ob-server-wrap").classList.remove("hidden"); }
  let has = false;
  try {
    // don't even create an (empty) database until there's something to store
    const exists = !window.indexedDB ? true : indexedDB.databases ? (await indexedDB.databases()).some((d) => d.name === "gc") : true;
    has = exists && !!((await IDB.get("a")) || (await IDB.get("b")));
  } catch {}
  const ae = +LS.get("autoerase") || 0, seen = +LS.get("seen") || 0;
  if (has && ae && seen && Date.now() - seen > ae * 86400e3) { wiping = true; await localErase(); location.replace("/wipe?home=1"); return; } // dead-man's switch
  if (!has) {
    if (!NATIVE && !consentRec()) { location.replace("/signin" + location.search); return; } // DPDP notice & consent first
    if (consentRec()) $("#ob-consent-wrap").classList.add("hidden");
    $("#ob-privacy").href = BASE() + "/privacy"; $("#ob-terms").href = BASE() + "/terms";
    prepIdentity(); return show("onboard");
  }
  show(LS.get("disguise") ? "calc" : "lock");
})();
