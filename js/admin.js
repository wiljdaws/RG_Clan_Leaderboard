import {
  ADMIN_EMAILS,
  ADMIN_FEATURES,
  COLLECTIONS,
  SDK,
} from "./config.js";
import { clanMembers } from "./members.js";

let adminClans = [];
let adminReady = false;
let isAdmin = false;
let selectedClan = null;
let firebase = null;
let adminEvent = null;
let adminNow = () => Date.now();
let previousFocus = null;

export function normalizeClanName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeClanTag(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 4);
}

export async function clanNameKey(name) {
  const bytes = new TextEncoder().encode(normalizeClanName(name));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

export function duplicateClanIds(clans) {
  const seenNames = new Map();
  const seenTags = new Map();
  const duplicates = new Set();

  for (const clan of Array.isArray(clans) ? clans : []) {
    const name = normalizeClanName(clan?.name);
    const tag = normalizeClanTag(clan?.tag);
    for (const [key, seen] of [[name, seenNames], [tag, seenTags]]) {
      if (!key) continue;
      if (seen.has(key)) {
        duplicates.add(seen.get(key));
        duplicates.add(clan.id);
      } else {
        seen.set(key, clan.id);
      }
    }
  }

  return duplicates;
}

export function directoryWithoutClan(clans, clanId) {
  return (Array.isArray(clans) ? clans : [])
    .filter(clan => clan?.id !== clanId);
}

export function formatEventTimeLeft(endTime, now = Date.now()) {
  const remaining = Number(endTime) - Number(now);
  if (!Number.isFinite(remaining) || remaining <= 0) return "";
  const totalMinutes = Math.max(1, Math.ceil(remaining / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    !days && minutes ? `${minutes}m` : "",
  ].filter(Boolean).join(" ");
}

export function disbandWarning(endTime, now = Date.now()) {
  const timeLeft = formatEventTimeLeft(endTime, now);
  return timeLeft
    ? `A clan event is still going with ${timeLeft} left. Do you want to disband?`
    : "Do you want to disband this clan?";
}

export function reservationCleanupEnabled(
  event,
  features = ADMIN_FEATURES,
) {
  return event?.useClanReservations === true
    && features.reservationCleanupEmergencyDisabled !== true;
}

export function adminDisbandEnabled(
  event,
  features = ADMIN_FEATURES,
) {
  return features.disbandEnabled === true
    && (
      event?.useClanReservations !== true
      || reservationCleanupEnabled(event, features)
    );
}

function addDeviceIds(ids, source) {
  if (!source || typeof source !== "object") return;
  if (typeof source.deviceId === "string" && source.deviceId) {
    ids.add(source.deviceId);
  }
  for (const deviceId of Array.isArray(source.deviceIds) ? source.deviceIds : []) {
    if (typeof deviceId === "string" && deviceId) ids.add(deviceId);
  }
}

export function knownDeviceIds(clan, ...sources) {
  const ids = new Set();
  addDeviceIds(ids, clan);
  for (const member of clanMembers(clan)) {
    addDeviceIds(ids, member);
    const stats = clan?.memberStats?.[member?.userId];
    addDeviceIds(ids, stats);
  }
  for (const stats of Object.values(clan?.memberStats ?? {})) addDeviceIds(ids, stats);
  for (const source of sources.flat()) addDeviceIds(ids, source);
  return [...ids].filter(Boolean);
}

function knownMemberIds(clan, ...sources) {
  const ids = new Set(clanMembers(clan).map(member => member.userId).filter(Boolean));
  for (const source of [clan, ...sources.flat()]) {
    for (const userId of Array.isArray(source?.memberIds) ? source.memberIds : []) {
      if (typeof userId === "string" && userId) ids.add(userId);
    }
  }
  return [...ids];
}

export async function disbandClan({
  fb,
  clanId,
  message = "",
  now = new Date().toISOString(),
  noticeType = "kicked",
  reservationsActive = true,
  releaseReservations = false,
}) {
  if (!fb?.db || !clanId) throw new Error("Missing clan details.");
  if (reservationsActive && !releaseReservations) {
    throw new Error("Clan cleanup is paused. Nothing was changed.");
  }

  const clanRef = fb.doc(fb.db, COLLECTIONS.clans, clanId);
  const directoryShardRef = fb.doc(
    fb.db,
    COLLECTIONS.clanDirectoryCollection,
    clanId,
  );
  const legacyDirectoryRef = fb.doc(fb.db, ...COLLECTIONS.clanDirectory);
  let result = null;

  await fb.runTransaction(fb.db, async transaction => {
    const clanSnapshot = await transaction.get(clanRef);
    const directoryShardSnapshot = await transaction.get(directoryShardRef);
    const legacyDirectorySnapshot = await transaction.get(legacyDirectoryRef);
    if (!clanSnapshot.exists()) {
      throw new Error("That clan no longer exists.");
    }

    const clan = { id: clanId, ...clanSnapshot.data() };
    const directoryShard = directoryShardSnapshot.exists()
      ? directoryShardSnapshot.data()
      : null;
    const currentDirectory = legacyDirectorySnapshot.exists()
      ? (legacyDirectorySnapshot.data().clans ?? [])
      : [];
    const legacyDirectoryEntry = currentDirectory.find(entry => entry?.id === clanId);
    const memberIds = knownMemberIds(clan, directoryShard, legacyDirectoryEntry);
    const membershipRefs = releaseReservations
      ? memberIds.map(userId =>
        fb.doc(fb.db, COLLECTIONS.clanMemberships, userId))
      : [];
    const membershipSnapshots = releaseReservations
      ? await Promise.all(membershipRefs.map(ref => transaction.get(ref)))
      : [];
    const membershipRecords = membershipSnapshots
      .filter(snapshot => snapshot.exists())
      .map(snapshot => snapshot.data());
    const deviceIds = knownDeviceIds(
      clan,
      directoryShard,
      legacyDirectoryEntry,
      membershipRecords,
    );
    const nameKeys = new Set([
      typeof clan.nameKey === "string" ? clan.nameKey : "",
      await clanNameKey(clan.name),
    ].filter(Boolean));
    const tagKeys = new Set([
      typeof clan.tagKey === "string" ? clan.tagKey : "",
      normalizeClanTag(clan.tag),
    ].filter(Boolean));
    const cleanMessage = String(message ?? "").trim().slice(0, 300);

    for (const userId of memberIds) {
      transaction.set(
        fb.doc(fb.db, COLLECTIONS.clanNotices, userId),
        {
          type: noticeType,
          clanId,
          clanName: clan.name ?? "Unknown clan",
          message: cleanMessage,
          at: now,
        },
      );
      if (releaseReservations) {
        transaction.delete(fb.doc(fb.db, COLLECTIONS.clanMemberships, userId));
      }
    }

    if (releaseReservations) {
      for (const deviceId of deviceIds) {
        transaction.delete(fb.doc(fb.db, COLLECTIONS.clanDevices, deviceId));
      }

      for (const nameKey of nameKeys) {
        transaction.delete(fb.doc(fb.db, COLLECTIONS.clanNameKeys, nameKey));
      }
      for (const tagKey of tagKeys) {
        transaction.delete(fb.doc(fb.db, COLLECTIONS.clanTagKeys, tagKey));
      }

      transaction.delete(directoryShardRef);
    }
    if (legacyDirectorySnapshot.exists()) {
      transaction.set(legacyDirectoryRef, {
        clans: directoryWithoutClan(currentDirectory, clanId),
      }, { merge: true });
    }
    transaction.delete(clanRef);

    result = {
      clanId,
      clanName: clan.name ?? "Unknown clan",
      notified: memberIds.length,
      devicesReleased: releaseReservations ? deviceIds.length : 0,
    };
  });

  return result;
}

function text(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setAdminVisible(visible) {
  const panel = document.getElementById("adminPanel");
  if (panel) panel.hidden = !visible;
}

function closeDisbandDialog() {
  selectedClan = null;
  const modal = document.getElementById("adminDisbandModal");
  if (modal) modal.hidden = true;
  const message = document.getElementById("adminDisbandMessage");
  if (message) message.value = "";
  if (previousFocus?.isConnected) previousFocus.focus();
  previousFocus = null;
}

function openDisbandDialog(clan) {
  if (!adminDisbandEnabled(adminEvent)) return;
  previousFocus = document.activeElement;
  selectedClan = clan;
  text("adminDisbandClanName", `${clan.tag ? `[${clan.tag}] ` : ""}${clan.name}`);
  text("adminDisbandWarning", disbandWarning(adminEvent?.endTime, adminNow()));
  const modal = document.getElementById("adminDisbandModal");
  if (modal) modal.hidden = false;
  document.getElementById("adminDisbandMessage")?.focus();
}

function renderAdminClans() {
  const list = document.getElementById("adminClanList");
  if (!list || !isAdmin) return;

  const query = document.getElementById("adminClanSearch")?.value
    ?.trim()
    .toLowerCase() ?? "";
  const duplicateIds = duplicateClanIds(adminClans);
  const canDisband = adminDisbandEnabled(adminEvent);
  const clans = adminClans
    .filter(clan => {
      if (!query) return true;
      return String(clan.name ?? "").toLowerCase().includes(query)
        || String(clan.tag ?? "").toLowerCase().includes(query)
        || clanMembers(clan).some(member =>
          String(member?.name ?? "").toLowerCase().includes(query));
    })
    .sort((a, b) => String(a.tag ?? "").localeCompare(String(b.tag ?? "")));

  list.replaceChildren();
  if (!clans.length) {
    const empty = document.createElement("p");
    empty.className = "admin-empty";
    empty.textContent = query ? "No clans match that search." : "No clans found.";
    list.appendChild(empty);
    return;
  }

  for (const clan of clans) {
    const row = document.createElement("article");
    row.className = "admin-clan";

    const copy = document.createElement("div");
    copy.className = "admin-clan-copy";

    const title = document.createElement("strong");
    title.textContent = `${clan.tag ? `[${clan.tag}] ` : ""}${clan.name ?? "Unnamed clan"}`;
    copy.appendChild(title);

    const meta = document.createElement("span");
    const memberCount = clanMembers(clan).length;
    meta.textContent = `${memberCount} member${memberCount === 1 ? "" : "s"} · ${clan.id}`;
    copy.appendChild(meta);

    if (duplicateIds.has(clan.id)) {
      const warning = document.createElement("span");
      warning.className = "admin-duplicate";
      warning.textContent = "Duplicate name or tag";
      copy.appendChild(warning);
    }

    const button = document.createElement("button");
    button.className = "admin-danger";
    button.type = "button";
    button.textContent = canDisband ? "Disband" : "Locked";
    button.disabled = !canDisband;
    button.addEventListener("click", () => openDisbandDialog(clan));

    row.append(copy, button);
    list.appendChild(row);
  }
}

export function setAdminClans(clans) {
  adminClans = Array.isArray(clans) ? clans : [];
  renderAdminClans();
}

export function setAdminEvent(event) {
  adminEvent = event ?? null;
  const note = document.getElementById("adminCleanupNote");
  if (note) {
    note.textContent = adminEvent?.useClanReservations !== true
      ? "Legacy disband is available. Reservation locks are not active yet."
      : reservationCleanupEnabled(adminEvent)
      ? "Every disband asks for confirmation and removes all reservation locks."
      : "Disbanding is locked until reservation cleanup is enabled for the live event.";
  }
  renderAdminClans();
}

export function setAdminNowProvider(provider) {
  if (typeof provider === "function") adminNow = provider;
}

export function showAdminUnavailable(message) {
  text("adminAuthNote", message || "Admin login is unavailable.");
  document.getElementById("adminLoginBtn")?.setAttribute("disabled", "");
}

export async function initClanAdmin({ app, db }) {
  if (adminReady) return;
  adminReady = true;

  const authSdk = await import(
    `https://www.gstatic.com/firebasejs/${SDK}/firebase-auth.js`
  );
  const firestoreSdk = await import(
    `https://www.gstatic.com/firebasejs/${SDK}/firebase-firestore.js`
  );

  firebase = {
    db,
    doc: firestoreSdk.doc,
    runTransaction: firestoreSdk.runTransaction,
  };

  const auth = authSdk.getAuth(app);
  const provider = new authSdk.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  const loginButton = document.getElementById("adminLoginBtn");
  const logoutButton = document.getElementById("adminLogoutBtn");
  const confirmButton = document.getElementById("adminDisbandConfirm");

  loginButton?.addEventListener("click", async () => {
    loginButton.disabled = true;
    text("adminAuthNote", "Opening Google sign-in...");
    try {
      await authSdk.signInWithPopup(auth, provider);
    } catch (error) {
      text("adminAuthNote", error?.message || "Google sign-in failed.");
    } finally {
      loginButton.disabled = false;
    }
  });

  logoutButton?.addEventListener("click", () => authSdk.signOut(auth));
  document.getElementById("adminClanSearch")
    ?.addEventListener("input", renderAdminClans);
  document.getElementById("adminDisbandCancel")
    ?.addEventListener("click", closeDisbandDialog);
  document.querySelector("#adminDisbandModal [data-close]")
    ?.addEventListener("click", closeDisbandDialog);

  confirmButton?.addEventListener("click", async () => {
    if (!selectedClan || !isAdmin || !ADMIN_FEATURES.disbandEnabled) return;
    confirmButton.disabled = true;
    confirmButton.textContent = "Disbanding...";
    text("adminDisbandError", "");
    try {
      const result = await disbandClan({
        fb: firebase,
        clanId: selectedClan.id,
        message: document.getElementById("adminDisbandMessage")?.value,
        noticeType: ADMIN_FEATURES.noticeType,
        reservationsActive: adminEvent?.useClanReservations === true,
        releaseReservations: reservationCleanupEnabled(adminEvent),
      });
      closeDisbandDialog();
      text("adminAuthNote", `${result.clanName} was disbanded. ${result.notified} player${result.notified === 1 ? "" : "s"} will see the notice.`);
    } catch (error) {
      text("adminDisbandError", error?.message || "Could not disband that clan.");
    } finally {
      confirmButton.disabled = false;
      confirmButton.textContent = "Yes, disband";
    }
  });

  authSdk.onAuthStateChanged(auth, user => {
    isAdmin = !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
    if (loginButton) loginButton.hidden = !!user;
    if (logoutButton) logoutButton.hidden = !user;
    text("adminUserEmail", user?.email ?? "");

    if (!user) {
      text("adminAuthNote", "Sign in with an approved Google account.");
    } else if (!isAdmin) {
      text("adminAuthNote", `${user.email} does not have admin access.`);
    } else if (adminDisbandEnabled(adminEvent)) {
      text("adminAuthNote", "Admin access is active. Every disband needs confirmation.");
    } else {
      text("adminAuthNote", "Admin access is ready. Reservation cleanup is currently locked.");
    }

    setAdminVisible(isAdmin);
    if (!isAdmin) closeDisbandDialog();
    renderAdminClans();
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !document.getElementById("adminDisbandModal")?.hidden) {
      closeDisbandDialog();
    }
  });
}
