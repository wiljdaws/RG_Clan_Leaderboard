// Boot + Firestore wiring. Same access pattern as ATLAS: SDK ESM from
// gstatic, unauthenticated reads, onSnapshot for both events/current and clans.
import { FIREBASE_CONFIG, COLLECTIONS, SDK } from "./config.js";
import { buildStandings, currentEventId, eventPhase } from "./scoring.js";
import { renderHeaderStats, renderPodium, renderStandings, renderPlayers,
         renderPhase, setEventTitle, setSyncLine, showDemoBanner, markSynced,
         renderPerms, setOpenClan, onPinToggle, onCompareToggle,
         pushTickerEvents, renderCompare, closeCompare,
         showEventEndReveal } from "./render.js";
import { DEMO } from "./demo-data.js";
import { recordSnapshot, clanMomentum, projectScore, detectRankChanges,
         detectBigGains, historySpanMs } from "./history.js";

let eventConfig = null;
let lastRawClans = [];

// UI controls state. Only viewMode / sortMode / filterQuery / pinnedIds
// affect what renders — everything else stays derived from Firestore.
let viewMode = "clans";       // "clans" | "players"
let sortMode = "score";       // "score" | "members" | "alpha"
let filterQuery = "";
const PINNED_STORAGE_KEY = "clashcup:pinnedClans";
const loadPinned = () => {
  try { return new Set(JSON.parse(localStorage.getItem(PINNED_STORAGE_KEY) || "[]")); }
  catch { return new Set(); }
};
const pinnedIds = loadPinned();
const savePinned = () =>
  localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify([...pinnedIds]));

// Head-to-head compare selection. Max 2; picking a third replaces the
// oldest so the vs button always feels responsive.
const compareSelection = new Set();

// Track prev phase so we can fire the celebration only on the transition
// into "ended", not repeatedly. localStorage guards against a repeat
// firing across page reloads for the same event id.
let lastPhase = null;
const REVEAL_KEY = "clashcup:endRevealShown";

const millisOf = t => (t?.toMillis ? t.toMillis() : (typeof t === "number" ? t : 0));

function parseEventDoc(d) {
  return {
    name: d.name ?? "Clan Clash Cup",
    startTime: millisOf(d.startTime),
    endTime: millisOf(d.endTime),
    maxMembers: typeof d.maxMembers === "number" ? d.maxMembers : null,
    perms: d.perms ?? null,
  };
}

// Apply user-controlled sort/filter/pin on top of the canonical score-sorted
// standings. Pinned clans float to the top but keep their canonical rank
// number so the display stays truthful.
function applyControls(standings) {
  const q = filterQuery.trim().toLowerCase();
  let list = q
    ? standings.filter(c =>
        c.tag.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.rows.some(r => r.name.toLowerCase().includes(q)))
    : standings.slice();
  if (sortMode === "members") list.sort((a, b) => b.members.length - a.members.length);
  else if (sortMode === "alpha") list.sort((a, b) => a.tag.localeCompare(b.tag));
  // Pinned first, preserving intra-group order.
  list.sort((a, b) => (pinnedIds.has(b.id) ? 1 : 0) - (pinnedIds.has(a.id) ? 1 : 0));
  return list;
}

function buildPlayerBoard(standings) {
  const rows = [];
  standings.forEach(c => c.rows.forEach(r => {
    if (r.delta == null) return;
    rows.push({ ...r, clanTag: c.tag, clanAccent: c.accent, clanId: c.id });
  }));
  rows.sort((a, b) => b.delta - a.delta);
  return rows.slice(0, 25);
}

function renderAll({ recordHistory = false } = {}) {
  const standings = buildStandings(lastRawClans, eventConfig);
  standings.forEach((c, i) => { c.rank = i + 1; });
  // History records happen once per real snapshot (not on UI-only re-renders
  // like tab switch or sort change), so momentum reflects data velocity
  // rather than click rate.
  if (recordHistory) recordSnapshot(standings);

  const evId = currentEventId(eventConfig);
  const waiting = evId ? lastRawClans.filter(c => c.eventId !== evId).length : 0;
  const allPlayers = buildPlayerBoard(standings);
  const mvpUserId = allPlayers[0]?.userId ?? null;

  // Build per-clan momentum + projection derived from history.
  const momentumById = new Map();
  standings.forEach(c => {
    const m = clanMomentum(c.id);
    momentumById.set(c.id, m);
  });
  // Project a rolling 3-hour horizon from the viewer's current time, clamped
  // to the event end so we don't extrapolate past when scoring stops. This
  // keeps the "at this pace" line responsive instead of anchored to a static
  // event-end clock the user can't easily reason about.
  const PROJECTION_HORIZON_MS = 3 * 60 * 60_000;
  const projectionTarget = eventConfig?.endTime
    ? Math.min(Date.now() + PROJECTION_HORIZON_MS, eventConfig.endTime)
    : null;
  const winnerProjection = projectionTarget && eventConfig?.startTime && standings[0]
    ? projectScore(standings[0].id, projectionTarget, { eventStartTime: eventConfig.startTime })
    : null;

  const ctx = {
    maxMembers: eventConfig?.maxMembers ?? null,
    pinned: pinnedIds,
    mvpUserId,
    momentumById,
    winnerProjection,
    winnerProjectionTarget: projectionTarget,
    winnerTag: standings[0]?.tag ?? null,
    endTime: eventConfig?.endTime ?? null,
    historyReady: historySpanMs() >= 60_000,
    compareSelection,
  };

  renderHeaderStats(standings, waiting);
  renderPodium(standings, ctx);
  renderPerms(eventConfig?.perms);

  // Fire the celebration once, exactly when phase transitions to ended.
  const phase = eventPhase(eventConfig);
  if (lastPhase && lastPhase !== "ended" && phase === "ended" && standings.length) {
    const evId = currentEventId(eventConfig);
    if (localStorage.getItem(REVEAL_KEY) !== evId) {
      localStorage.setItem(REVEAL_KEY, evId);
      showEventEndReveal(standings);
    }
  }
  lastPhase = phase;

  const clansBoard = document.getElementById("clansBoard");
  const playersBoard = document.getElementById("playersBoard");
  if (viewMode === "clans") {
    const list = applyControls(standings);
    renderStandings(list, { ...ctx, emptyReason: filterQuery ? "filter" : null });
    clansBoard.style.display = ""; playersBoard.style.display = "none";
  } else {
    const q = filterQuery.trim().toLowerCase();
    const players = buildPlayerBoard(standings);
    const filtered = q
      ? players.filter(p => p.name.toLowerCase().includes(q) || p.clanTag.toLowerCase().includes(q))
      : players;
    renderPlayers(filtered, { ...ctx, emptyReason: q ? "filter" : null });
    clansBoard.style.display = "none"; playersBoard.style.display = "";
  }
}

function loadDemo(reason) {
  console.warn("[ClashCup] falling back to demo data:", reason);
  showDemoBanner();
  setSyncLine("Demo mode — sample data mirroring <code>clans/{clanId}</code>.");
  eventConfig = { ...DEMO.event, maxMembers: 5, perms: null };
  const evId = currentEventId(eventConfig);
  DEMO.clans.forEach((c, i) => {
    c.eventId = evId;
    c.id = c.id ?? `demo-${i}`;
  });
  setEventTitle(eventConfig.name);
  renderPhase(eventConfig);
  lastRawClans = DEMO.clans;
  renderAll({ recordHistory: true });
  maybeApplyInitialHash();
}

async function boot() {
  let fb;
  try {
    const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${SDK}/firebase-app.js`);
    const { getFirestore, doc, collection, onSnapshot } =
      await import(`https://www.gstatic.com/firebasejs/${SDK}/firebase-firestore.js`);
    const app = initializeApp(FIREBASE_CONFIG);
    fb = { db: getFirestore(app), doc, collection, onSnapshot };
  } catch (e) { return loadDemo("SDK load failed: " + e.message); }

  try {
    fb.onSnapshot(fb.doc(fb.db, ...COLLECTIONS.eventDoc), snap => {
      if (!snap.exists()) { eventConfig = null; renderPhase(null); return; }
      eventConfig = parseEventDoc(snap.data());
      setEventTitle(eventConfig.name);
      renderPhase(eventConfig);
      renderAll();
    }, err => loadDemo("event listener: " + err.message));

    fb.onSnapshot(fb.collection(fb.db, COLLECTIONS.clans), snap => {
      lastRawClans = [];
      snap.forEach(ds => lastRawClans.push({ id: ds.id, ...ds.data() }));
      renderAll({ recordHistory: true });
      publishLiveEvents();
      markSynced();
      setSyncLine(`Live from Firestore <code>rgleaderboard</code>`);
      maybeApplyInitialHash();
    }, err => loadDemo("clans listener: " + err.message));
  } catch (e) { loadDemo(e.message); }
}

// Combine history-derived events into the ticker after each snapshot.
// Deduped by keeping tickerFeed capped and letting the module drop old rows.
function publishLiveEvents() {
  const events = [...detectRankChanges(), ...detectBigGains()];
  if (events.length) {
    pushTickerEvents(events);
    maybeNotify(events);
  }
}

// Deep link: #TAG opens that clan and scrolls to it once rendered.
// Matches on canonical short tag (case-insensitive) then falls back to
// clan.id, so both "#OG" and "#actualDocId" work.
function applyHashDeepLink() {
  const key = decodeURIComponent(location.hash.slice(1)).trim().toLowerCase();
  if (!key) return;
  const standings = buildStandings(lastRawClans, eventConfig);
  const target = standings.find(c =>
    (c.tagShort ?? "").toLowerCase() === key ||
    (c.tag ?? "").toLowerCase() === key ||
    c.id === key);
  if (!target?.id) return;
  setOpenClan(target.id, true);
  renderAll();
  requestAnimationFrame(() => {
    const el = document.querySelector(`.clan[data-clan-id="${CSS.escape(target.id)}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function toast(msg, ms = 1800) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function shareCurrentView() {
  const url = new URL(location.href);
  // If a clan is expanded, put its tag in the hash so the link deep-links.
  const openClan = document.querySelector(".clan.open");
  if (openClan) {
    const tag = openClan.querySelector(".clan-tag")?.textContent?.replace(/[\[\]]/g, "").trim();
    if (tag) url.hash = tag;
  }
  const href = url.toString();
  if (navigator.share) {
    try { await navigator.share({ title: document.title, url: href }); return; }
    catch { /* user dismissed — fall back to copy */ }
  }
  try {
    await navigator.clipboard.writeText(href);
    toast("Link copied");
  } catch {
    toast("Copy failed — long-press the URL bar");
  }
}

function toggleStreamMode() {
  const on = document.body.classList.toggle("stream-mode");
  document.getElementById("streamBtn").classList.toggle("on", on);
  if (on && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => { /* user gesture required */ });
  } else if (!on && document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}
document.addEventListener("fullscreenchange", () => {
  // Keep the class in sync if user pressed ESC to exit fullscreen.
  if (!document.fullscreenElement && document.body.classList.contains("stream-mode")) {
    document.body.classList.remove("stream-mode");
    document.getElementById("streamBtn").classList.remove("on");
  }
});

// Opt-in browser notifications for rank changes involving pinned clans.
const NOTIFY_KEY = "clashcup:notify";
let notifyEnabled = localStorage.getItem(NOTIFY_KEY) === "1";
let lastNotifyAt = 0;
const NOTIFY_MIN_INTERVAL = 30_000;
async function toggleNotify() {
  const btn = document.getElementById("notifyBtn");
  if (!("Notification" in window)) { toast("Notifications not supported here"); return; }
  if (notifyEnabled) {
    notifyEnabled = false;
    localStorage.setItem(NOTIFY_KEY, "0");
    btn.classList.remove("on");
    toast("Notifications off");
    return;
  }
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Permission denied"); return; }
  notifyEnabled = true;
  localStorage.setItem(NOTIFY_KEY, "1");
  btn.classList.add("on");
  toast("Notifications on");
}
function maybeNotify(events) {
  if (!notifyEnabled || Notification.permission !== "granted") return;
  if (Date.now() - lastNotifyAt < NOTIFY_MIN_INTERVAL) return;
  const relevant = events.find(e =>
    e.kind === "rank" && lastRawClans.some(c => c.id && pinnedIds.has(c.id) && stripBracket(c.tag ?? c.name) === stripBracket(e.tag)));
  if (!relevant) return;
  lastNotifyAt = Date.now();
  const body = relevant.direction === "up"
    ? `${relevant.tag} climbed to #${relevant.newRank} (from #${relevant.oldRank})`
    : `${relevant.tag} dropped to #${relevant.newRank} (from #${relevant.oldRank})`;
  new Notification("Clan Clash Cup", { body, icon: "assets/icon-192.png" });
}
const stripBracket = s => String(s ?? "").replace(/[\[\]]/g, "").trim();

async function screenshotStandings() {
  toast("Rendering PNG…", 3500);
  try {
    const { toPng } = await import("https://esm.sh/html-to-image@1.11.13");
    const target = document.querySelector(".wrap");
    const dataUrl = await toPng(target, {
      backgroundColor: "#060A18",
      pixelRatio: 2,
      filter: node => !node.classList?.contains?.("pin-btn") && !node.classList?.contains?.("vs-btn"),
    });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `clash-cup-${new Date().toISOString().slice(0, 16).replace(":", "")}.png`;
    a.click();
  } catch (e) {
    console.error(e);
    toast("Screenshot failed");
  }
}

function wireControls() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      if (tab.classList.contains("active")) return;
      document.querySelectorAll(".tab").forEach(t => {
        const on = t === tab;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on);
      });
      viewMode = tab.dataset.tab;
      renderAll();
    });
  });
  document.getElementById("filterInput").addEventListener("input", e => {
    filterQuery = e.target.value;
    renderAll();
  });
  document.getElementById("sortSelect").addEventListener("change", e => {
    sortMode = e.target.value;
    renderAll();
  });
  window.addEventListener("hashchange", applyHashDeepLink);

  document.getElementById("shareBtn").addEventListener("click", shareCurrentView);
  document.getElementById("shotBtn").addEventListener("click", screenshotStandings);
  document.getElementById("streamBtn").addEventListener("click", toggleStreamMode);
  document.getElementById("notifyBtn").addEventListener("click", toggleNotify);
  document.getElementById("pickCancel").addEventListener("click", () => {
    compareSelection.clear();
    updateCompareUI();
  });
  document.addEventListener("keydown", e => {
    // "F" (not in text inputs) toggles streamer mode.
    if ((e.key === "f" || e.key === "F") && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) {
      toggleStreamMode();
      return;
    }
    if (e.key === "Escape") {
      closeCompare();
      compareSelection.clear();
      updateCompareUI();
    }
  });
  // Reflect existing permission state on load so the button matches reality.
  if (notifyEnabled && "Notification" in window && Notification.permission === "granted") {
    document.getElementById("notifyBtn").classList.add("on");
  } else if (notifyEnabled) {
    // We had it enabled but permission was revoked externally.
    notifyEnabled = false;
    localStorage.setItem(NOTIFY_KEY, "0");
  }
}

onPinToggle(id => {
  if (pinnedIds.has(id)) pinnedIds.delete(id); else pinnedIds.add(id);
  savePinned();
  renderAll();
});

// Compare picker: click once, banner appears asking for a second clan.
// Click a second clan → open the modal. Click the same clan twice cancels.
onCompareToggle(id => {
  if (compareSelection.has(id)) {
    compareSelection.delete(id);
    updateCompareUI();
    return;
  }
  compareSelection.add(id);
  if (compareSelection.size > 2) {
    const first = compareSelection.values().next().value;
    compareSelection.delete(first);
  }
  if (compareSelection.size === 2) openCompare();
  updateCompareUI();
});

function openCompare() {
  const standings = buildStandings(lastRawClans, eventConfig);
  standings.forEach((c, i) => { c.rank = i + 1; });
  const [aId, bId] = [...compareSelection];
  const a = standings.find(c => c.id === aId);
  const b = standings.find(c => c.id === bId);
  renderCompare(a, b, { maxMembers: eventConfig?.maxMembers ?? null });
}

function updateCompareUI() {
  const banner = document.getElementById("pickBanner");
  const nameEl = document.getElementById("pickBannerA");
  if (compareSelection.size === 1) {
    const [id] = [...compareSelection];
    const standings = buildStandings(lastRawClans, eventConfig);
    const clan = standings.find(c => c.id === id);
    nameEl.textContent = clan?.tag ?? "…";
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  renderAll();
}

// First-render hook: apply any incoming URL hash once data is present.
let hashApplied = false;
const maybeApplyInitialHash = () => {
  if (hashApplied || !lastRawClans.length || !location.hash) return;
  hashApplied = true;
  applyHashDeepLink();
};

wireControls();
boot();
