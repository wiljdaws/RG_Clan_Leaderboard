// DOM rendering for the Clash Cup page. Consumes standings produced by
// scoring.js — no Firebase, no scoring math in here.
import { eventPhase } from "./scoring.js";

const $ = id => document.getElementById(id);
const fmt = n => (n > 0 ? "+" : "") + Math.round(n).toLocaleString();
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const initials = name => {
  const p = name.replace(/[\[\]]/g, "").split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? "?") + (p[1]?.[0] ?? "")).toUpperCase();
};
const segColor = (base, i) =>
  `hsl(${((base ?? 268) + i * 24) % 360} 85% ${64 - i * 4}%)`;
const hueOf = hex => {
  if (!hex) return null;
  const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return 268;
  let h;
  if (mx === r) h = (g - b) / (mx - mn) % 6;
  else if (mx === g) h = (b - r) / (mx - mn) + 2;
  else h = (r - g) / (mx - mn) + 4;
  return Math.round(h * 60 + 360) % 360;
};
// Activity windows — a player synced in the last 5 min is "hot" (still
// grinding this session), 5m-1h is "warm" (recently active), older is
// "cold". Renders as a colored dot on their avatar with a tooltip.
const HOT_MS = 5 * 60_000;
const WARM_MS = 60 * 60_000;
export const syncClass = syncedAt => {
  if (syncedAt == null) return "sync-none";
  const age = Date.now() - syncedAt;
  if (age < HOT_MS) return "sync-hot";
  if (age < WARM_MS) return "sync-warm";
  return "sync-cold";
};
export const fmtSyncAgo = syncedAt => {
  if (syncedAt == null) return "Never synced this event";
  const s = Math.max(0, Math.floor((Date.now() - syncedAt) / 1000));
  if (s < 60) return `Synced ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Synced ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Synced ${h}h ago`;
  return `Synced ${Math.floor(h / 24)}d ago`;
};

const crest = (clan, cls, extra = "") =>
  `<div class="${cls}${extra ? " " + extra : ""}" style="--accent:${clan.accent ?? "var(--grad-a)"}">${esc(clan.tagShort)}</div>`;

export function renderHeaderStats(clans, waiting = 0) {
  const players = clans.reduce((s, c) => s + c.members.length, 0);
  const now = Date.now();
  const grinding = clans.reduce((s, c) =>
    s + c.rows.filter(r => r.syncedAt && (now - r.syncedAt) < HOT_MS).length, 0);
  const parts = [
    `<b>${clans.length}</b> clans competing`,
    `<b>${players}</b> players`,
  ];
  if (grinding > 0) parts.push(`<b class="grinding"><span class="live-dot"></span>${grinding}</b> grinding now`);
  if (waiting > 0) parts.push(`<b>${waiting}</b> waiting to sync`);
  parts.push("scores sync live from ATLAS");
  $("subLine").innerHTML = parts.join(" · ");
}

// Format "N / max" when maxMembers is known, else fall back to "N members".
const rosterLabel = (count, max) => max ? `${count} / ${max} members` : `${count} members`;

// Momentum badge — shown on a clan row when we have any 30-min gain to
// report. Positive gain is fire, dead-flat is a snowflake so users can
// tell "unknown yet" from "definitely idle".
const momentumChip = m => {
  if (!m) return "";
  const spanMin = Math.max(1, Math.round(m.spanMs / 60_000));
  const label = `${m.gained > 0 ? "+" : ""}${Math.round(m.gained).toLocaleString()} last ${spanMin}m`;
  if (m.gained > 0)  return `<span class="momentum hot"  title="Gained ${label}">🔥 ${label}</span>`;
  if (m.gained < 0)  return `<span class="momentum cold" title="Lost ${label}">❄ ${label}</span>`;
  return `<span class="momentum flat" title="No change ${label}">— flat ${spanMin}m</span>`;
};

const fmtClock = ms => {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

export function renderPodium(clans, ctx = {}) {
  const pod = $("podium");
  if (clans.length < 2) { pod.style.display = "none"; return; }
  const order = [clans[1], clans[0], clans[2]].filter(Boolean);
  const cls = c => c === clans[0] ? "p1" : c === clans[1] ? "p2" : "p3";
  const label = c => c === clans[0] ? "Champion Seat" : c === clans[1] ? "2nd" : "3rd";
  const isActive = c => c.rows.some(r => r.syncedAt && (Date.now() - r.syncedAt) < HOT_MS);
  const projection = ctx.winnerProjection;
  const projectionTarget = ctx.winnerProjectionTarget ?? ctx.endTime;
  const projectionLine = projection && projectionTarget
    ? `<div class="projection">At this pace · <b>${projection.projected.toLocaleString()}</b> by ${fmtClock(projectionTarget)}</div>`
    : "";
  pod.innerHTML = order.map(c => `
    <div class="step ${cls(c)}" style="--accent:${c.accent ?? "var(--grad-a)"}">
      <div class="place">${label(c)}</div>
      ${crest(c, "crest", isActive(c) ? "active" : "")}
      <div class="cname">${esc(c.tag)}</div>
      <div class="cmeta">${esc(c.name)} · ${rosterLabel(c.members.length, ctx.maxMembers)}</div>
      <div class="cscore ${c.score < 0 ? "neg" : ""}">${fmt(c.score)}<small>MMR gained</small></div>
      ${c === clans[0] ? projectionLine : ""}
    </div>`).join("");
  pod.style.display = "grid";
}

// Which clan accordions the user has opened, kept in module state so
// re-renders (a snapshot ticks every few seconds) don't collapse them.
const openIds = new Set();

// Previous per-player delta, used to flash a row when someone gains MMR
// between snapshots. Populated at the end of each renderStandings call.
const prevDeltas = new Map();
export const getPrevDeltas = () => prevDeltas;

// External pin toggle handler wired by app.js — render.js doesn't own
// the persistence layer, it just fires the intent.
let pinHandler = null;
export function onPinToggle(fn) { pinHandler = fn; }

// Compare toggle handler — user clicked the "vs" button on a clan row.
let compareHandler = null;
export function onCompareToggle(fn) { compareHandler = fn; }

// Broadcast-style live feed: rank flips and big gains. Newest on the
// left; capped so the DOM stays cheap. Older events fade based on age.
const TICKER_MAX = 12;
const tickerFeed = [];
export function pushTickerEvents(events) {
  if (!events.length) return;
  events.forEach(e => tickerFeed.unshift({ ...e, addedAt: Date.now() }));
  if (tickerFeed.length > TICKER_MAX) tickerFeed.length = TICKER_MAX;
  renderTicker();
}
function tickerHTML(e) {
  const age = Math.max(0, Math.floor((Date.now() - e.addedAt) / 60_000));
  const ago = age === 0 ? "just now" : `${age}m ago`;
  if (e.kind === "rank") {
    const arrow = e.direction === "up" ? "↑" : "↓";
    return `<span class="tick tick-${e.direction}" data-added="${e.addedAt}">
      <span class="tick-arrow">${arrow}</span>
      <b>${esc(e.tag)}</b> → #${e.newRank}
      <small>was #${e.oldRank} · ${ago}</small>
    </span>`;
  }
  if (e.kind === "gain") {
    return `<span class="tick tick-up" data-added="${e.addedAt}">
      <span class="tick-arrow">▲</span>
      <b>${esc(e.name)}</b> +${e.gain.toLocaleString()}
      <small>for ${esc(e.clanTag)} · ${ago}</small>
    </span>`;
  }
  return "";
}
function renderTicker() {
  const el = $("ticker"), strip = $("tickerStrip");
  if (!tickerFeed.length) { el.style.display = "none"; return; }
  el.style.display = "";
  strip.innerHTML = tickerFeed.map(tickerHTML).join("");
}
// Re-render every 30s so the "Xm ago" timestamps and fade opacity stay honest.
setInterval(() => { if (tickerFeed.length) renderTicker(); }, 30_000);

// Repaint freshness classes on all visible avatars every 30s so a player
// synced 4m30s ago transitions to "warm" without waiting for a snapshot.
// The dot color and tooltip stay honest even on an idle tab.
setInterval(() => {
  document.querySelectorAll(".ava[data-synced-at]").forEach(el => {
    const raw = el.dataset.syncedAt;
    const at = raw ? Number(raw) : null;
    el.classList.remove("sync-hot", "sync-warm", "sync-cold", "sync-none");
    el.classList.add(syncClass(at));
    el.title = fmtSyncAgo(at);
  });
  // Crests turn on/off with the 5-min window too.
  document.querySelectorAll(".crest-sm, .crest").forEach(el => {
    const clanEl = el.closest(".clan, .step");
    if (!clanEl) return;
    const hot = [...clanEl.querySelectorAll(".ava[data-synced-at]")]
      .some(a => {
        const at = Number(a.dataset.syncedAt);
        return at && (Date.now() - at) < HOT_MS;
      });
    el.classList.toggle("active", hot);
  });
}, 30_000);

export function renderStandings(clans, ctx = {}) {
  const host = $("standings");

  // FLIP: capture current positions before we rebuild, so we can animate
  // rank swaps once the new DOM is in place.
  const prevTops = new Map();
  host.querySelectorAll(".clan").forEach(el => {
    if (el.dataset.clanId) prevTops.set(el.dataset.clanId, el.getBoundingClientRect().top);
  });

  if (!clans.length) {
    host.innerHTML = ctx.emptyReason === "filter"
      ? `<div class="state"><div class="big">No clans match</div>
         Try a different search — matches on tag or full name.</div>`
      : `<div class="state"><div class="big">No clans scored yet</div>
         Baselines lock the first time each member syncs during the event window.</div>`;
    return;
  }
  const pinned = ctx.pinned instanceof Set ? ctx.pinned : new Set();
  host.innerHTML = "";
  clans.forEach((clan, idx) => {
    const counting = clan.rows.filter(r => (r.delta ?? 0) > 0);
    const posTotal = counting.reduce((s, r) => s + r.delta, 0) || 1;
    const hue = hueOf(clan.accent);

    const relay = counting.map((r, i) =>
      `<span style="width:${(r.delta / posTotal * 100).toFixed(1)}%;background:${segColor(hue, i)}"
        title="${esc(r.name)}: ${fmt(r.delta)}"></span>`).join("");

    const memberRows = clan.rows.map(r => {
      const ci = counting.findIndex(c => c === r);
      const seg = ci >= 0 ? segColor(hue, ci) : "var(--ink-dim)";
      const deltaCell = r.delta == null
        ? `<span class="delta none">no baseline</span>`
        : `<span class="delta ${r.delta >= 0 ? "up" : "down"}">${fmt(r.delta)}</span>`;
      const prev = prevDeltas.get(r.userId);
      const gained = prev != null && r.delta != null && r.delta > prev;
      const isMvp = r.userId && r.userId === ctx.mvpUserId;
      const sync = syncClass(r.syncedAt);
      const rowCls = [
        r.delta == null ? "nobase" : "",
        gained ? "just-gained" : "",
        isMvp ? "mvp" : "",
      ].filter(Boolean).join(" ");
      return `<tr class="${rowCls}">
        <td><div class="m-name">
          <span class="ava ${sync}" style="--seg:${seg}" data-synced-at="${r.syncedAt ?? ""}" title="${esc(fmtSyncAgo(r.syncedAt))}">${esc(initials(r.name))}</span>
          ${isMvp ? `<span class="mvp-crown" title="Top contributor across all clans" aria-label="MVP">♛</span>` : ""}
          ${esc(r.name)}
        </div></td>
        <td><span class="role ${esc(r.role)}">${esc(r.role)}</span></td>
        <td class="num">${r.base != null ? r.base.toLocaleString() : "—"}</td>
        <td class="num">${r.mmr != null ? r.mmr.toLocaleString() : "—"}</td>
        <td class="num">${deltaCell}</td>
      </tr>`;
    }).join("");
    const clanIsActive = clan.rows.some(r => r.syncedAt && (Date.now() - r.syncedAt) < HOT_MS);

    const hasNoBase = clan.rows.some(r => r.delta == null);
    const memberPanelId = `members-${clan.id ?? idx}`;
    const isPinned = clan.id && pinned.has(clan.id);
    const displayRank = clan.rank ?? idx + 1;
    const el = document.createElement("div");
    el.className = "clan" + (isPinned ? " pinned" : "");
    if (clan.id) el.dataset.clanId = clan.id;
    if (clan.id && openIds.has(clan.id)) el.classList.add("open");
    const inCompare = ctx.compareSelection?.has(clan.id);
    el.innerHTML = `
      <button class="vs-btn ${inCompare ? "on" : ""}" type="button" aria-label="Compare ${esc(clan.tag)}" aria-pressed="${inCompare}">vs</button>
      <button class="pin-btn" type="button" aria-label="${isPinned ? "Unpin" : "Pin"} ${esc(clan.tag)}" aria-pressed="${isPinned}">${isPinned ? "★" : "☆"}</button>
      <button class="clan-row" aria-expanded="${el.classList.contains("open")}" aria-controls="${memberPanelId}">
        <span class="rank ${displayRank <= 3 ? "r" + displayRank : ""}">#${displayRank}</span>
        <span class="clan-id" style="--accent:${clan.accent ?? "var(--grad-a)"}">
          ${crest(clan, "crest-sm", clanIsActive ? "active" : "")}
          <span class="clan-text">
            <span class="clan-name-line">
              <span class="clan-tag">${esc(clan.tag)}</span>
              <span class="clan-meta">${esc(clan.name)} · ${rosterLabel(clan.members.length, ctx.maxMembers)}</span>
              ${momentumChip(ctx.momentumById?.get(clan.id))}
            </span>
            <span class="relay ${counting.length ? "" : "empty"}" aria-hidden="true">${relay}</span>
          </span>
        </span>
        <span class="clan-score">
          <div class="val ${clan.score < 0 ? "neg" : clan.score === 0 ? "zero" : ""}">${fmt(clan.score)}</div>
          <div class="lbl">MMR gained</div>
        </span>
        <span class="chev" aria-hidden="true">▼</span>
      </button>
      <div class="members" id="${memberPanelId}" role="region" aria-label="${esc(clan.tag)} members"><div class="members-inner">
        <table>
          <thead><tr><th>Player</th><th>Role</th><th class="num">Baseline</th>
          <th class="num">Current</th><th class="num">Contribution</th></tr></thead>
          <tbody>${memberRows}</tbody>
        </table>
        ${hasNoBase ? `<div class="note">Dimmed players haven't locked a baseline this event — they'll count after their first ATLAS sync inside the window.</div>` : ""}
      </div></div>`;
    const btn = el.querySelector(".clan-row");
    btn.addEventListener("click", () => {
      const open = el.classList.toggle("open");
      btn.setAttribute("aria-expanded", open);
      if (clan.id) { open ? openIds.add(clan.id) : openIds.delete(clan.id); }
    });
    const pin = el.querySelector(".pin-btn");
    pin.addEventListener("click", e => {
      e.stopPropagation();
      if (clan.id && pinHandler) pinHandler(clan.id);
    });
    const vs = el.querySelector(".vs-btn");
    vs.addEventListener("click", e => {
      e.stopPropagation();
      if (clan.id && compareHandler) compareHandler(clan.id);
    });
    host.appendChild(el);
  });

  // FLIP part 2: animate any row that moved. Reduced-motion CSS already
  // nukes the transition, so nothing to guard for here.
  requestAnimationFrame(() => {
    host.querySelectorAll(".clan").forEach(el => {
      const id = el.dataset.clanId;
      const prev = prevTops.get(id);
      if (prev == null) return;
      const dy = prev - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform .28s cubic-bezier(.4,.0,.2,1)";
        el.style.transform = "";
      });
    });
  });

  // Snapshot every current delta so the next render can flash whoever gained.
  clans.forEach(clan => clan.rows.forEach(r => {
    if (r.userId != null && r.delta != null) prevDeltas.set(r.userId, r.delta);
  }));
}

// Consumers (deep links, tests) can force a clan open by id — the next
// render will honor it via the persisted openIds set.
export function setOpenClan(id, open = true) {
  if (!id) return;
  if (open) openIds.add(id); else openIds.delete(id);
}

// Side-by-side compare modal. Takes exactly two decorated clan objects
// out of buildStandings and produces a score-gap, roster fill, and top
// three contributors on each side.
export function renderCompare(a, b, ctx = {}) {
  const modal = $("compareModal");
  const card = $("compareCard");
  if (!a || !b) { modal.hidden = true; return; }
  const gap = a.score - b.score;
  const side = c => {
    const rows = [...c.rows]
      .filter(r => r.delta != null)
      .slice(0, 5)
      .map(r => `<li>
        <span class="n">${esc(r.name)}</span>
        <span class="d ${r.delta > 0 ? "" : r.delta < 0 ? "neg" : "none"}">${fmt(r.delta)}</span>
      </li>`).join("");
    const cls = c.score > 0 ? "" : c.score < 0 ? "neg" : "zero";
    return `<div class="cmp-side" style="--accent:${c.accent ?? "var(--grad-a)"}">
      <div class="cmp-side-head">
        ${crest(c, "crest")}
        <div>
          <div class="cname">${esc(c.tag)}</div>
          <div class="cmeta">${esc(c.name)} · ${rosterLabel(c.members.length, ctx.maxMembers)}</div>
        </div>
      </div>
      <div class="cmp-score ${cls}">${fmt(c.score)}</div>
      <ul class="cmp-contribs">${rows || `<li><span class="n" style="color:var(--ink-dim)">No baselined contributors yet</span></li>`}</ul>
    </div>`;
  };
  const gapLabel = gap === 0 ? "TIED" : `${gap > 0 ? "+" : ""}${gap.toLocaleString()}`;
  card.innerHTML = `
    <button class="cmp-close" type="button" data-close aria-label="Close">✕</button>
    <div class="cmp-title">${esc(a.tag)} <span style="color:var(--ink-dim)">vs</span> ${esc(b.tag)}</div>
    <div class="cmp-sub">Head-to-head · rank ${a.rank ?? "–"} vs rank ${b.rank ?? "–"}</div>
    <div class="cmp-grid">
      ${side(a)}
      <div class="cmp-gap"><b>${gapLabel}</b><small>${gap === 0 ? "" : (gap > 0 ? esc(a.tag) + " leads" : esc(b.tag) + " leads")}</small></div>
      ${side(b)}
    </div>
  `;
  modal.hidden = false;
  card.querySelectorAll("[data-close]").forEach(x => x.addEventListener("click", closeCompare));
  modal.querySelector(".modal-scrim").addEventListener("click", closeCompare);
}
export function closeCompare() { $("compareModal").hidden = true; }

// Full-screen event-end celebration. Fires canvas-confetti on open,
// stops after ~3s so the CPU can idle. Dismiss button removes the overlay.
export async function showEventEndReveal(standings) {
  if (!standings.length) return;
  const [winner, second, third] = standings;
  $("revealChamp").textContent = winner.tag;
  $("revealName").textContent = winner.name;
  $("revealScore").innerHTML = `${fmt(winner.score)}<small>MMR gained</small>`;
  const others = [second, third].filter(Boolean).map((c, i) => `
    <li class="p${i + 2}"><b>#${i + 2}</b> ${esc(c.tag)} <small>${fmt(c.score)}</small></li>`).join("");
  $("revealPodium").innerHTML = others;
  const overlay = $("endReveal");
  overlay.hidden = false;
  try {
    const confetti = (await import("https://esm.sh/canvas-confetti@1.9.3")).default;
    const canvas = $("revealConfetti");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const fire = confetti.create(canvas, { resize: true, useWorker: true });
    const end = Date.now() + 2600;
    (function frame() {
      fire({ particleCount: 3, angle: 60, spread: 55, origin: { x: 0 },
             colors: ["#A855F7", "#E44BE0", "#FFD24A"] });
      fire({ particleCount: 3, angle: 120, spread: 55, origin: { x: 1 },
             colors: ["#A855F7", "#E44BE0", "#FFD24A"] });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
  } catch (e) { console.warn("[ClashCup] confetti unavailable:", e.message); }
  $("revealDismiss").onclick = () => { overlay.hidden = true; };
}

// Top individual contributors across all clans, sorted by delta desc.
// Rank is dense so ties share a number.
export function renderPlayers(players, ctx = {}) {
  const host = $("playersList");
  if (!players.length) {
    host.innerHTML = ctx.emptyReason === "filter"
      ? `<div class="state"><div class="big">No players match</div>Try a different name.</div>`
      : `<div class="state"><div class="big">No contributions yet</div>Baselines lock on first ATLAS sync inside the event window.</div>`;
    return;
  }
  host.innerHTML = players.map((p, i) => {
    const rank = i + 1;
    const rankCls = rank === 1 ? "r1" : rank === 2 ? "r2" : rank === 3 ? "r3" : "";
    const seg = p.clanAccent ?? "var(--grad-a)";
    const deltaCls = p.delta > 0 ? "up" : p.delta < 0 ? "down" : "";
    const sync = syncClass(p.syncedAt);
    const isMvp = p.userId && p.userId === ctx.mvpUserId;
    return `<div class="players-row">
      <span class="rank ${rankCls}">#${rank}</span>
      <div class="p-ident">
        <span class="ava ${sync}" style="--seg:${seg}" data-synced-at="${p.syncedAt ?? ""}" title="${esc(fmtSyncAgo(p.syncedAt))}">${esc(initials(p.name))}</span>
        <div class="p-name">
          <span class="n">${esc(p.name)}${isMvp ? ` <span class="mvp-crown" title="Top contributor across all clans" aria-label="MVP">♛</span>` : ""}</span>
          <span class="c" style="--accent:${seg}">from <b>${esc(p.clanTag)}</b></span>
        </div>
      </div>
      <span class="p-delta ${deltaCls}">${fmt(p.delta)}</span>
      <span class="p-mmr">${p.mmr != null ? p.mmr.toLocaleString() : "—"}</span>
    </div>`;
  }).join("");
}

// Phase chip + live countdown. Re-derives phase from Date.now() on every
// tick so the chip transitions upcoming → active → ended without a reload.
let tick = null;
const pad2 = n => String(n).padStart(2, "0");
export function renderPhase(eventConfig) {
  const chip = $("phaseChip"), txt = $("phaseText"),
        cChip = $("countChip"), cd = $("countdown");

  const applyPhase = phase => {
    chip.classList.remove("ended", "upcoming");
    if (phase === "active") txt.textContent = "Live Event";
    else if (phase === "upcoming") { txt.textContent = "Starts Soon"; chip.classList.add("upcoming"); }
    else if (phase === "ended") { txt.textContent = "Event Ended"; chip.classList.add("ended"); }
    else { txt.textContent = "No Active Event"; chip.classList.add("ended"); }
  };

  clearInterval(tick);
  if (!eventConfig) { applyPhase("none"); cChip.style.display = "none"; return; }

  const draw = () => {
    const phase = eventPhase(eventConfig);
    applyPhase(phase);
    if (phase !== "active" && phase !== "upcoming") { cChip.style.display = "none"; return; }
    cChip.style.display = "";
    const target = phase === "active" ? eventConfig.endTime : eventConfig.startTime;
    const suffix = phase === "active" ? " left" : " to start";
    let ms = Math.max(0, target - Date.now());
    const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5),
          m = Math.floor(ms % 36e5 / 6e4), s = Math.floor(ms % 6e4 / 1e3);
    cd.textContent = (d ? `${d}d ${pad2(h)}h ${pad2(m)}m` : `${pad2(h)}:${pad2(m)}:${pad2(s)}`) + suffix;
  };
  draw();
  tick = setInterval(draw, 1000);
}

export function setEventTitle(name) { $("eventTitle").textContent = name; }
export function setSyncLine(html) { $("syncLine").innerHTML = html; }
export function showDemoBanner() { $("demoBanner").style.display = "block"; }

// Live "updated Xs ago" chip. Ticks every second; goes amber past 60s
// so a silent listener doesn't look fresh forever.
let lastSyncAt = null;
let syncTick = null;
const fmtAgo = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
};
export function markSynced(now = Date.now()) {
  lastSyncAt = now;
  const chip = $("syncBadge"), txt = $("syncBadgeText");
  chip.style.display = "";
  const draw = () => {
    const age = Date.now() - lastSyncAt;
    txt.textContent = `Updated ${fmtAgo(age)}`;
    chip.classList.toggle("stale", age > 60_000);
  };
  clearInterval(syncTick);
  draw();
  syncTick = setInterval(draw, 1000);
}

// Human-readable summary of what event.perms locks. Empty when no perms
// object or when nothing meaningful is disabled.
const PERM_LABELS = {
  allowLeave: "leaving",
  allowDisband: "disbanding",
  allowTransfer: "transferring",
  allowRoleChange: "role changes",
  allowRenameClan: "renaming",
  allowKick: "kicking",
  allowJoin: "new members",
  allowApprove: "approvals",
  allowClanCreate: "new clans",
};
export function renderPerms(perms) {
  const el = $("permsNote");
  if (!perms) { el.textContent = ""; return; }
  const locked = Object.entries(PERM_LABELS)
    .filter(([k]) => perms[k] === false)
    .map(([, label]) => label);
  el.textContent = locked.length
    ? `Event lock: ${locked.join(" · ")} disabled until the event ends.`
    : "";
}
