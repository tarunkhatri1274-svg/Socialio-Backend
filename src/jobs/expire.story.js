import Story from "../models/story/story.model.js";
import { destroyCloudinaryAssetById } from "./expire.media.js";
import { getIO } from "../config/sockets.js";

const CHECK_INTERVAL_MS = 30 * 1000;

const safeBroadcast = (event, payload) => {
  try {
    getIO().emit(event, payload);
  } catch {
    // socket layer may not be ready on the very first boot tick
  }
};

const cleanupExpiredStories = async () => {
  try {
    const expired = await Story.find({
      storyType: { $ne: "live" },
      expiresAt: { $lte: new Date() },
    }).select("media author repostOf");

    if (expired.length === 0) return;

    let cleaned = 0;
    let skipped = 0;

    for (const story of expired) {
      try {
        // ── Reposted stories share the original's Cloudinary asset and
        // never own its lifecycle — only destroy when this story IS the
        // original (repostOf is null).
        if (story.media?.publicId && !story.repostOf) {
          const result = await destroyCloudinaryAssetById(story.media.publicId, story.media.resourceType);
          if (result?.error) {
            skipped++;
            continue;
          }
        }

        await Story.findByIdAndDelete(story._id);

        safeBroadcast("storyDeleted", {
          storyId: story._id.toString(),
          authorId: story.author?.toString(),
          reason: "expired",
        });

        cleaned++;
      } catch (err) {
        skipped++;
        console.error(`[story-expiry] failed to expire story ${story._id}:`, err.message);
      }
    }

    if (cleaned > 0 || skipped > 0) {
      console.log(
        `[story-expiry] cleaned up ${cleaned} expired stor${cleaned === 1 ? "y" : "ies"}` +
          (skipped > 0 ? `, ${skipped} left for retry next tick.` : ".")
      );
    }
  } catch (err) {
    console.error("[story-expiry] cleanup error:", err.message);
  }
};

let intervalHandle = null;

export const startStoryExpiryJob = () => {
  if (intervalHandle) {
    console.warn("[story-expiry] job already running — skipping duplicate start.");
    return;
  }
  cleanupExpiredStories();
  intervalHandle = setInterval(cleanupExpiredStories, CHECK_INTERVAL_MS);
  console.log("[story-expiry] job started, checking every 30 seconds");
};

export const stopStoryExpiryJob = () => {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
  console.log("[story-expiry] job stopped");
};