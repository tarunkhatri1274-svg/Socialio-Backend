// src/utils/pushNotification.js
//
// Sends one real FCM push notification to a specific user's registered
// device. This is what actually shows up when their app is fully
// closed/killed — a socket.io emit can't reach them at that point, only
// this can.
//
// Fire-and-forget by design: never throws, so callers (message/group/
// notification flows) can call this alongside their existing socket
// logic without extra try/catch. A missing Firebase config, a user with
// no saved token, or a stale/invalid token all just no-op quietly (with
// a console.log) rather than breaking the actual send/like/comment flow
// they're attached to.
//
// FIX — switched from `admin.messaging().send(...)` to the modular
// `getMessaging(firebaseApp).send(...)`, matching the same ESM-interop
// fix applied in firebaseAdmin.js (see the comment there for why).
//
// ASSUMPTION — adjust if wrong: this reads the token from a `fcmToken`
// field on the User model, matching the body your client already PUTs
// to /auth/device-token (see sendTokenToServer() in the app's
// PushNotifications.js: `body: JSON.stringify({ fcmToken, platform })`).
// If your userroutes.js controller saves that under a different field
// name, change the `.select("fcmToken")` and `user?.fcmToken` lines
// below to match.

import { getMessaging } from "firebase-admin/messaging";
import firebaseApp, { isFirebaseAdminReady } from "../config/firebaseAdmin.js";
import User from "../models/user/user.model.js";

export async function sendPushToUser(userId, { title, body, data = {} } = {}) {
  if (!isFirebaseAdminReady || !userId) return;

  try {
    const user = await User.findById(userId).select("fcmToken");
    if (!user?.fcmToken) return;

    await getMessaging(firebaseApp).send({
      token: user.fcmToken,
      // A `notification` payload (as opposed to data-only) is what lets
      // Android display this automatically even with the app fully
      // killed, with zero JS involvement on the client.
      notification: { title, body },
      // FCM data payloads must be string-only values.
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: "high",
        notification: {
          // Must match CHANNEL_ID in the app's PushNotifications.js so
          // it uses the same (already-fixed) sound/importance/icon
          // settings instead of Android's generic default channel.
          channelId: "socialio-default-v2",
          sound: "default",
        },
      },
    });
  } catch (err) {
    // Common cause: token is stale (user uninstalled, or FCM rotated it
    // and the new one hasn't synced yet). Log and move on.
    console.log("sendPushToUser failed:", err.message);
  }
}