"use strict";
// Raazdar owner panel. The admin key stays in this tab only (sessionStorage) and goes in a header.
const $ = (s) => document.querySelector(s);
let KEY = sessionStorage.getItem("rzadmin") || "";
async function api(op, body = {}) {
  const r = await fetch("/api/admin/" + op, { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": KEY }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || "Error " + r.status); e.status = r.status; throw e; }
  return j;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
const dur = (s) => (s > 86400 ? Math.floor(s / 86400) + "d " : "") + Math.floor((s % 86400) / 3600) + "h";
function stat(v, l) { return `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`; }
async function refresh() {
  try {
    const s = await api("stats");
    const red = Object.entries(s.redeemed || {}).map(([k, v]) => `${k}: ${v}`).join(", ") || "none yet";
    $("#stats").innerHTML = [
      stat(s.users, "registered IDs (RAM)"), stat(s.online, "online now"), stat(s.onlinePlus, "Plus online"), stat(s.onlineWork, "Work online"),
      stat(sum(s.issued), "codes made"), stat(s.used, "codes used"), stat(s.filesMB + " MB", `files waiting (${s.files})`), stat(s.queueMB + " MB", "messages waiting"),
      stat(`${s.ramMB} / ${s.ramTotalMB} MB`, "server memory"), stat(s.load, "CPU load"), stat(dur(s.uptime), "up for"), stat(s.calls ? "on" : "off", "calls relay"),
    ].join("") + `<div class="stat" style="grid-column:1/-1"><span>Redeemed by plan: ${esc(red)} · ${esc(s.version)}</span></div>`;
    if (document.activeElement !== $("#notice")) $("#notice").value = s.notice || "";
    return true;
  } catch (e) { if (e.status === 401 || e.status === 429) { signOut(); $("#lerr").textContent = e.message; } return false; }
}
function signOut() { KEY = ""; sessionStorage.removeItem("rzadmin"); $("#panel").classList.add("hidden"); $("#login").classList.remove("hidden"); $("#out").classList.add("hidden"); }
async function signIn() {
  KEY = $("#key").value.trim(); $("#lerr").textContent = "";
  if (await refresh()) { sessionStorage.setItem("rzadmin", KEY); $("#login").classList.add("hidden"); $("#panel").classList.remove("hidden"); $("#out").classList.remove("hidden"); $("#key").value = ""; }
}
$("#go").onclick = signIn; $("#key").onkeydown = (e) => { if (e.key === "Enter") signIn(); };
$("#out").onclick = signOut;
$("#tier").onchange = () => $("#seatsl").classList.toggle("hidden", $("#tier").value !== "work");
let last = null;
$("#make").onclick = async () => {
  try {
    last = await api("vouchers", { tier: $("#tier").value, months: +$("#months").value, seats: +$("#seats").value, count: +$("#count").value });
    $("#codelist").value = last.codes.join("\n"); $("#codes").classList.remove("hidden"); refresh();
  } catch (e) { alert(e.message); }
};
$("#copy").onclick = async () => { try { await navigator.clipboard.writeText($("#codelist").value); $("#copy").textContent = "Copied"; } catch { $("#codelist").select(); } };
$("#csv").onclick = () => {
  if (!last) return;
  const rows = ["code,plan,months,seats,made"].concat(last.codes.map((c) => `${c},${last.tier},${last.months},${last.seats || ""},${new Date().toISOString().slice(0, 10)}`));
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
  a.download = `raazdar-${last.tier}-${last.months}m-${Date.now()}.csv`; a.click();
};
$("#check").onclick = async () => {
  try {
    const r = await api("check", { code: $("#ccode").value });
    $("#cres").innerHTML = !r.valid ? `<span class="err">Not a valid Raazdar code</span>` : `<span class="${r.used ? "err" : "okc"}">${r.used ? "Already used or cancelled" : "Valid, not used yet"}</span> · ${esc(r.tier)} · ${r.months} months${r.tier === "work" ? " · " + r.seats + " seats" : ""} · #${r.serial}`;
  } catch (e) { $("#cres").textContent = e.message; }
};
$("#cancel").onclick = async () => {
  if (!confirm("Cancel this code? It can never be used after this.")) return;
  try { await api("cancel", { code: $("#ccode").value }); $("#cres").innerHTML = `<span class="okc">Cancelled</span>`; } catch (e) { $("#cres").textContent = e.message; }
};
$("#savenotice").onclick = async () => { try { await api("notice", { text: $("#notice").value }); $("#savenotice").textContent = "Saved ✓"; setTimeout(() => ($("#savenotice").textContent = "Save notice"), 1500); } catch (e) { alert(e.message); } };
if (KEY) signIn.call(null, ($("#key").value = KEY));
setInterval(() => { if (KEY) refresh(); }, 15000);
