import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateServerOffset,
  createServerClock,
  createSnapshotCoordinator,
  deriveDataMode,
  syncServerClock,
} from "../js/live-state.js";

test("first snapshot gate waits for both event and clans", () => {
  const commits = [];
  const coordinator = createSnapshotCoordinator({
    onCommit: value => commits.push(value),
  });

  coordinator.beginCycle();
  coordinator.receiveClans([{ id: "one" }]);
  assert.equal(commits.length, 0);
  assert.equal(coordinator.getState().hasCommitted, false);

  coordinator.receiveEvent({ startTime: 1000 });
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], {
    event: { startTime: 1000 },
    clans: [{ id: "one" }],
  });
});

test("missing event settles degraded, then a late event re-renders", () => {
  const commits = [];
  const coordinator = createSnapshotCoordinator({
    onCommit: value => commits.push(value),
  });

  coordinator.beginCycle();
  coordinator.receiveClans([{ id: "one" }]);
  coordinator.receiveEvent(null);

  assert.equal(deriveDataMode({
    ...coordinator.getState(),
    online: true,
  }), "degraded");

  coordinator.receiveEvent({ startTime: 2000 });
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[1].event, { startTime: 2000 });
  assert.equal(deriveDataMode({
    ...coordinator.getState(),
    online: true,
  }), "live");
});

test("listener errors leave the last committed pair available", () => {
  const coordinator = createSnapshotCoordinator();
  coordinator.beginCycle();
  coordinator.receiveEvent({ startTime: 1000 });
  coordinator.receiveClans([{ id: "one" }]);
  coordinator.failClans(new Error("offline"));

  assert.deepEqual(coordinator.getState().clans, [{ id: "one" }]);
  assert.equal(deriveDataMode({
    ...coordinator.getState(),
    online: true,
  }), "degraded");
});

test("server clock uses midpoint offset and falls back cleanly", async () => {
  assert.equal(calculateServerOffset(2000, 1000, 1100), 950);
  assert.equal(calculateServerOffset(NaN, 1000, 1100), 0);

  const clock = createServerClock(() => 1200);
  const times = [1000, 1100];
  const offset = await syncServerClock(
    async () => ({
      ok: true,
      headers: { get: () => new Date(2000).toUTCString() },
    }),
    "/",
    clock,
    () => times.shift(),
  );
  assert.equal(offset, 950);
  assert.equal(clock.now(), 2150);
});

test("demo always has an explicit state", () => {
  assert.equal(deriveDataMode({ demo: true }), "demo");
  assert.equal(deriveDataMode({ hasCommitted: false }), "loading");
  assert.equal(deriveDataMode({
    hasCommitted: false,
    online: false,
  }), "degraded");
});
