import assert from "node:assert/strict";
import test from "node:test";

import {
  dataStateCopy,
  standingsEmptyCopy,
} from "../js/render.js";

test("every connection mode has plain, explicit render copy", () => {
  assert.equal(dataStateCopy("loading").title, "Loading live standings");
  assert.equal(dataStateCopy("live").title, "Live");
  assert.equal(dataStateCopy("degraded").title, "Connection limited");
  assert.equal(dataStateCopy("demo").title, "Demo data");
});

test("missing events and listener errors render different empty states", () => {
  assert.deepEqual(standingsEmptyCopy("event"), {
    title: "Event details unavailable",
    detail: "Scores are paused until the live event document returns.",
  });
  assert.equal(standingsEmptyCopy("error").title, "Standings unavailable");
  assert.equal(standingsEmptyCopy("filter").title, "No clans match");
});
