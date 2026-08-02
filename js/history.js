// Event-scoped, local-only history. Snapshots keep just scores, ranks, and
// member deltas so replay never changes or duplicates live score computation.

const WINDOW_MS = 60 * 60_000;
const STORAGE_KEY = "clashcup:eventHistory:v2";
const MAX_EVENTS = 8;
const MAX_SNAPSHOTS = 240;

const blankData = () => ({ version: 2, events: {} });
const eventIdOf = eventConfig =>
  eventConfig?.startTime != null ? String(eventConfig.startTime) : null;

function fallbackStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

export class EventHistoryStore {
  constructor({
    storage = typeof localStorage === "undefined" ? fallbackStorage() : localStorage,
    now = () => Date.now(),
  } = {}) {
    this.storage = storage;
    this.now = now;
    this.error = null;
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(this.storage.getItem(STORAGE_KEY) || "null");
      if (parsed?.version === 2 && parsed.events && typeof parsed.events === "object") {
        return parsed;
      }
    } catch {
      this.error = "Local history could not be read.";
    }
    return blankData();
  }

  persist() {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.data));
      this.error = null;
    } catch {
      this.error = "Local history could not be saved.";
    }
  }

  record(eventConfig, standings, ts = this.now()) {
    const id = eventIdOf(eventConfig);
    if (!id || !Array.isArray(standings)) return false;
    const record = this.data.events[id] ?? {
      event: {
        id,
        name: eventConfig.name ?? "Clan Clash Cup",
        startTime: Number(eventConfig.startTime) || 0,
        endTime: Number(eventConfig.endTime) || 0,
      },
      snapshots: [],
      updatedAt: ts,
    };
    record.event = {
      ...record.event,
      name: eventConfig.name ?? record.event.name,
      endTime: Number(eventConfig.endTime) || record.event.endTime,
    };
    const snapshot = {
      ts,
      clans: standings.map(clan => ({
        id: clan.id,
        tag: clan.tag,
        name: clan.name,
        score: clan.score,
        rank: clan.rank ?? null,
        members: (clan.rows ?? []).map(member => ({
          userId: member.userId,
          name: member.name,
          delta: member.delta,
        })),
      })),
    };
    const previous = record.snapshots[record.snapshots.length - 1];
    if (previous && JSON.stringify(previous.clans) === JSON.stringify(snapshot.clans)) {
      return false;
    }
    record.snapshots.push(snapshot);
    if (record.snapshots.length > MAX_SNAPSHOTS) {
      record.snapshots.splice(0, record.snapshots.length - MAX_SNAPSHOTS);
    }
    record.updatedAt = ts;
    this.data.events[id] = record;
    this.pruneEvents();
    this.persist();
    return true;
  }

  pruneEvents() {
    const ordered = Object.entries(this.data.events)
      .sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    for (const [id] of ordered.slice(MAX_EVENTS)) delete this.data.events[id];
  }

  snapshots(eventId) {
    return this.data.events[String(eventId)]?.snapshots ?? [];
  }

  list() {
    return Object.values(this.data.events)
      .map(record => ({
        ...record.event,
        snapshotCount: record.snapshots.length,
        firstAt: record.snapshots[0]?.ts ?? null,
        lastAt: record.snapshots[record.snapshots.length - 1]?.ts ?? null,
      }))
      .sort((a, b) => b.startTime - a.startTime);
  }

  replay(eventId, index = -1) {
    const record = this.data.events[String(eventId)];
    if (!record?.snapshots.length) return null;
    const safeIndex = index < 0
      ? record.snapshots.length - 1
      : Math.min(Math.max(0, Number(index) || 0), record.snapshots.length - 1);
    return {
      event: { ...record.event },
      snapshot: record.snapshots[safeIndex],
      index: safeIndex,
      total: record.snapshots.length,
    };
  }

  clear(eventId = null) {
    if (eventId == null) this.data = blankData();
    else delete this.data.events[String(eventId)];
    this.persist();
  }

  momentum(eventId, clanId, windowMs = WINDOW_MS) {
    const snapshots = this.snapshots(eventId);
    if (snapshots.length < 2) return null;
    const now = snapshots[snapshots.length - 1];
    const cutoff = now.ts - windowMs;
    const past = snapshots.find(snapshot => snapshot.ts >= cutoff);
    if (!past || past === now) return null;
    const pastClan = past.clans.find(clan => clan.id === clanId);
    const nowClan = now.clans.find(clan => clan.id === clanId);
    if (!pastClan || !nowClan) return null;
    return { gained: nowClan.score - pastClan.score, spanMs: now.ts - past.ts };
  }

  rankChanges(eventId) {
    const snapshots = this.snapshots(eventId);
    if (snapshots.length < 2) return [];
    const prev = snapshots[snapshots.length - 2];
    const curr = snapshots[snapshots.length - 1];
    return curr.clans.flatMap(clan => {
      const previous = prev.clans.find(candidate => candidate.id === clan.id);
      if (clan.rank == null || previous?.rank == null || previous.rank === clan.rank) return [];
      return [{
        kind: "rank",
        tag: clan.tag,
        oldRank: previous.rank,
        newRank: clan.rank,
        direction: clan.rank < previous.rank ? "up" : "down",
        ts: curr.ts,
      }];
    }).sort((a, b) =>
      Math.abs(b.newRank - b.oldRank) - Math.abs(a.newRank - a.oldRank));
  }

  bigGains(eventId, threshold = 40) {
    const snapshots = this.snapshots(eventId);
    if (snapshots.length < 2) return [];
    const prev = snapshots[snapshots.length - 2];
    const curr = snapshots[snapshots.length - 1];
    const out = [];
    for (const clan of curr.clans) {
      const previousClan = prev.clans.find(candidate => candidate.id === clan.id);
      if (!previousClan) continue;
      for (const member of clan.members) {
        const previous = previousClan.members.find(candidate =>
          candidate.userId === member.userId);
        if (member.delta == null || previous?.delta == null) continue;
        const gain = member.delta - previous.delta;
        if (gain >= threshold) {
          out.push({
            kind: "gain",
            clanTag: clan.tag,
            name: member.name,
            gain,
            ts: curr.ts,
          });
        }
      }
    }
    return out.sort((a, b) => b.gain - a.gain);
  }

  span(eventId) {
    const snapshots = this.snapshots(eventId);
    if (snapshots.length < 2) return 0;
    return snapshots[snapshots.length - 1].ts - snapshots[0].ts;
  }

  project(eventId, clanId, targetTime, { eventStartTime } = {}) {
    if (!eventStartTime) return null;
    const snapshots = this.snapshots(eventId);
    const now = snapshots[snapshots.length - 1];
    if (!now) return null;
    const clan = now.clans.find(candidate => candidate.id === clanId);
    if (!clan) return null;
    const elapsedMs = now.ts - eventStartTime;
    const remainingMs = targetTime - now.ts;
    if (elapsedMs < 30 * 60_000 || remainingMs <= 0 || clan.score <= 0) return null;
    const ratePerMs = clan.score / elapsedMs;
    return {
      projected: Math.round(clan.score + ratePerMs * remainingMs),
      ratePerHour: Math.round(ratePerMs * 3_600_000),
    };
  }
}

let defaultStore = null;
const store = () => defaultStore ??= new EventHistoryStore();

export const recordSnapshot = (eventConfig, standings, ts) =>
  store().record(eventConfig, standings, ts);
export const clanMomentum = (eventId, clanId, windowMs) =>
  store().momentum(eventId, clanId, windowMs);
export const detectRankChanges = eventId => store().rankChanges(eventId);
export const detectBigGains = (eventId, threshold) =>
  store().bigGains(eventId, threshold);
export const projectScore = (eventId, clanId, targetTime, opts) =>
  store().project(eventId, clanId, targetTime, opts);
export const historySpanMs = eventId => store().span(eventId);
export const listEventArchives = () => store().list();
export const eventReplay = (eventId, index) => store().replay(eventId, index);
export const clearEventHistory = eventId => store().clear(eventId);
export const historyError = () => store().error;
