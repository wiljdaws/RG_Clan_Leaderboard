import assert from "node:assert/strict";
import test from "node:test";

import { disbandClan } from "../js/admin.js";

function snapshot(data) {
  return {
    exists: () => data !== undefined,
    data: () => data,
  };
}

function fakeFirebase({ includeLegacy = true } = {}) {
  const operations = [];
  const documents = new Map([
    ["clans/c1", {
      name: "Clan One",
      tag: "[K1-NG!]",
      nameKey: "stored-name",
      tagKey: "stored-tag",
      memberIds: ["u3"],
      deviceIds: ["clan-device"],
      members: {
        u1: { name: "One", deviceId: "member-device" },
        u2: { name: "Two", deviceIds: ["member-device-2"] },
      },
      memberStats: {
        u1: { deviceIds: ["stats-device"] },
      },
    }],
    ["clans_directory/c1", {
      memberIds: ["u4"],
      deviceIds: ["shard-device"],
    }],
    ["clan_memberships/u1", { clanId: "c1", deviceIds: ["membership-device"] }],
  ]);
  if (includeLegacy) {
    documents.set("clans_directory/index", {
      clans: [
        { id: "c1", memberIds: ["u5"], deviceIds: ["legacy-device"] },
        { id: "c2", name: "Other" },
      ],
      bridgeVersion: 1,
    });
  }
  const transaction = {
    async get(ref) { return snapshot(documents.get(ref)); },
    set(ref, value, options) {
      operations.push({ type: "set", ref, value, options });
    },
    delete(ref) { operations.push({ type: "delete", ref }); },
  };
  return {
    operations,
    fb: {
      db: {},
      doc: (_db, ...parts) => parts.join("/"),
      runTransaction: async (_db, callback) => callback(transaction),
    },
  };
}

test("disband transaction removes bridge directory and every known lock", async () => {
  const { fb, operations } = fakeFirebase();
  const result = await disbandClan({
    fb,
    clanId: "c1",
    noticeType: "kicked",
    releaseReservations: true,
    now: "2026-08-02T00:00:00.000Z",
  });

  assert.equal(result.notified, 5);
  assert.equal(result.devicesReleased, 7);

  const deletes = operations
    .filter(operation => operation.type === "delete")
    .map(operation => operation.ref);
  for (const ref of [
    "clans_directory/c1",
    "clans/c1",
    "clan_memberships/u1",
    "clan_memberships/u2",
    "clan_memberships/u3",
    "clan_memberships/u4",
    "clan_memberships/u5",
    "clan_devices/clan-device",
    "clan_devices/member-device",
    "clan_devices/member-device-2",
    "clan_devices/stats-device",
    "clan_devices/shard-device",
    "clan_devices/legacy-device",
    "clan_devices/membership-device",
    "clan_name_keys/stored-name",
    "clan_tag_keys/stored-tag",
    "clan_tag_keys/KNG",
  ]) {
    assert.ok(deletes.includes(ref), `missing delete for ${ref}`);
  }
  assert.ok(deletes.some(ref => /^clan_name_keys\/[a-f0-9]{64}$/.test(ref)));

  const legacyWrite = operations.find(operation =>
    operation.type === "set" && operation.ref === "clans_directory/index");
  assert.deepEqual(legacyWrite.value.clans, [{ id: "c2", name: "Other" }]);
  assert.deepEqual(legacyWrite.options, { merge: true });

  const notices = operations.filter(operation =>
    operation.type === "set" && operation.ref.startsWith("clan_notices/"));
  assert.equal(notices.length, 5);
  assert.ok(notices.every(operation => operation.value.type === "kicked"));
});

test("disband refuses to delete the clan while cleanup is paused", async () => {
  const { fb, operations } = fakeFirebase();
  await assert.rejects(
    disbandClan({ fb, clanId: "c1", releaseReservations: false }),
    /cleanup is paused/i,
  );
  assert.deepEqual(operations, []);
});

test("disband does not recreate the legacy directory after cutover", async () => {
  const { fb, operations } = fakeFirebase({ includeLegacy: false });
  await disbandClan({
    fb,
    clanId: "c1",
    releaseReservations: true,
  });

  assert.equal(operations.some(operation =>
    operation.type === "set" && operation.ref === "clans_directory/index"), false);
});
