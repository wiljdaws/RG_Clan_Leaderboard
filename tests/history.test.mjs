import assert from "node:assert/strict";
import test from "node:test";

import { EventHistoryStore } from "../js/history.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const event = (startTime, name) => ({
  startTime,
  endTime: startTime + 4 * 60 * 60_000,
  name,
});
const standings = (score, rank = 1, delta = score) => [{
  id: "clan",
  tag: "ONE",
  name: "One",
  score,
  rank,
  rows: [{ userId: "a", name: "Alpha", delta }],
}];

test("history stays event-scoped and deduplicates unchanged snapshots", () => {
  const store = new EventHistoryStore({ storage: memoryStorage() });
  const one = event(1000, "One");
  const two = event(2000, "Two");

  assert.equal(store.record(one, standings(10), 3000), true);
  assert.equal(store.record(one, standings(10), 4000), false);
  assert.equal(store.record(two, standings(20), 5000), true);

  assert.equal(store.snapshots("1000").length, 1);
  assert.equal(store.snapshots("2000").length, 1);
  assert.deepEqual(store.list().map(item => item.id), ["2000", "1000"]);
});

test("replay, momentum, rank changes, and gains use one event only", () => {
  const store = new EventHistoryStore({ storage: memoryStorage() });
  const current = event(1_000_000, "Cup");
  store.record(current, standings(100, 2, 100), 4_000_000);
  store.record(current, standings(175, 1, 175), 4_030_000);

  assert.deepEqual(store.momentum("1000000", "clan"), {
    gained: 75,
    spanMs: 30_000,
  });
  assert.equal(store.rankChanges("1000000")[0].direction, "up");
  assert.equal(store.bigGains("1000000")[0].gain, 75);

  const replay = store.replay("1000000", 0);
  assert.equal(replay.index, 0);
  assert.equal(replay.total, 2);
  assert.equal(replay.snapshot.clans[0].score, 100);
});

test("clearing one archive does not touch another event", () => {
  const store = new EventHistoryStore({ storage: memoryStorage() });
  store.record(event(1000, "One"), standings(10), 3000);
  store.record(event(2000, "Two"), standings(20), 4000);

  store.clear("1000");
  assert.equal(store.replay("1000"), null);
  assert.equal(store.replay("2000").snapshot.clans[0].score, 20);
});

test("storage errors are exposed without breaking in-memory replay", () => {
  const store = new EventHistoryStore({
    storage: {
      getItem() { return null; },
      setItem() { throw new Error("quota"); },
    },
  });
  store.record(event(1000, "One"), standings(10), 3000);

  assert.equal(store.error, "Local history could not be saved.");
  assert.equal(store.replay("1000").snapshot.clans[0].score, 10);
});
