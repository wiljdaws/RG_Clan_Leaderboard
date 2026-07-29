// Rolling snapshot log persisted to localStorage so the momentum chip and
// rank-change ticker survive page reloads. Feeds the momentum chip, rank-
// change ticker, big-gain events, and the end-of-event score projection.
// Everything is derived client-side — no extra Firestore reads.

const WINDOW_MS = 60 * 60_000;
const STORAGE_KEY = "clashcup:historySnapshots";
const snapshots = loadSnapshots();

function loadSnapshots() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - WINDOW_MS;
    return parsed.filter(s => s && typeof s.ts === "number" && s.ts >= cutoff);
  } catch {
    return [];
  }
}

function persistSnapshots() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
  } catch { /* quota / private mode — momentum falls back to in-memory only */ }
}

// Persist a slim projection of the standings — enough to reconstruct
// score-over-time and rank-flip events without holding the full members
// array. Called once per successful clans snapshot from app.js.
export function recordSnapshot(standings, ts = Date.now()) {
  snapshots.push({
    ts,
    clans: standings.map(c => ({
      id: c.id,
      tag: c.tag,
      score: c.score,
      rank: c.rank ?? null,
      members: (c.rows ?? []).map(r => ({
        userId: r.userId,
        name: r.name,
        delta: r.delta,
      })),
    })),
  });
  prune();
  persistSnapshots();
}

function prune() {
  const cutoff = Date.now() - WINDOW_MS;
  while (snapshots.length && snapshots[0].ts < cutoff) snapshots.shift();
}

const latest = () => snapshots[snapshots.length - 1] ?? null;
const oldestInWindow = windowMs => {
  const cutoff = Date.now() - windowMs;
  return snapshots.find(s => s.ts >= cutoff) ?? null;
};

// Points gained by a clan over the last windowMs. Returns null when we
// don't have enough history yet or the clan wasn't present in the window.
export function clanMomentum(clanId, windowMs = WINDOW_MS) {
  if (snapshots.length < 2) return null;
  const past = oldestInWindow(windowMs);
  const now = latest();
  if (!past || past === now) return null;
  const pastClan = past.clans.find(c => c.id === clanId);
  const nowClan = now.clans.find(c => c.id === clanId);
  if (!pastClan || !nowClan) return null;
  return {
    gained: nowClan.score - pastClan.score,
    spanMs: now.ts - past.ts,
  };
}

// Every rank flip that happened between the two most recent snapshots.
// Returns events sorted by direction+size so the ticker leads with movement.
export function detectRankChanges() {
  if (snapshots.length < 2) return [];
  const prev = snapshots[snapshots.length - 2];
  const curr = snapshots[snapshots.length - 1];
  const out = [];
  curr.clans.forEach(c => {
    if (c.rank == null) return;
    const p = prev.clans.find(x => x.id === c.id);
    if (!p || p.rank == null || p.rank === c.rank) return;
    out.push({
      kind: "rank",
      tag: c.tag,
      oldRank: p.rank,
      newRank: c.rank,
      direction: c.rank < p.rank ? "up" : "down",
      ts: curr.ts,
    });
  });
  return out.sort((a, b) => Math.abs(b.newRank - b.oldRank) - Math.abs(a.newRank - a.oldRank));
}

// Members whose delta jumped by at least `threshold` between the two most
// recent snapshots. Used to seed "Croxyyys +180 for FURY" ticker entries.
export function detectBigGains(threshold = 40) {
  if (snapshots.length < 2) return [];
  const prev = snapshots[snapshots.length - 2];
  const curr = snapshots[snapshots.length - 1];
  const out = [];
  curr.clans.forEach(c => {
    const p = prev.clans.find(x => x.id === c.id);
    if (!p) return;
    c.members.forEach(m => {
      if (m.delta == null || m.userId == null) return;
      const pm = p.members.find(x => x.userId === m.userId);
      if (!pm || pm.delta == null) return;
      const jump = m.delta - pm.delta;
      if (jump >= threshold) {
        out.push({ kind: "gain", clanTag: c.tag, name: m.name, gain: jump, ts: curr.ts });
      }
    });
  });
  return out.sort((a, b) => b.gain - a.gain);
}

// Extrapolate the given clan's score to `targetTime` using their
// session-average gain rate (total score / time since event start),
// NOT the recent-window rate — a single lost match at the tail of a
// long grinding session shouldn't drag the projection to absurd
// negatives. This matches what "at this pace" means conversationally:
// the pace they've held all event.
//
// Returns null when the projection would be misleading — event too
// fresh, already ended, or the clan is net-negative so far (no
// meaningful "pace" to extrapolate).
export function projectScore(clanId, targetTime, opts = {}) {
  const eventStartTime = opts.eventStartTime;
  if (!eventStartTime) return null;
  const now = latest();
  if (!now) return null;
  const clan = now.clans.find(c => c.id === clanId);
  if (!clan) return null;
  const elapsedMs = now.ts - eventStartTime;
  const remainingMs = targetTime - now.ts;
  if (elapsedMs < 30 * 60_000) return null;   // event too fresh — noisy
  if (remainingMs <= 0) return null;           // already ended
  if (clan.score <= 0) return null;            // don't project down from zero
  const ratePerMs = clan.score / elapsedMs;
  return {
    projected: Math.round(clan.score + ratePerMs * remainingMs),
    ratePerHour: Math.round(ratePerMs * 3_600_000),
  };
}

// How much history we've accumulated — used to decide whether momentum
// numbers are reliable enough to display prominently.
export const historySpanMs = () => {
  if (snapshots.length < 2) return 0;
  return snapshots[snapshots.length - 1].ts - snapshots[0].ts;
};

// Test-friendly hook so demo mode can seed a plausible history without
// waiting real time — used when Firestore is unreachable.
export function _seedForDemo(entries) {
  snapshots.length = 0;
  entries.forEach(e => snapshots.push(e));
}
