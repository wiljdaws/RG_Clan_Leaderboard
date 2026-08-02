import assert from "node:assert/strict";
import test from "node:test";

import {
  clanMemberCount,
  clanMembers,
  effectiveClanMemberStat,
  memberEventBaseline,
} from "../js/members.js";

test("shared member accessor reads arrays and keyed maps", () => {
  const legacy = { members: [{ userId: "a", name: "Alpha" }] };
  const current = { members: { b: { userId: "stale", name: "Bravo" } } };

  assert.deepEqual(clanMembers(legacy), [{ userId: "a", name: "Alpha" }]);
  assert.deepEqual(clanMembers(current), [{ userId: "b", name: "Bravo" }]);
  assert.equal(clanMemberCount(legacy), 1);
  assert.equal(clanMemberCount(current), 1);
});

test("memberStats wins only when its MMR is at least as new", () => {
  const clan = {
    members: {
      a: { mmr: 1200, syncedAt: 200 },
      b: { mmr: 1300, syncedAt: 200 },
    },
    memberStats: {
      a: { mmr: 1250, syncedAt: 201 },
      b: { mmr: 9999, syncedAt: 199 },
    },
  };

  assert.deepEqual(effectiveClanMemberStat(clan, "a"), {
    mmr: 1250,
    syncedAt: 201,
  });
  assert.deepEqual(effectiveClanMemberStat(clan, "b"), {
    mmr: 1300,
    syncedAt: 200,
  });
});

test("per-member baseline takes priority over legacy clan baseline", () => {
  const clan = {
    members: {
      a: { eventBaseline: 1000 },
      b: {},
    },
    eventBaseline: { a: 900, b: 800 },
  };

  assert.equal(memberEventBaseline(clan, "a"), 1000);
  assert.equal(memberEventBaseline(clan, "b"), 800);
});
