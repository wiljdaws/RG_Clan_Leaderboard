import assert from "node:assert/strict";
import test from "node:test";

import {
  clanNameKey,
  directoryWithoutClan,
  disbandWarning,
  duplicateClanIds,
  formatEventTimeLeft,
  normalizeClanName,
  normalizeClanTag,
} from "../js/admin.js";

test("clan names and tags use one stable format", async () => {
  assert.equal(normalizeClanName("  Alpha   Omega "), "alpha omega");
  assert.equal(normalizeClanTag(" king "), "KING");
  assert.equal(
    await clanNameKey("Alpha Omega"),
    await clanNameKey(" alpha   omega "),
  );
});

test("duplicate names and tags are both flagged", () => {
  const duplicates = duplicateClanIds([
    { id: "one", name: "Alpha Omega", tag: "KING" },
    { id: "two", name: " alpha  omega ", tag: "NEW" },
    { id: "three", name: "Other", tag: "king" },
    { id: "four", name: "Unique", tag: "ONLY" },
  ]);

  assert.deepEqual([...duplicates].sort(), ["one", "three", "two"]);
});

test("disbanding removes only the chosen directory row", () => {
  const directory = [
    { id: "one", name: "One" },
    { id: "two", name: "Two" },
  ];

  assert.deepEqual(directoryWithoutClan(directory, "one"), [
    { id: "two", name: "Two" },
  ]);
  assert.equal(directory.length, 2);
});

test("active events show the exact time left before disbanding", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  const end = now + ((2 * 24 + 3) * 60 + 15) * 60_000;
  assert.equal(formatEventTimeLeft(end, now), "2d 3h");
  assert.equal(
    disbandWarning(end, now),
    "A clan event is still going with 2d 3h left. Do you want to disband?",
  );
  assert.equal(
    disbandWarning(now, now),
    "Do you want to disband this clan?",
  );
});
