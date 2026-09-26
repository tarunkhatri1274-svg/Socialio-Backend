// src/config/firebaseAdmin.js
//
// Firebase Admin SDK — used to send real push notifications (FCM) to a
// user's device even when their app is fully closed/killed. This is
// different from socket.io, which only reaches an app that's currently
// running (foreground or backgrounded-but-alive).
//
// FIX — this used to do `import admin from "firebase-admin"` and then
// check `admin.apps.length`. That's the old "namespaced" API, and it
// doesn't reliably survive Node's CJS→ESM interop in a real ESM project
// (no transpiler, "type": "module" in package.json — exactly this
// backend's setup) — `admin.apps` came back undefined, crashing on
// `.length`. Firebase's own docs recommend the "modular" API
// (`firebase-admin/app`, `firebase-admin/messaging`) for ESM projects
// specifically because it doesn't have this problem — each piece is a
// real named export instead of a property hanging off a CJS default
// object. Switched everything below to that API.
//
// ── ONE-TIME SETUP ──────────────────────────────────────────────────────
// 1. npm install firebase-admin
// 2. Firebase Console → your project → gear icon → Project Settings →
//    Service Accounts tab → "Generate new private key". This downloads
//    a JSON file. Do NOT commit this file to git.
// 3. Point the backend at it, either:
//      a) Put the file somewhere on your server/repo (gitignored) and
//         set FIREBASE_SERVICE_ACCOUNT_PATH=/absolute/path/to/file.json
//         in your .env, OR
//      b) On hosts where you can only set env vars (Render, Railway,
//         etc.), paste the whole JSON file's contents as one line into
//         FIREBASE_SERVICE_ACCOUNT_JSON in your .env instead.
//    Only one of the two is needed.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import fs from "fs";

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  serviceAccount = JSON.parse(
    fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8")
  );
} else {
  console.warn(
    "[firebaseAdmin] Neither FIREBASE_SERVICE_ACCOUNT_JSON nor FIREBASE_SERVICE_ACCOUNT_PATH is set. " +
      "Push notifications to closed/killed apps will be silently skipped until this is configured."
  );
}

let firebaseApp;
if (serviceAccount) {
  // getApps() (not admin.apps) is the modular-API way to check "has
  // this already been initialized" — guards against double-init if
  // this file is ever imported more than once (e.g. by a test runner).
  firebaseApp = getApps().length ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
}

export const isFirebaseAdminReady = !!serviceAccount;
export default firebaseApp;