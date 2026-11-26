// GhostChat website — small, dependency-free, no trackers, no cookies.
document.documentElement.classList.add("js");
(function () {
  // Old invite links (/?add=ID) and home-screen installs that still start at "/" go straight to the app.
  var qs = new URLSearchParams(location.search);
  var standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone;
  if (location.pathname === "/" && (qs.get("add") || standalone)) { location.replace("/app" + location.search); }
})();

var NOTICE_V = "2026-11";
function consent() { try { var c = JSON.parse(localStorage.getItem("gc3_consent") || "null"); return c && c.v === NOTICE_V ? c : null; } catch (e) { return null; } }
function hasAccount() { try { return !!localStorage.getItem("gc3_seen"); } catch (e) { return false; } }

document.addEventListener("DOMContentLoaded", function () {
  // mobile menu
  var b = document.getElementById("burger"), m = document.getElementById("mnav");
  if (b && m) b.onclick = function () { var o = m.classList.toggle("open"); b.setAttribute("aria-expanded", o); document.body.style.overflow = o ? "hidden" : ""; };

  // reveal on scroll
  var els = document.querySelectorAll(".rv");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }); }, { rootMargin: "0px 0px -60px 0px" });
    els.forEach(function (e) { io.observe(e); });
  } else els.forEach(function (e) { e.classList.add("in"); });

  // "Open app" buttons: straight to the app once consent was given on this device
  document.querySelectorAll("[data-open]").forEach(function (a) { if (consent()) a.setAttribute("href", "/app"); });

  // ---------- sign-in page ----------
  var box = document.getElementById("auth");
  if (!box) return;
  var go = document.getElementById("c-go"), checks = ["c-notice", "c-adult", "c-terms"].map(function (id) { return document.getElementById(id); });
  var mode = hasAccount() ? "in" : "new";
  function sync() { go.disabled = !checks.every(function (c) { return c.checked; }); }
  checks.forEach(function (c) { c.onchange = sync; });
  function setMode(m2) {
    mode = m2;
    document.querySelectorAll(".tabs button").forEach(function (t) { t.classList.toggle("on", t.dataset.m === m2); });
    document.getElementById("t-new").classList.toggle("hidden", m2 !== "new");
    document.getElementById("t-in").classList.toggle("hidden", m2 !== "in");
    go.textContent = m2 === "new" ? "Agree & create my anonymous ID" : "Agree & continue to unlock";
    if (consent()) go.textContent = m2 === "new" ? "Continue to create my ID" : "Continue to unlock";
  }
  document.querySelectorAll(".tabs button").forEach(function (t) { t.onclick = function () { setMode(t.dataset.m); }; });
  document.querySelectorAll(".lang button").forEach(function (l) {
    l.onclick = function () {
      document.querySelectorAll(".lang button").forEach(function (x) { x.classList.toggle("on", x === l); });
      document.querySelectorAll("[data-lang]").forEach(function (x) { x.classList.toggle("hidden", x.dataset.lang !== l.dataset.l); });
    };
  });
  var c = consent();
  if (c) {
    document.getElementById("consented").classList.remove("hidden");
    document.getElementById("c-when").textContent = new Date(c.ts).toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    checks.forEach(function (x) { x.checked = true; });
  }
  setMode(mode); sync();
  go.onclick = function () {
    if (go.disabled) return;
    var lang = (document.querySelector(".lang button.on") || {}).dataset;
    if (!consent()) try { localStorage.setItem("gc3_consent", JSON.stringify({ v: NOTICE_V, ts: Date.now(), lang: lang ? lang.l : "en", via: "web" })); } catch (e) {}
    var add = new URLSearchParams(location.search).get("add"), rec = consent() || { v: NOTICE_V, ts: Date.now() };
    // the consent also travels in the link, in case this browser blocks storage
    location.href = "/app?c=" + rec.v + "." + rec.ts + (add ? "&add=" + encodeURIComponent(add) : "") + location.hash;
  };
  var w = document.getElementById("c-withdraw");
  if (w) w.onclick = function (e) {
    e.preventDefault();
    if (hasAccount()) { alert("To withdraw consent, open GhostChat → You → Privacy & your data → Withdraw consent & erase account. This erases your account everywhere."); return; }
    try { localStorage.removeItem("gc3_consent"); } catch (x) {}
    location.reload();
  };
});
