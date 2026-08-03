import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  dataStateCopy,
  standingsEmptyCopy,
} from "../js/render.js";

const [renderSource, css] = await Promise.all([
  readFile(new URL("../js/render.js", import.meta.url), "utf8"),
  readFile(new URL("../css/clash.css", import.meta.url), "utf8"),
]);

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

test("compare sides show one tag and the clan name", () => {
  assert.match(
    renderSource,
    /<div class="cname">\$\{esc\(c\.name\)\}<\/div>/,
  );
  assert.match(
    renderSource,
    /<div class="cmeta">\$\{rosterLabel\(c\.members\.length, ctx\.maxMembers\)\}<\/div>/,
  );
});

test("compare gap aligns with the clan totals", () => {
  assert.match(
    css,
    /\.cmp-gap\{[^}]*align-self:start;[^}]*margin-top:84px/s,
  );
});

test("compare member deltas use one fixed-width number column", () => {
  assert.match(
    css,
    /\.cmp-contribs li\{[^}]*grid-template-columns:minmax\(0,1fr\) 7ch/s,
  );
  assert.match(
    css,
    /\.cmp-contribs \.d\{[^}]*inline-size:7ch;[^}]*text-align:left/s,
  );
});
