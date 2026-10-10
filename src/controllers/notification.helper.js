import User from "../models/user/user.model.js";
import Notification from "../models/notifications/notification.model.js";
import NotificationSettings from "../models/notificationsettings/notification.settings.js";
import { getIO, onlineUsers } from "../config/sockets.js";
import { sendPushToUser } from "../utils/pushNotification.js";

// ─────────────────────────────────────────────────────────────────────────
// Category-level toggle map (existing behavior — unchanged)
// ─────────────────────────────────────────────────────────────────────────
const TYPE_TO_SETTING_KEY = {
  message: "message",
  story_view: "story",
  story_like: "story",
  collab_request: "post",
  story_live: "story",
  memory_like: "post",
  memory_comment: "post",
  memory_reply: "post",
  memory_like_comment: "post",
  memory_like_reply: "post",
};

const POSTTYPE_TO_SETTING_KEY = {
  image: "post",
  carousel: "post",
  video: "reel",
  text: "text",
};

const POST_DEPENDENT_TYPES = new Set(["comment", "reply", "like_post", "like_comment", "like_reply", "new_post"]);

const isAllowedBySettings = async (recipientId, type, postType) => {
  let settingKey = TYPE_TO_SETTING_KEY[type];

  if (!settingKey && POST_DEPENDENT_TYPES.has(type)) {
    settingKey = POSTTYPE_TO_SETTING_KEY[postType] || "post";
  }

  if (!settingKey) return true;

  const settings = await NotificationSettings.findOne({ user: recipientId }).lean();
  if (!settings) return true;

  return settings[settingKey] !== false;
};

// ─────────────────────────────────────────────────────────────────────────
// NEW — per-sender mute gate (Instagram-style "mute this person's
// stories/posts/messages" while still following them). Independent of
// the category settings above: settings are global per-category, mute
// is scoped to one specific sender.
// ─────────────────────────────────────────────────────────────────────────
const MUTE_STORY_TYPES = new Set(["story_view", "story_like", "story_live", "story_mention"]);
const MUTE_MESSAGE_TYPES = new Set(["message"]);
// Types that should never be affected by mute (mute is not a follow/social
// gate, only content/notification volume)
const MUTE_EXEMPT_TYPES = new Set(["follow", "follow_request", "follow_accepted"]);

const isAllowedByMute = async (recipientId, senderId, type) => {
  if (!senderId) return true;
  if (recipientId.toString() === senderId.toString()) return true;
  if (MUTE_EXEMPT_TYPES.has(type)) return true;

  const recipient = await User.findById(recipientId).select("mutedUsers");
  const entry = recipient?.mutedUsers?.find((m) => m.user.toString() === senderId.toString());
  if (!entry) return true;

  if (MUTE_STORY_TYPES.has(type)) return !entry.muteStory;
  if (MUTE_MESSAGE_TYPES.has(type)) return !entry.muteMessage;
  // everything else (new_post, comment, reply, like_post, like_comment,
  // collab_request, memory_*) is treated as "post" activity for mute purposes
  return !entry.mutePost;
};

export const createNotification = async ({
  recipientId,
  senderId,
  type,
  message,
  postId = null,
  postType = null,
  commentId = null,
  replyId = null,
  storyId = null,
  chatId = null,
  memoryGroupId = null,
  memoryItemId = null,
  authorId = null,
  link = null,
}) => {
  try {
    if (!recipientId || !senderId) {
      return null;
    }
    if (recipientId.toString() === senderId.toString()) {
      return null;
    }

    // Gate 1: recipient's global category settings (reel/text/post/story/message)
    const allowedBySettings = await isAllowedBySettings(recipientId, type, postType);
    if (!allowedBySettings) {
      return null;
    }

    // Gate 2: recipient's per-sender mute (this specific person, muted for
    // stories/posts/messages specifically, while still followed)
    const allowedByMute = await isAllowedByMute(recipientId, senderId, type);
    if (!allowedByMute) {
      return null;
    }

    const notification = await Notification.create({
      recipient: recipientId,
      sender: senderId,
      type,
      message,
      post: postId,
      postType,
      comment: commentId,
      reply: replyId,
      story: storyId,
      chatId,
      memoryGroup: memoryGroupId,
      memoryItem: memoryItemId,
      author: authorId,
      link,
    });

    await notification.populate("sender", "username profilePic");
    await notification.populate("post", "media postType text"); 
    const io = getIO();
    const recipientSocketId = onlineUsers.get(recipientId.toString());
    if (recipientSocketId) {
      io.to(recipientSocketId).emit("receiveNotification", notification);
    } else {
      // ── FIX — this used to just do nothing here when the recipient
      // wasn't connected, meaning likes/comments/follows/messages sent
      // to someone with the app closed vanished into the DB with no
      // way for them to find out until they happened to reopen the
      // app. This is the single choke point almost every notification
      // type already flows through (message_controller.js's
      // createMessage() calls this too), so one fallback here covers
      // most of the app. A real socket connection is preferred when
      // available since it's instant and free; FCM push is the
      // fallback for offline/backgrounded-too-long/killed.
      await sendPushToUser(recipientId, {
        title: "Socialio",
        body: message || "You have a new notification",
        data: { type, notificationId: notification._id.toString() },
      });
    }

    return notification;
  } catch (error) {
    console.error("createNotification ERROR:", error.message);
    return null;
  }
};