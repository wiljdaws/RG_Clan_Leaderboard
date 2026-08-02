// Sample data mirroring the exact clans/{clanId} Firestore shape.
// Used only when Firestore is unreachable, so the page is reviewable
// offline and the design never renders blank.
const now = Date.now();
const ago = min => now - min * 60_000;
export const DEMO = {
  event: { name: "Clan Clash Cup", startTime: now - 7 * 864e5, endTime: now + 7 * 864e5 },
  clans: [
    { tag: "[KING]", name: "Kings of the Pitch", tagStyle: "<#00FFFF>",
      members: {
        u1: { name: "JesusDied4U", role: "leader",   mmr: 6365, syncedAt: ago(2), eventBaseline: 5900 },
        u2: { name: "Xuuya",       role: "coleader", mmr: 5840, syncedAt: ago(8), eventBaseline: 5100 },
        u3: { name: "Pal",         role: "member",   mmr: 4890, syncedAt: ago(38), eventBaseline: 4420 },
        u4: { name: "Ryme",        role: "member",   mmr: 4245, syncedAt: ago(210), eventBaseline: 3980 },
        u5: { name: "GoatHerder",  role: "member",   mmr: 2985, syncedAt: ago(1440), eventBaseline: 2760 },
        u6: { name: "TurboLamb",   role: "member",   mmr: 2140, syncedAt: null },
      },
      memberStats: {
        u2: { mmr: 5869, syncedAt: ago(1) },
      } },
    { tag: "[SBA]", name: "Squad Break Alpha", tagStyle: "<#A855F7>",
      eventBaseline: { s1: 7795, s2: 6510, s3: 3781, s4: 5364 },
      members: [
        { userId: "s1", name: "Calvi56",      role: "leader",   mmr: 7785, syncedAt: ago(4) },
        { userId: "s2", name: "BlakeRG",      role: "coleader", mmr: 6690, syncedAt: ago(28) },
        { userId: "s3", name: "Alexon",       role: "member",   mmr: 4310, syncedAt: ago(3) },
        { userId: "s4", name: "truly a duck", role: "member",   mmr: 5601, syncedAt: ago(90) },
      ] },
    { tag: "[FURY]", name: "Full Send Fury", tagStyle: "<#FF7A3C>",
      eventBaseline: { f1: 7033, f2: 5410, f3: 4980, f4: 4100, f5: 3350 },
      members: [
        { userId: "f1", name: "Croxyyys",   role: "leader",   mmr: 7290, syncedAt: ago(45) },
        { userId: "f2", name: "SayoshiRG",  role: "coleader", mmr: 6009, syncedAt: ago(180) },
        { userId: "f3", name: "Debliger",   role: "member",   mmr: 5115, syncedAt: ago(720) },
        { userId: "f4", name: "Debliger 1", role: "member",   mmr: 4088, syncedAt: ago(300) },
        { userId: "f5", name: "Jazr RL",    role: "member",   mmr: 3627, syncedAt: ago(15) },
      ] },
    { tag: "[NOVA]", name: "Nova Strikers", tagStyle: "<#E44BE0>",
      eventBaseline: { n1: 5120, n2: 4470, n3: 3900 },
      members: [
        { userId: "n1", name: "Cometline",      role: "leader", mmr: 5480, syncedAt: ago(60 * 6) },
        { userId: "n2", name: "pakshi",         role: "member", mmr: 4610, syncedAt: ago(60 * 24) },
        { userId: "n3", name: "Chicken Jockey", role: "member", mmr: 3705, syncedAt: null },
      ] },
  ],
};
