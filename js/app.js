// Boot + Firestore wiring. Same access pattern as ATLAS: SDK ESM from
// gstatic, unauthenticated reads, onSnapshot for both events/current and clans.
import { FIREBASE_CONFIG, COLLECTIONS, SDK } from "./config.js";
import {
  buildStandings,
  buildWaitingRoster,
  currentEventId,
  eventPhase,
} from "./scoring.js";
import { renderHeaderStats, renderPodium, renderStandings, renderPlayers,
         renderPhase, setEventTitle, setSyncLine, markSynced,
         renderPerms, setOpenClan, onPinToggle, onCompareToggle,
         onCompareScreenshot,
         pushTickerEvents, renderCompare, closeCompare,
         showEventEndReveal, renderDataState, renderWaitingRoster,
         renderArchive, onArchiveSelect, onArchiveReplay, onArchiveClear,
         setNowProvider } from "./render.js";
import { DEMO } from "./demo-data.js";
import { recordSnapshot, clanMomentum, projectScore, detectRankChanges,
         detectBigGains, historySpanMs, listEventArchives, eventReplay,
         clearEventHistory, historyError } from "./history.js";
import {
  initClanAdmin,
  setAdminClans,
  setAdminEvent,
  setAdminNowProvider,
  showAdminUnavailable,
} from "./admin.js";
import {
  createServerClock,
  createSnapshotCoordinator,
  createVisibilityController,
  deriveDataMode,
  syncServerClock,
} from "./live-state.js";

let eventConfig = null;
let lastRawClans = [];
let online = navigator.onLine;
let demoMode = false;
let liveState = {
  hasCommitted: false,
  reconnecting: false,
  event: null,
  online,
};
const serverClock = createServerClock();
setNowProvider(serverClock.now);
setAdminNowProvider(serverClock.now);

// UI controls state. Only viewMode / sortMode / filterQuery / pinnedIds
// affect what renders — everything else stays derived from Firestore.
let viewMode = "clans";       // "clans" | "players" | "archive"
let sortMode = "score";       // "score" | "members" | "alpha"
let filterQuery = "";
let selectedArchiveId = null;
let archiveReplayIndex = -1;
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
    useClanReservations: d.useClanReservations === true,
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
  let historyChanged = false;
  const clansBoard = document.getElementById("clansBoard");
  const playersBoard = document.getElementById("playersBoard");
  const archiveBoard = document.getElementById("archiveBoard");
  const filterInput = document.getElementById("filterInput");
  const sortSelect = document.getElementById("sortSelect");
  const viewingArchive = viewMode === "archive";

  if (viewingArchive) {
    clansBoard.style.display = "none";
    playersBoard.style.display = "none";
    archiveBoard.style.display = "";
    filterInput.disabled = true;
    sortSelect.disabled = true;
  } else {
    archiveBoard.style.display = "none";
    filterInput.disabled = false;
    sortSelect.disabled = false;
  }

  if (!eventConfig) {
    if (viewingArchive) {
      renderArchivePanel();
      return historyChanged;
    }
    renderHeaderStats([], 0);
    renderPodium([]);
    renderPerms(null);
    renderWaitingRoster([]);
    if (viewMode === "clans") {
      renderStandings([], {
        emptyReason: liveState.eventError || liveState.clansError ? "error" : "event",
      });
      clansBoard.style.display = "";
      playersBoard.style.display = "none";
    } else {
      renderPlayers([], {
        emptyReason: liveState.eventError || liveState.clansError ? "error" : "event",
      });
      clansBoard.style.display = "none";
      playersBoard.style.display = "";
    }
    return historyChanged;
  }

  const standings = buildStandings(lastRawClans, eventConfig);
  standings.forEach((c, i) => { c.rank = i + 1; });
  // History records happen once per real snapshot (not on UI-only re-renders
  // like tab switch or sort change), so momentum reflects data velocity
  // rather than click rate.
  if (recordHistory) {
    historyChanged = recordSnapshot(eventConfig, standings, serverClock.now());
  }

  const evId = currentEventId(eventConfig);
  const waitingRoster = buildWaitingRoster(lastRawClans, eventConfig);
  const waiting = waitingRoster.reduce((sum, group) => sum + group.members.length, 0);
  const allPlayers = buildPlayerBoard(standings);
  const mvpUserId = allPlayers[0]?.userId ?? null;

  // Build per-clan momentum + projection derived from history.
  const momentumById = new Map();
  standings.forEach(c => {
    const m = clanMomentum(evId, c.id);
    momentumById.set(c.id, m);
  });
  // Project a rolling 3-hour horizon from the viewer's current time, clamped
  // to the event end so we don't extrapolate past when scoring stops. This
  // keeps the "at this pace" line responsive instead of anchored to a static
  // event-end clock the user can't easily reason about.
  const PROJECTION_HORIZON_MS = 3 * 60 * 60_000;
  const projectionTarget = eventConfig?.endTime
    ? Math.min(serverClock.now() + PROJECTION_HORIZON_MS, eventConfig.endTime)
    : null;
  const winnerProjection = projectionTarget && eventConfig?.startTime && standings[0]
    ? projectScore(evId, standings[0].id, projectionTarget, {
      eventStartTime: eventConfig.startTime,
    })
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
    historyReady: historySpanMs(evId) >= 60_000,
    compareSelection,
  };

  renderHeaderStats(standings, waiting);
  renderPodium(standings, ctx);
  renderWaitingRoster(waitingRoster);
  renderPerms(eventConfig?.perms);

  // Fire the celebration once, exactly when phase transitions to ended.
  const phase = eventPhase(eventConfig, serverClock.now());
  if (lastPhase && lastPhase !== "ended" && phase === "ended" && standings.length) {
    const evId = currentEventId(eventConfig);
    if (localStorage.getItem(REVEAL_KEY) !== evId) {
      localStorage.setItem(REVEAL_KEY, evId);
      showEventEndReveal(standings);
    }
  }
  lastPhase = phase;

  if (viewingArchive) {
    renderArchivePanel();
    return historyChanged;
  }

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
  return historyChanged;
}

function renderArchivePanel() {
  const archives = listEventArchives();
  if (!selectedArchiveId || !archives.some(event => event.id === selectedArchiveId)) {
    selectedArchiveId = archives[0]?.id ?? null;
    archiveReplayIndex = -1;
  }
  const replay = selectedArchiveId
    ? eventReplay(selectedArchiveId, archiveReplayIndex)
    : null;
  renderArchive(archives, replay, {
    error: historyError(),
    offline: !online,
  });
}

function loadDemo(reason) {
  console.warn("[ClashCup] falling back to demo data:", reason);
  demoMode = true;
  renderDataState("demo", "Sample standings are shown because live Firebase could not load.");
  setSyncLine("Demo mode — sample data mirroring <code>clans/{clanId}</code>.");
  eventConfig = {
    ...DEMO.event,
    maxMembers: 5,
    perms: null,
    useClanReservations: false,
  };
  const evId = currentEventId(eventConfig);
  lastRawClans = DEMO.clans.map((clan, index) => ({
    ...clan,
    eventId: evId,
    id: clan.id ?? `demo-${index}`,
  }));
  liveState = { ...liveState, event: eventConfig, hasCommitted: true, demo: true };
  setAdminEvent(eventConfig);
  setAdminClans(lastRawClans);
  setEventTitle(eventConfig.name);
  renderPhase(eventConfig);
  renderAll();
  maybeApplyInitialHash();
}

function stateDetail(mode, state) {
  if (mode === "loading") return "Waiting for the first event and clan snapshots.";
  if (mode === "live") return "Event and clan snapshots are connected.";
  if (!online) return "Offline — showing the latest available data.";
  if (state.reconnecting) return "Reconnecting after the page became visible.";
  if (state.eventError) return "The event feed is unavailable. Latest data stays on screen.";
  if (state.clansError) return "The clan feed is unavailable. Latest data stays on screen.";
  if (!state.event) return "The live event document is missing. Scores are paused.";
  if (state.eventFromCache || state.clansFromCache) {
    return "Showing cached data while Firestore confirms the live snapshot.";
  }
  return "";
}

function updateDataState(state) {
  liveState = { ...state, online, demo: demoMode };
  const mode = deriveDataMode(liveState);
  renderDataState(mode, stateDetail(mode, liveState));
  if (mode === "live") {
    setSyncLine(`Live from Firestore <code>rgleaderboard</code>`);
  } else if (mode === "degraded") {
    setSyncLine("Live sync is limited. Saved data stays visible while the page retries.");
  }
}

async function boot() {
  let fb;
  try {
    const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${SDK}/firebase-app.js`);
    const { getFirestore, doc, collection, onSnapshot } =
      await import(`https://www.gstatic.com/firebasejs/${SDK}/firebase-firestore.js`);
    const app = initializeApp(FIREBASE_CONFIG);
    fb = { db: getFirestore(app), doc, collection, onSnapshot };
    initClanAdmin({ app, db: fb.db }).catch(error => {
      console.error("[ClashCup] admin login failed:", error);
      showAdminUnavailable("Admin login could not load.");
    });
  } catch (e) {
    showAdminUnavailable("Admin login could not load.");
    return loadDemo("SDK load failed: " + e.message);
  }

  syncServerClock(fetch, location.href, serverClock)
    .then(() => {
      renderPhase(eventConfig);
      if (liveState.hasCommitted) renderAll();
    })
    .catch(() => { /* device time is the safe fallback */ });

  const coordinator = createSnapshotCoordinator({
    onCommit: ({ event, clans }, meta) => {
      eventConfig = event;
      lastRawClans = clans;
      setAdminEvent(eventConfig);
      setAdminClans(lastRawClans);
      setEventTitle(eventConfig?.name ?? "Clan Clash Cup");
      renderPhase(eventConfig);
      const includesClanSnapshot = (meta.kind === "cycle" && !meta.clansError)
        || meta.kind === "clans";
      const historyChanged = renderAll({
        recordHistory: includesClanSnapshot && !!eventConfig,
      });
      if (includesClanSnapshot && eventConfig && historyChanged) publishLiveEvents();
      if (includesClanSnapshot) markSynced(serverClock.now());
      maybeApplyInitialHash();
    },
    onStatus: updateDataState,
  });

  let listenerGeneration = 0;
  const subscribe = () => {
    const generation = ++listenerGeneration;
    const isCurrent = () => generation === listenerGeneration;
    coordinator.beginCycle();
    let stopEvent = () => {};
    let stopClans = () => {};
    try {
      stopEvent = fb.onSnapshot(
        fb.doc(fb.db, ...COLLECTIONS.eventDoc),
        { includeMetadataChanges: true },
        snapshot => {
          if (!isCurrent()) return;
          coordinator.receiveEvent(
            snapshot.exists() ? parseEventDoc(snapshot.data()) : null,
            { fromCache: snapshot.metadata.fromCache },
          );
        },
        error => {
          if (isCurrent()) coordinator.failEvent(error);
        },
      );
      stopClans = fb.onSnapshot(
        fb.collection(fb.db, COLLECTIONS.clans),
        { includeMetadataChanges: true },
        snapshot => {
          if (!isCurrent()) return;
          const clans = [];
          snapshot.forEach(docSnapshot =>
            clans.push({ id: docSnapshot.id, ...docSnapshot.data() }));
          coordinator.receiveClans(clans, {
            fromCache: snapshot.metadata.fromCache,
          });
        },
        error => {
          if (isCurrent()) coordinator.failClans(error);
        },
      );
    } catch (error) {
      coordinator.failEvent(error);
      coordinator.failClans(error);
    }
    return () => {
      if (isCurrent()) listenerGeneration += 1;
      stopEvent();
      stopClans();
    };
  };

  createVisibilityController({
    document,
    subscribe,
    onHidden: () => setSyncLine("Live listeners pause while this page is hidden."),
  });

  const handleNetwork = () => {
    online = navigator.onLine;
    updateDataState(coordinator.getState());
    if (viewMode === "archive") renderArchivePanel();
  };
  window.addEventListener("online", handleNetwork);
  window.addEventListener("offline", handleNetwork);
}

// Combine history-derived events into the ticker after each snapshot.
// Deduped by keeping tickerFeed capped and letting the module drop old rows.
function publishLiveEvents() {
  const eventId = currentEventId(eventConfig);
  const events = [
    ...detectRankChanges(eventId),
    ...detectBigGains(eventId),
  ];
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

async function renderElementToPng(target, { filename, minWidth = 0, extraRightPad = 0, hideClasses = [] } = {}) {
  toast("Rendering PNG…", 3500);
  try {
    const { toPng } = await import("https://esm.sh/html-to-image@1.11.13");
    // html-to-image renders whatever bounding box the browser reports, which
    // on narrow viewports (or when the target is centered in a wider window)
    // truncates the right edge. Pin the capture box to a minimum width so
    // the PNG always shows a consistent layout regardless of viewport.
    // extraRightPad forces additional right whitespace inside the target,
    // giving right-aligned content (like the compare modal's delta column)
    // breathing room away from the card border.
    const width = Math.max(target.scrollWidth, minWidth) + extraRightPad;
    const height = target.scrollHeight;
    const dataUrl = await toPng(target, {
      backgroundColor: "#060A18",
      pixelRatio: 2,
      width,
      height,
      canvasWidth: width,
      canvasHeight: height,
      style: {
        width: `${width}px`,
        maxWidth: "none",
        transform: "none",
        margin: "0",
        ...(extraRightPad ? { paddingRight: `${28 + extraRightPad}px` } : {}),
      },
      filter: node => !hideClasses.some(c => node.classList?.contains?.(c)),
    });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    a.click();
  } catch (e) {
    console.error(e);
    toast("Screenshot failed");
  }
}

const shotStamp = () => new Date().toISOString().slice(0, 16).replace(":", "");

function screenshotStandings() {
  return renderElementToPng(document.querySelector(".wrap"), {
    filename: `clash-cup-${shotStamp()}.png`,
    minWidth: 1020,
    hideClasses: ["pin-btn", "vs-btn"],
  });
}

function screenshotCompare(a, b) {
  const target = document.getElementById("compareCard");
  if (!target) return;
  const slug = t => String(t ?? "clan").replace(/[^\w-]+/g, "").slice(0, 16) || "clan";
  return renderElementToPng(target, {
    filename: `clash-cup-vs-${slug(a?.tag)}-vs-${slug(b?.tag)}-${shotStamp()}.png`,
    minWidth: 780,
    extraRightPad: 40,
    hideClasses: ["cmp-close", "cmp-shot"],
  });
}

function trapOpenDialogFocus(event) {
  if (event.key !== "Tab") return;
  const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
    .find(candidate => !candidate.hidden);
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter(element => !element.hidden);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!dialog.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function wireControls() {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      if (tab.classList.contains("active")) return;
      tabs.forEach(t => {
        const on = t === tab;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on);
        t.tabIndex = on ? 0 : -1;
      });
      viewMode = tab.dataset.tab;
      renderAll();
    });
    tab.addEventListener("keydown", event => {
      const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const current = tabs.indexOf(tab);
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length)
            % tabs.length;
      tabs[next].focus();
      tabs[next].click();
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
    trapOpenDialogFocus(e);
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

onCompareScreenshot(screenshotCompare);
onArchiveSelect(eventId => {
  selectedArchiveId = eventId;
  archiveReplayIndex = -1;
  renderArchivePanel();
});
onArchiveReplay(index => {
  archiveReplayIndex = index;
  renderArchivePanel();
});
onArchiveClear(eventId => {
  if (!window.confirm("Clear local history for this event?")) return;
  clearEventHistory(eventId);
  selectedArchiveId = null;
  archiveReplayIndex = -1;
  renderArchivePanel();
  toast("Local history cleared");
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
