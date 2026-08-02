import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStandings,
  buildWaitingRoster,
  scoreClan,
} from "../js/scoring.js";

const event = {
  name: "Cup",
  startTime: 1000,
  endTime: 9000,
};

test("legacy and map clan shapes produce the same event total", () => {
  const legacy = {
    id: "legacy",
    eventId: "1000",
    members: [
      { userId: "a", name: "A", mmr: 1150, syncedAt: 10 },
      { userId: "b", name: "B", mmr: 950, syncedAt: 10 },
    ],
    eventBaseline: { a: 1000, b: 1000 },
  };
  const current = {
    id: "current",
    eventId: "1000",
    members: {
      a: { name: "A", mmr: 1150, syncedAt: 10, eventBaseline: 1000 },
      b: { name: "B", mmr: 950, syncedAt: 10, eventBaseline: 1000 },
    },
  };

  assert.equal(scoreClan(legacy, event).score, 100);
  assert.equal(scoreClan(current, event).score, 100);
});

test("scoring uses newer memberStats without changing negative semantics", () => {
  const clan = {
    eventId: "1000",
    members: {
      a: { name: "A", mmr: 1100, syncedAt: 10, eventBaseline: 1000 },
      b: { name: "B", mmr: 900, syncedAt: 20, eventBaseline: 1000 },
    },
    memberStats: {
      a: { mmr: 1250, syncedAt: 11 },
      b: { mmr: 5000, syncedAt: 19 },
    },
  };

  const scored = scoreClan(clan, event);
  assert.equal(scored.score, 150);
  assert.deepEqual(scored.rows.map(row => row.delta), [250, -100]);
});

test("standings exclude stale event clans and keep normalized member arrays", () => {
  const standings = buildStandings([
    {
      id: "new",
      tag: "NEW",
      eventId: "1000",
      members: { a: { mmr: 1100, eventBaseline: 1000 } },
    },
    {
      id: "old",
      tag: "OLD",
      eventId: "999",
      members: [{ userId: "b", mmr: 2000 }],
      eventBaseline: { b: 1000 },
    },
  ], event);

  assert.equal(standings.length, 1);
  assert.equal(standings[0].id, "new");
  assert.ok(Array.isArray(standings[0].members));
  assert.equal(standings[0].score, 100);
});

test("waiting roster includes stale clans and members without a baseline", () => {
  const waiting = buildWaitingRoster([
    {
      id: "stale",
      tag: "OLD",
      eventId: "999",
      members: { a: { name: "Alpha", eventBaseline: 700 } },
    },
    {
      id: "current",
      tag: "NOW",
      eventId: "1000",
      members: {
        b: { name: "Bravo", eventBaseline: 800 },
        c: { name: "Charlie" },
      },
    },
  ], event);

  assert.deepEqual(waiting.map(group => [
    group.clanTag,
    group.members.map(member => member.name),
  ]), [
    ["OLD", ["Alpha"]],
    ["NOW", ["Charlie"]],
  ]);
});
