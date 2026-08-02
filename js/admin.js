import {
  ADMIN_EMAILS,
  ADMIN_FEATURES,
  COLLECTIONS,
  SDK,
} from "./config.js";

let adminClans = [];
let adminReady = false;
let isAdmin = false;
let selectedClan = null;
let firebase = null;
let eventEndTime = 0;

export function normalizeClanName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeClanTag(value) {
  return String(value ?? "").trim().toUpperCase();
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

function clanDeviceIds(clan) {
  const ids = new Set();
  for (const member of clan?.members ?? []) {
    if (member?.deviceId) ids.add(member.deviceId);
    for (const deviceId of member?.deviceIds ?? []) ids.add(deviceId);
    const stats = clan?.memberStats?.[member?.userId];
    if (stats?.deviceId) ids.add(stats.deviceId);
    for (const deviceId of stats?.deviceIds ?? []) ids.add(deviceId);
  }
  return [...ids].filter(Boolean);
}

export async function disbandClan({
  fb,
  clanId,
  message = "",
  now = new Date().toISOString(),
  releaseReservations = false,
}) {
  if (!fb?.db || !clanId) throw new Error("Missing clan details.");

  const clanRef = fb.doc(fb.db, COLLECTIONS.clans, clanId);
  const directoryRef = fb.doc(fb.db, ...COLLECTIONS.clanDirectory);
  let result = null;

  await fb.runTransaction(fb.db, async transaction => {
    const clanSnapshot = await transaction.get(clanRef);
    const directorySnapshot = await transaction.get(directoryRef);
    if (!clanSnapshot.exists()) {
      throw new Error("That clan no longer exists.");
    }

    const clan = { id: clanId, ...clanSnapshot.data() };
    const nameKey = releaseReservations ? await clanNameKey(clan.name) : "";
    const tagKey = releaseReservations ? normalizeClanTag(clan.tag) : "";
    const members = clan.members ?? [];
    const memberIds = [...new Set(members.map(member => member?.userId).filter(Boolean))];
    const deviceIds = releaseReservations ? clanDeviceIds(clan) : [];
    const cleanMessage = String(message ?? "").trim().slice(0, 300);

    for (const userId of memberIds) {
      transaction.set(
        fb.doc(fb.db, COLLECTIONS.clanNotices, userId),
        {
          type: "admin_disbanded",
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

    for (const deviceId of deviceIds) {
      transaction.delete(fb.doc(fb.db, COLLECTIONS.clanDevices, deviceId));
    }

    if (nameKey) {
      transaction.delete(fb.doc(fb.db, COLLECTIONS.clanNameKeys, nameKey));
    }
    if (tagKey) {
      transaction.delete(fb.doc(fb.db, COLLECTIONS.clanTagKeys, tagKey));
    }

    const currentDirectory = directorySnapshot.exists()
      ? (directorySnapshot.data().clans ?? [])
      : [];
    transaction.set(directoryRef, {
      clans: directoryWithoutClan(currentDirectory, clanId),
    });
    transaction.delete(clanRef);

    result = {
      clanId,
      clanName: clan.name ?? "Unknown clan",
      notified: memberIds.length,
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
}

function openDisbandDialog(clan) {
  if (!ADMIN_FEATURES.disbandEnabled) return;
  selectedClan = clan;
  text("adminDisbandClanName", `${clan.tag ? `[${clan.tag}] ` : ""}${clan.name}`);
  text("adminDisbandWarning", disbandWarning(eventEndTime));
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
  const clans = adminClans
    .filter(clan => {
      if (!query) return true;
      return String(clan.name ?? "").toLowerCase().includes(query)
        || String(clan.tag ?? "").toLowerCase().includes(query)
        || (clan.members ?? []).some(member =>
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
    meta.textContent = `${(clan.members ?? []).length} member${(clan.members ?? []).length === 1 ? "" : "s"} · ${clan.id}`;
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
    button.textContent = ADMIN_FEATURES.disbandEnabled ? "Disband" : "Locked";
    button.disabled = !ADMIN_FEATURES.disbandEnabled;
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
  eventEndTime = Number(event?.endTime) || 0;
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
        releaseReservations: ADMIN_FEATURES.reservationCleanupEnabled,
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
    } else if (ADMIN_FEATURES.disbandEnabled) {
      text("adminAuthNote", "Admin access is active. Every disband needs confirmation.");
    } else {
      text("adminAuthNote", "Admin access is ready. Disbanding stays locked until the event ends.");
    }

    setAdminVisible(isAdmin);
    if (!isAdmin) closeDisbandDialog();
    renderAdminClans();
  });
}
