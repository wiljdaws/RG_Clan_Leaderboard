// One compatibility layer for both clan schemas. New documents store members
// in a map keyed by user id; bridge-era documents still use an array.

export function clanMembers(clan) {
  const members = clan?.members;
  if (Array.isArray(members)) {
    return members
      .filter(member => member && typeof member === "object")
      .map(member => ({ ...member }));
  }
  if (!members || typeof members !== "object") return [];
  return Object.entries(members)
    .filter(([, member]) => member && typeof member === "object")
    .map(([userId, member]) => ({
      ...member,
      userId,
    }));
}

export function clanMember(clan, memberOrUid) {
  if (memberOrUid && typeof memberOrUid === "object") return memberOrUid;
  return clanMembers(clan).find(member => member.userId === memberOrUid) ?? null;
}

// Matches ATLAS bridge behavior: memberStats wins when it has a valid MMR and
// its sync timestamp is at least as new as the member entry.
export function effectiveClanMemberStat(clan, memberOrUid) {
  const member = clanMember(clan, memberOrUid);
  const uid = typeof memberOrUid === "string" ? memberOrUid : member?.userId;
  const mapped = uid ? clan?.memberStats?.[uid] : null;
  const legacyValid = typeof member?.mmr === "number";
  const mappedValid = typeof mapped?.mmr === "number";

  if (!mappedValid) {
    return {
      mmr: legacyValid ? member.mmr : null,
      syncedAt: typeof member?.syncedAt === "number" ? member.syncedAt : null,
    };
  }

  const mappedAt = typeof mapped.syncedAt === "number" ? mapped.syncedAt : 0;
  const legacyAt = typeof member?.syncedAt === "number" ? member.syncedAt : 0;
  if (!legacyValid || mappedAt >= legacyAt) {
    return { mmr: mapped.mmr, syncedAt: mappedAt || null };
  }
  return { mmr: member.mmr, syncedAt: legacyAt || null };
}

export function memberEventBaseline(clan, memberOrUid) {
  const member = clanMember(clan, memberOrUid);
  if (member?.eventBaseline != null) return member.eventBaseline;
  const uid = typeof memberOrUid === "string" ? memberOrUid : member?.userId;
  return uid ? clan?.eventBaseline?.[uid] ?? null : null;
}

export const clanMemberCount = clan => clanMembers(clan).length;
