import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, css, config] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../css/clash.css", import.meta.url), "utf8"),
  readFile(new URL("../js/config.js", import.meta.url), "utf8"),
]);

test("admin controls stay hidden until an approved account signs in", () => {
  assert.match(
    html,
    /id="adminPanel"[^>]*hidden/,
  );
  assert.match(
    html,
    /id="adminDisbandModal"[^>]*hidden/,
  );
  assert.match(css, /\.admin-panel\[hidden\]\{display:none\}/);
});

test("admin form has search, confirmation, message, and error controls", () => {
  for (const id of [
    "adminLoginBtn",
    "adminLogoutBtn",
    "adminClanSearch",
    "adminDisbandMessage",
    "adminDisbandCancel",
    "adminDisbandConfirm",
    "adminDisbandError",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test("live disbanding remains locked for the event", () => {
  assert.match(config, /disbandEnabled:\s*false/);
  assert.match(html, /Disbanding stays locked until the Clan event ends\./);
});

test("admin controls have a single-column mobile layout", () => {
  assert.match(css, /@media \(max-width:760px\)/);
  assert.match(css, /\.admin-panel-head\{grid-template-columns:1fr/);
  assert.match(css, /\.admin-clan\{grid-template-columns:1fr\}/);
});
