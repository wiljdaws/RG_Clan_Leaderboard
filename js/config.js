// This is the same public Firebase config ATLAS uses.
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD29s2Jku_DZ42keIQAETgKg7HWt__QEwY",
  authDomain: "rgleaderboard.firebaseapp.com",
  projectId: "rgleaderboard",
  storageBucket: "rgleaderboard.firebasestorage.app",
  messagingSenderId: "247848634543",
  appId: "1:247848634543:web:6a7e506d60544d46cc6c5a",
  measurementId: "G-JW3Q972P9T",
};

export const COLLECTIONS = {
  clans: "clans",
  clanDirectory: ["clans_directory", "index"],
  clanNotices: "clan_notices",
  clanNameKeys: "clan_name_keys",
  clanTagKeys: "clan_tag_keys",
  clanMemberships: "clan_memberships",
  clanDevices: "clan_devices",
  eventDoc: ["events", "current"],
};

export const ADMIN_EMAILS = [
  "underflagfg@gmail.com",
  "therootedengineer@gmail.com",
];

export const ADMIN_FEATURES = {
  disbandEnabled: true,
  // Older ATLAS versions already know how to show this notice type.
  noticeType: "kicked",
  // Reservation records do not exist in production yet.
  reservationCleanupEnabled: false,
};

export const SDK = "10.12.2";
