import cron from "node-cron";
import Message from "../models/messages/message.model.js";
import Group from "../models/messages/group.model.js";
import cloudinary from "../config/cloudinary.js";
import { getIO, onlineUsers } from "../config/sockets.js";

const MEDIA_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const TOMBSTONE_RETENTION_MS = 1 * 24 * 60 * 60 * 1000;
const EPHEMERAL_RETENTION_MS = 10 * 60 * 1000; // 10 minutes

// ── Mention messages ("X mentioned you in their story") purge 3 days
// after send, independent of tombstones/ephemeral call-status messages.
// Kept in sync with MENTION_MESSAGE_RETENTION_MS in story.controllers.js
// (that's what stamps mentionExpiresAt at creation).
const MENTION_MESSAGE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

const BATCH_SIZE = 200;

const groupMemberCache = new Map();

async function getGroupMemberIds(chatId) {
  if (groupMemberCache.has(chatId)) return groupMemberCache.get(chatId);
  const group = await Group.findOne({ chatId }).select("members");
  const ids = group
    ? group.members.filter((m) => m.status === "accepted").map((m) => m.user.toString())
    : [];
  groupMemberCache.set(chatId, ids);
  return ids;
}

export async function destroyCloudinaryAsset(media) {
  if (!media?.url) return;

  const urlParts = media.url.split("/");
  const uploadIndex = urlParts.indexOf("upload");
  if (uploadIndex === -1) return;

  const publicIdWithExtension = urlParts.slice(uploadIndex + 2).join("/");
  const publicId = publicIdWithExtension.replace(/\.[^/.]+$/, "");

  const mediaType = media.mediaType;
  const resourceType =
    mediaType === "image" ? "image" :
    mediaType === "video" ? "video" :
    mediaType === "audio" ? "video" :
    "raw";

  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}

export async function destroyCloudinaryAssetById(publicId, resourceType = "image") {
  if (!publicId) return { skipped: true };
  try {
    return await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error(`[expireMedia] Cloudinary destroy failed for ${publicId}:`, err.message);
    return { error: err.message };
  }
}

export function extractCloudinaryMeta(file) {
  if (!file) return null;
  const resourceType = file.mimetype?.startsWith("video")
    ? "video"
    : file.mimetype?.startsWith("image")
    ? "image"
    : "raw";

  return {
    url: file.path,
    publicId: file.filename || file.public_id || "",
    resourceType,
    bytes: file.size || 0,
  };
}

function safeNotify(userId, event, payload) {
  if (!userId) return;
  try {
    const socketId = onlineUsers.get(userId);
    if (!socketId) return;
    getIO().to(socketId).emit(event, payload);
  } catch (err) {
    console.warn("[expireMedia] socket notify skipped:", err.message);
  }
}

async function notifyForMessage(msg, event, extraPayload = {}) {
  const payload = { messageId: msg._id.toString(), chatId: msg.chatId, ...extraPayload };
  if (msg.group) {
    const memberIds = await getGroupMemberIds(msg.chatId);
    memberIds.forEach((id) => safeNotify(id, event, payload));
  } else {
    safeNotify(msg.to?.toString(), event, payload);
    safeNotify(msg.user?.toString(), event, payload);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// JOB 1 — Media expiry (3 days)
// ─────────────────────────────────────────────────────────────────────────
export async function expireOldMedia() {
  const cutoff = new Date(Date.now() - MEDIA_RETENTION_MS);
  groupMemberCache.clear();

  let totalProcessed = 0;
  let totalFailed = 0;

  while (true) {
    const expiredMessages = await Message.find({
      mediaExpired: false,
      deletedForEveryone: { $ne: true },
      "media.url": { $exists: true, $ne: null },
      $or: [
        { mediaExpiresAt: { $lte: new Date() } },
        { mediaExpiresAt: null, createdAt: { $lte: cutoff } },
      ],
    }).limit(BATCH_SIZE);

    if (expiredMessages.length === 0) break;

    console.log(`[expireMedia] Expiring ${expiredMessages.length} media message(s)...`);

    for (const msg of expiredMessages) {
      try {
        await destroyCloudinaryAsset(msg.media);

        msg.media = undefined;
        msg.mediaExpired = true;
        msg.mediaExpiresAt = null;
        await msg.save();

        await notifyForMessage(msg, msg.group ? "groupMediaExpired" : "mediaExpired");

        totalProcessed++;
      } catch (err) {
        totalFailed++;
        console.error(`[expireMedia] Failed to expire message ${msg._id}:`, err.message);
      }
    }

    if (expiredMessages.length < BATCH_SIZE) break;
  }

  console.log(
    `[expireMedia] Done. Processed ${totalProcessed} message(s)` +
      (totalFailed > 0 ? `, ${totalFailed} failed and will retry next run.` : ".")
  );

  return { processed: totalProcessed, failed: totalFailed };
}

// ─────────────────────────────────────────────────────────────────────────
// JOB 2 — Tombstone + ephemeral purge
// ─────────────────────────────────────────────────────────────────────────
export async function purgeOldTombstones() {
  let totalDeleted = 0;
  groupMemberCache.clear();

  while (true) {
    const tombstoneCutoff = new Date(Date.now() - TOMBSTONE_RETENTION_MS);
    const ephemeralCutoff = new Date(Date.now() - EPHEMERAL_RETENTION_MS);

    const toPurge = await Message.find({
      $or: [
        { deletedForEveryone: true, updatedAt: { $lte: tombstoneCutoff } },
        { isEphemeral: true, isSystem: true, createdAt: { $lte: ephemeralCutoff } },
      ],
    })
      .select("_id chatId user to group")
      .limit(BATCH_SIZE);

    if (toPurge.length === 0) break;

    console.log(`[expireMedia] Purging ${toPurge.length} tombstone/ephemeral message(s)...`);

    const ids = toPurge.map((m) => m._id);
    const result = await Message.deleteMany({ _id: { $in: ids } });
    totalDeleted += result.deletedCount || 0;

    for (const msg of toPurge) {
      await notifyForMessage(msg, msg.group ? "groupMessagePurged" : "messagePurged");
    }

    if (toPurge.length < BATCH_SIZE) break;
  }

  console.log(`[expireMedia] Tombstone/ephemeral purge done. Removed ${totalDeleted} message(s).`);
  return { deleted: totalDeleted };
}

// ─────────────────────────────────────────────────────────────────────────
// JOB 3 — Mention message purge (3 days)
// ─────────────────────────────────────────────────────────────────────────
export async function purgeOldMentionMessages() {
  let totalDeleted = 0;
  groupMemberCache.clear();

  while (true) {
    const cutoff = new Date(Date.now() - MENTION_MESSAGE_RETENTION_MS);

    const toPurge = await Message.find({
      isMentionMessage: true,
      $or: [
        { mentionExpiresAt: { $lte: new Date() } },
        { mentionExpiresAt: null, createdAt: { $lte: cutoff } },
      ],
    })
      .select("_id chatId user to group")
      .limit(BATCH_SIZE);

    if (toPurge.length === 0) break;

    console.log(`[expireMedia] Purging ${toPurge.length} mention message(s)...`);

    const ids = toPurge.map((m) => m._id);
    const result = await Message.deleteMany({ _id: { $in: ids } });
    totalDeleted += result.deletedCount || 0;

    for (const msg of toPurge) {
      await notifyForMessage(msg, "messagePurged");
    }

    if (toPurge.length < BATCH_SIZE) break;
  }

  console.log(`[expireMedia] Mention message purge done. Removed ${totalDeleted} message(s).`);
  return { deleted: totalDeleted };
}

let scheduledTask = null;

export function startMediaExpiryJob() {
  if (scheduledTask) {
    console.warn("[expireMedia] Job already scheduled — skipping duplicate start.");
    return scheduledTask;
  }

  scheduledTask = cron.schedule("*/10 * * * *", async () => {
    console.log("[expireMedia] Running scheduled cleanup job...");
    try {
      await expireOldMedia();
    } catch (err) {
      console.error("[expireMedia] Media expiry failed:", err.message);
    }
    try {
      await purgeOldTombstones();
    } catch (err) {
      console.error("[expireMedia] Tombstone/ephemeral purge failed:", err.message);
    }
    try {
      await purgeOldMentionMessages();
    } catch (err) {
      console.error("[expireMedia] Mention purge failed:", err.message);
    }
  });

  console.log("[expireMedia] Scheduled cleanup job — runs every 10 min (media: 3d, tombstones: 1d, ephemeral: 10m, mentions: 3d). Covers 1:1 + group chats.");
  return scheduledTask;
}

export function stopMediaExpiryJob() {
  if (!scheduledTask) return;
  scheduledTask.stop();
  scheduledTask = null;
  console.log("[expireMedia] Job stopped.");
}