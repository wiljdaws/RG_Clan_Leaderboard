import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, css, app, render, admin] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../css/clash.css", import.meta.url), "utf8"),
  readFile(new URL("../js/app.js", import.meta.url), "utf8"),
  readFile(new URL("../js/render.js", import.meta.url), "utf8"),
  readFile(new URL("../js/admin.js", import.meta.url), "utf8"),
]);

test("live states and errors are announced without stealing focus", () => {
  assert.match(html, /id="dataState"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="adminDisbandError"[^>]*role="alert"[^>]*aria-live="assertive"/);
});

test("tabs support arrow keys and identify their panels", () => {
  for (const panel of ["clansBoard", "playersBoard", "archiveBoard"]) {
    assert.match(html, new RegExp(`aria-controls="${panel}"`));
  }
  assert.match(app, /ArrowLeft/);
  assert.match(app, /ArrowRight/);
  assert.match(app, /tabs\[next\]\.focus\(\)/);
});

test("dialogs move focus in and restore it on close", () => {
  assert.match(render, /compareReturnFocus = document\.activeElement/);
  assert.match(render, /compareReturnFocus\?\.isConnected/);
  assert.match(admin, /previousFocus = document\.activeElement/);
  assert.match(admin, /previousFocus\?\.isConnected/);
  assert.match(app, /event\.key !== "Tab"/);
  assert.match(app, /trapOpenDialogFocus\(e\)/);
  assert.match(app, /e\.key === "Escape"/);
});

test("mobile layout keeps core controls touch friendly", () => {
  assert.match(css, /@media \(max-width:680px\)/);
  assert.match(css, /\.tab\{flex:1;min-height:44px/);
  assert.match(css, /\.act\{width:44px;height:44px\}/);
  assert.match(css, /\.archive-toolbar\{grid-template-columns:1fr\}/);
});

test("reduced motion removes transitions and skips confetti", () => {
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(css, /animation:none!important;transition:none!important/);
  assert.match(render, /matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(render, /if \(!reducedMotion\)/);
});

test("keyboard focus is visible on page and archive controls", () => {
  assert.match(css, /\.act:focus-visible/);
  assert.match(css, /\.tab:focus-visible/);
  assert.match(css, /\.archive-toolbar select:focus-visible/);
  assert.match(css, /\.archive-clear:focus-visible/);
});
