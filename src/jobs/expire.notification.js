import cron from "node-cron";
import Notification from "../models/notifications/notification.model.js";
import { getIO, onlineUsers } from "../config/sockets.js";

// ── Retention window ────────────────────────────────────────────────────
// Activity/notification documents are hard-purged 7 days after creation.
//
// Unlike message media (expireMedia.js), a Notification doc does NOT own
// any Cloudinary asset itself — it only references a postId/commentId/
// replyId that belongs to a Post/Message document. Those parent documents
// already manage their own media lifecycle independently:
//   - Post media is destroyed when the post itself is deleted, or when the
//     author's account is deleted (see deleteAccount in user.controllers.js)
//   - Message media is destroyed by expireOldMedia() / deleteMessage()
// So this job only ever deletes the notification row — never touches
// Cloudinary — to avoid double-destroying (or wrongly destroying) an
// asset a different job is still responsible for.
const NOTIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const BATCH_SIZE = 200; // per-iteration batch, drained in a loop below — same reasoning as expireMedia.js

// ── Safe socket emit — same rationale as expireMedia.js's safeNotify:
// getIO() can throw if socket.io hasn't initialized yet, and that must
// never roll back or interrupt a batch of deletes that already succeeded.
function safeNotify(userId, event, payload) {
  if (!userId) return;
  try {
    const socketId = onlineUsers.get(userId);
    if (!socketId) return;
    getIO().to(socketId).emit(event, payload);
  } catch (err) {
    console.warn("[expireNotifications] socket notify skipped:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// JOB — Notification purge (7 days)
// Hard-deletes any notification older than the retention window, for every
// recipient, regardless of read/unread state. Loops in batches until the
// whole backlog past the cutoff is cleared in a single scheduled run.
// ─────────────────────────────────────────────────────────────────────────
export async function purgeOldNotifications() {
  const cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_MS);

  let totalDeleted = 0;

  while (true) {
    const expired = await Notification.find({ createdAt: { $lte: cutoff } })
      .select("_id recipient")
      .limit(BATCH_SIZE);

    if (expired.length === 0) break;

    console.log(`[expireNotifications] Purging ${expired.length} notification(s)...`);

    const ids = expired.map((n) => n._id);
    const result = await Notification.deleteMany({ _id: { $in: ids } });
    totalDeleted += result.deletedCount || 0;

    // Group the deleted ids by recipient so each online user gets one
    // emit per batch instead of one per notification.
    const byRecipient = new Map();
    for (const n of expired) {
      const rid = n.recipient?.toString();
      if (!rid) continue;
      if (!byRecipient.has(rid)) byRecipient.set(rid, []);
      byRecipient.get(rid).push(n._id.toString());
    }

    // Best-effort live notify so an open Activity page can drop the
    // purged card immediately instead of waiting for a refetch to notice.
    for (const [rid, notificationIds] of byRecipient) {
      safeNotify(rid, "notificationsExpired", { notificationIds });
    }

    if (expired.length < BATCH_SIZE) break;
  }

  console.log(`[expireNotifications] Done. Purged ${totalDeleted} notification(s).`);

  return { deleted: totalDeleted };
}

// ── Scheduler — runs every hour, same cadence as the media expiry job so
// activity never sits more than ~1h past the 7-day mark.
let scheduledTask = null;

export function startNotificationExpiryJob() {
  if (scheduledTask) {
    console.warn("[expireNotifications] Job already scheduled — skipping duplicate start.");
    return scheduledTask;
  }

  scheduledTask = cron.schedule("0 * * * *", async () => {
    console.log("[expireNotifications] Running scheduled cleanup job...");
    try {
      await purgeOldNotifications();
    } catch (err) {
      console.error("[expireNotifications] Purge failed:", err.message);
    }
  });

  console.log("[expireNotifications] Scheduled hourly cleanup job (notifications: 7d).");
  return scheduledTask;
}

export function stopNotificationExpiryJob() {
  if (!scheduledTask) return;
  scheduledTask.stop();
  scheduledTask = null;
  console.log("[expireNotifications] Job stopped.");
}