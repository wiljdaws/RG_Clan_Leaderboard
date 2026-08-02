// ATLAS-identical event scoring, ported line-for-line from the userscript's
// computeClanEventScore / clanBaselineForCurrentEvent / eventPhase.
// Pure functions, no DOM, no Firebase — the main leaderboard site can
// import this module when Clash standings get integrated there, so the
// website and the in-game HUD can never disagree on the math.
import {
  clanMembers,
  effectiveClanMemberStat,
  memberEventBaseline,
} from "./members.js";

export const stripTMP = s => String(s ?? "").replace(/<[^>]*>/g, "").trim();

export const currentEventId = eventConfig =>
  eventConfig ? String(eventConfig.startTime) : null;

export const eventPhase = (eventConfig, now = Date.now()) => {
  if (!eventConfig) return "none";
  if (now < eventConfig.startTime) return "upcoming";
  if (now > eventConfig.endTime) return "ended";
  return "active";
};

// A clan's baseline only counts if it belongs to the current event —
// stale baselines from a previous event score zero, same as in-game.
export const clanBaseline = (clan, eventConfig) => {
  if (!clan) return null;
  if (clan.eventId !== currentEventId(eventConfig)) return null;
  const hasPerMemberBaseline = clanMembers(clan)
    .some(member => member?.eventBaseline != null);
  if (!clan.eventBaseline && !hasPerMemberBaseline) return null;
  return clan.eventBaseline ?? {};
};

// Per-member rows (sorted by contribution desc) + clan score.
// Score = Σ (current MMR − baseline) over members WITH a locked baseline;
// members without one get delta:null and contribute nothing yet.
export function scoreClan(clan, eventConfig) {
  const baseline = clanBaseline(clan, eventConfig);
  const rows = clanMembers(clan).map(m => {
    const stat = effectiveClanMemberStat(clan, m);
    const base = baseline ? memberEventBaseline(clan, m) : null;
    const has = base != null && typeof stat.mmr === "number";
    return {
      userId: m.userId ?? null,
      name: stripTMP(m.name) || "Unknown",
      role: m.role ?? "member",
      mmr: typeof stat.mmr === "number" ? stat.mmr : null,
      base: has ? base : null,
      delta: has ? stat.mmr - base : null,
      syncedAt: stat.syncedAt,
    };
  }).sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity));
  const score = rows.reduce((s, r) => s + (r.delta ?? 0), 0);
  return { rows, score, scored: baseline != null };
}

// Full standings: decorate, filter to the current event, rank by score.
export function buildStandings(rawClans, eventConfig) {
  const evId = currentEventId(eventConfig);
  return rawClans
    .map(c => ({
      ...c,
      members: clanMembers(c),
      ...scoreClan(c, eventConfig),
      tag: stripTMP(c.tag) || stripTMP(c.name) || "?",
      tagShort: (stripTMP(c.tag) || "?").replace(/[\[\]]/g, "").slice(0, 4),
      accent: accentFrom(c.tagStyle),
      name: stripTMP(c.name) || "Unnamed clan",
    }))
    .filter(c => evId == null || c.eventId === evId)
    .sort((a, b) => b.score - a.score);
}

export function buildWaitingRoster(rawClans, eventConfig) {
  const evId = currentEventId(eventConfig);
  if (!evId) return [];
  return rawClans.flatMap(clan => {
    const current = clan?.eventId === evId;
    const members = clanMembers(clan)
      .filter(member => !current || memberEventBaseline(clan, member) == null)
      .map(member => ({
        userId: member.userId ?? null,
        name: stripTMP(member.name) || "Unknown",
      }));
    if (!members.length) return [];
    return [{
      clanId: clan.id ?? null,
      clanTag: stripTMP(clan.tag) || stripTMP(clan.name) || "?",
      clanName: stripTMP(clan.name) || "Unnamed clan",
      members,
    }];
  });
}

// Clan accent color. Live tagStyle is an object like
// { mode, color, gradientStart, gradientEnd, bracketColor, ... }; older
// data (and the demo fixture) uses a TMP string like "<#RRGGBB>...". Handle both.
export const accentFrom = style => {
  if (!style) return null;
  if (typeof style === "object") {
    const pick = style.color ?? style.gradientStart ?? style.gradientEnd ?? style.bracketColor;
    return /^#[0-9a-fA-F]{6}$/.test(String(pick ?? "")) ? pick : null;
  }
  const m = /<#([0-9a-fA-F]{6})>/.exec(String(style));
  return m ? "#" + m[1] : null;
};
