import Story from "../models/story/story.model.js";
import User from "../models/user/user.model.js";
import Message from "../models/messages/message.model.js";
import Conversation from "../models/messages/conversation.model.js";
import { createNotification } from "./notification.helper.js";
import { getIO, onlineUsers } from "../config/sockets.js";
import { destroyCloudinaryAssetById, extractCloudinaryMeta } from "../jobs/expire.media.js";
import { isBlockedEitherWay } from "../utils/blockCheck.js";
import mongoose from "mongoose";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_BYTES = 20 * 1024 * 1024; // 20MB
const MENTION_MESSAGE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // kept in sync with jobs/expire.media.js

// ── VISIBILITY RULE ────────────────────────────────────────────────────
const canViewStory = async (story, viewerId) => {
  const authorId = story.author.toString();
  if (authorId === viewerId.toString()) return true;

  const blocked = await isBlockedEitherWay(authorId, viewerId);
  if (blocked) return false;

  if (!story.isHiddenFromNonFollowers) return true;

  const owner = await User.findById(authorId).select("followers");
  if (!owner) return false;
  return owner.followers.some((id) => id.toString() === viewerId.toString());
};

const canViewPopulatedStory = (story, viewerId, myBlockedIds, blockedByIds) => {
  const authorId = (story.author?._id || story.author).toString();
  if (authorId === viewerId.toString()) return true;

  if (myBlockedIds.has(authorId) || blockedByIds.has(authorId)) return false;

  if (!story.isHiddenFromNonFollowers) return true;
  const followers = story.author?.followers || [];
  return followers.some((id) => id.toString() === viewerId.toString());
};

const stripFollowers = (story) => {
  const obj = story.toObject ? story.toObject() : story;
  if (obj.author && typeof obj.author === "object") {
    const { followers, ...rest } = obj.author;
    obj.author = rest;
  }
  return obj;
};

// ─────────────────────────────────────────────────────────────────────────
// Mention-message plumbing — mirrors shouldBeRequest / getOrCreateConversation
// in message.controller.js so a mention from a stranger to a private
// account still lands in Requests instead of skipping the follow-gate.
// ─────────────────────────────────────────────────────────────────────────
const buildChatId = (a, b) => [a.toString(), b.toString()].sort().join("_");

const shouldBeRequestForMention = (recipient, senderId) => {
  if (!recipient) return false;
  if (!recipient.isPrivate) return false;
  const followsSender = (recipient.following || []).some((id) => id.toString() === senderId.toString());
  return !followsSender;
};

const getOrCreateConversationForMention = async ({ chatId, senderId, recipientId }) => {
  let convo = await Conversation.findOne({ chatId });
  const recipient = await User.findById(recipientId).select("isPrivate following");
  const isRequest = shouldBeRequestForMention(recipient, senderId);

  if (!convo) {
    convo = await Conversation.create({
      chatId,
      members: [senderId, recipientId],
      initiator: senderId,
      recipient: recipientId,
      status: isRequest ? "pending" : "none",
    });
  }
  return convo;
};

// Sends "X mentioned you in their story" as a real chat message (story
// preview + "Add to Your Story" affordance on the frontend), flagged so
// the cleanup job purges it 3 days later regardless of the story's own
// 24h expiry.
const notifyStoryMentions = async (story, author, mentionUserIds) => {
  if (!mentionUserIds?.length) return;
  const io = (() => { try { return getIO(); } catch { return null; } })();

  for (const rawId of mentionUserIds) {
    if (!mongoose.Types.ObjectId.isValid(rawId)) continue;
    const mentionedId = rawId.toString();
    if (mentionedId === author._id.toString()) continue; // can't mention yourself

    try {
      const chatId = buildChatId(author._id, mentionedId);
      const convo = await getOrCreateConversationForMention({
        chatId,
        senderId: author._id,
        recipientId: mentionedId,
      });

      const mentionMsg = await Message.create({
        chatId,
        user: author._id,
        to: mentionedId,
        text: "mentioned you in their story",
        sharedPost: {
          kind: "story",
          storyId: story._id,
          authorId: author._id,
          authorUsername: author.username,
          authorProfilePic: author.profilePic,
          mediaUrl: story.media?.url || null,
          mediaType: story.media?.type || null,
        },
        isMentionMessage: true,
        mentionExpiresAt: new Date(Date.now() + MENTION_MESSAGE_RETENTION_MS),
        isMessageRequest: convo.status === "pending",
        requestStatus: convo.status,
      });
      await mentionMsg.populate("user", "username profilePic");

      convo.lastMessageAt = new Date();
      convo.lastMessageText = "mentioned you in a story";
      const current = convo.unreadCounts.get(mentionedId) || 0;
      convo.unreadCounts.set(mentionedId, current + 1);
      convo.clearedFor = [];
      await convo.save();

      if (io) {
        const recipientSocketId = onlineUsers.get(mentionedId);
        if (recipientSocketId) {
          const eventName = convo.status === "pending" ? "newMessageRequest" : "receiveMessage";
          io.to(recipientSocketId).emit(eventName, {
            from: author._id,
            conversationId: chatId,
            message: mentionMsg,
            createdAt: mentionMsg.createdAt,
            isRequest: convo.status === "pending",
          });

          const [unreadCount] = [convo.unreadCounts.get(mentionedId) || 0];
          io.to(recipientSocketId).emit("inboxCounts", { unreadCount });
        }
      }

      await createNotification({
        recipientId: mentionedId,
        senderId: author._id,
        type: "story_mention",
        message: `${author.username} mentioned you in their story`,
        storyId: story._id,
        link: `/stories/${author._id}`,
      });
    } catch (err) {
      // one bad mention must not fail the whole story upload
      console.error(`[story-mention] failed for user ${mentionedId}:`, err.message);
    }
  }
};

// ================= ADD STORY =================
export const addStory = async (req, res) => {
  try {
    const mediaUrl = req.file?.path;
    const storyType = req.body.storyType; // "image" or "video"

    if (!mediaUrl || !storyType) {
      return res.status(400).json({ success: false, message: "File and type are required" });
    }

    const meta = extractCloudinaryMeta(req.file);

    const limit = storyType === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (meta.bytes > limit) {
      await destroyCloudinaryAssetById(meta.publicId, meta.resourceType);
      return res.status(400).json({
        success: false,
        message:
          storyType === "video"
            ? "Video must be under 20MB"
            : "Image must be under 10MB",
      });
    }

    // ── Text overlays / mentions / filter label arrive as JSON strings
    // inside the multipart FormData (files + native JSON body don't mix).
    let textOverlays = [];
    let rawMentions = [];
    try { textOverlays = req.body.textOverlays ? JSON.parse(req.body.textOverlays) : []; }
    catch { textOverlays = []; }
    try { rawMentions = req.body.mentions ? JSON.parse(req.body.mentions) : []; }
    catch { rawMentions = []; }

    const filterApplied = req.body.filter || "none";

    // ── FIXED: look up each mentioned user ONCE so username/profilePic
    // get baked into the story doc itself. Previously only `user`/`x`/`y`
    // were stored, so the viewer had no name to render — mentions showed
    // up as empty/broken chips (or got silently dropped by JSX guards).
    const rawMentionEntries = (Array.isArray(rawMentions) ? rawMentions : [])
      .filter((m) => m?.user && mongoose.Types.ObjectId.isValid(m.user));

    const mentionUsers = rawMentionEntries.length
      ? await User.find({ _id: { $in: rawMentionEntries.map((m) => m.user) } }).select("username profilePic")
      : [];
    const mentionUserMap = new Map(mentionUsers.map((u) => [u._id.toString(), u]));

    const mentions = rawMentionEntries
      .filter((m) => mentionUserMap.has(m.user.toString())) // drop mentions of users that don't exist
      .map((m) => {
        const u = mentionUserMap.get(m.user.toString());
        return {
          user: m.user,
          username: u.username,
          profilePic: u.profilePic || "",
          x: typeof m.x === "number" ? m.x : 50,
          y: typeof m.y === "number" ? m.y : 50,
        };
      });

    const cleanTextOverlays = (Array.isArray(textOverlays) ? textOverlays : [])
      .filter((t) => t?.text?.trim())
      .map((t) => ({
        text: String(t.text).slice(0, 200),
        x: typeof t.x === "number" ? t.x : 50,
        y: typeof t.y === "number" ? t.y : 50,
        color: t.color || "#ffffff",
        fontSize: t.fontSize || 24,
        fontFamily: t.fontFamily || "Arial",
        align: ["left", "center", "right"].includes(t.align) ? t.align : "center",
      }));

    const story = await Story.create({
      author: req.user._id,
      storyType,
      media: {
        url: mediaUrl,
        type: storyType,
        publicId: meta.publicId,
        resourceType: meta.resourceType,
        bytes: meta.bytes,
      },
      filterApplied,
      textOverlays: cleanTextOverlays,
      mentions,
    });

    const author = await User.findById(req.user._id).select("username profilePic followers");
    const followerIds = (author?.followers || []).map((id) => id.toString());

    try {
      const io = getIO();
      io.emit("storyAdded", {
        authorId: req.user._id.toString(),
        storyId: story._id.toString(),
      });
    } catch (e) {
      console.log("Socket emit error:", e.message);
    }

    if (followerIds.length > 0 && followerIds.length <= 5000) {
      await Promise.all(
        followerIds.map((followerId) =>
          createNotification({
            recipientId: followerId,
            senderId: req.user._id,
            type: "story_view",
            message: `${author.username} added a new story`,
            storyId: story._id,
            link: `/stories/${req.user._id}`,
          })
        )
      );
    }

    // ── Fire mention messages. Awaited so failures log, but one bad
    // mention never fails the whole story upload (see try/catch inside
    // notifyStoryMentions). Still passes only the user IDs — unaffected
    // by the mentions shape change above.
    if (mentions.length > 0) {
      await notifyStoryMentions(story, author, mentions.map((m) => m.user));
    }

    res.status(201).json({ success: true, message: "Story added successfully", story });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= START LIVE STORY (no size limit) — UNCHANGED =========
export const startLiveStory = async (req, res) => {
  try {
    const roomId = `live_${req.user._id}`;
    const story = await Story.create({
      author: req.user._id,
      storyType: "live",
      isLive: true,
      liveRoomId: roomId,
    });

    try {
      getIO().emit("someoneLive", {
        authorId: req.user._id.toString(),
        storyId: story._id.toString(),
        roomId,
      });
    } catch (e) {
      console.log("Socket emit error:", e.message);
    }

    const author = await User.findById(req.user._id).select("username followers");
    const followerIds = (author?.followers || []).map((id) => id.toString());

    if (followerIds.length > 0 && followerIds.length <= 5000) {
      await Promise.all(
        followerIds.map((followerId) =>
          createNotification({
            recipientId: followerId,
            senderId: req.user._id,
            type: "story_live",
            message: `${author.username} started a live story`,
            storyId: story._id,
            link: `/stories/${req.user._id}`,
          })
        )
      );
    }

    res.status(201).json({ success: true, story });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= END LIVE STORY — UNCHANGED =============================
export const endLiveStory = async (req, res) => {
  try {
    const { storyId } = req.params;
    const story = await Story.findById(storyId);
    if (!story) return res.status(404).json({ success: false, message: "Story not found" });

    if (story.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    if (story.media?.publicId) {
      await destroyCloudinaryAssetById(story.media.publicId, story.media.resourceType);
    }

    await Story.findByIdAndDelete(storyId);

    try {
      getIO().emit("liveStoryEnded", { storyId, authorId: req.user._id.toString() });
      getIO().to(`story:${storyId}`).emit("liveEnded", { roomId: story.liveRoomId });
    } catch (e) {
      console.log("Socket emit error:", e.message);
    }

    res.status(200).json({ success: true, message: "Live story ended and cleaned up" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= GET ALL STORIES =============================
export const getAllStories = async (req, res) => {
  try {
    const myId = req.user._id.toString();

    // ← NEW: Explore.jsx passes ?includeMuted=true — this endpoint is
    // reused there too and must NOT hide muted-story authors.
    const skipMuteFilter = req.query.includeMuted === "true";

    const [stories, me, blockedByOthers] = await Promise.all([
      Story.find({}).populate("author", "username profilePic followers").sort({ createdAt: -1 }),
      User.findById(req.user._id).select("blockedUsers mutedUsers"),
      User.find({ blockedUsers: req.user._id }).select("_id"),
    ]);

    const myBlockedIds = new Set((me?.blockedUsers || []).map((id) => id.toString()));
    const blockedByIds = new Set(blockedByOthers.map((u) => u._id.toString()));
    const mutedStoryAuthorIds = skipMuteFilter
      ? new Set()
      : new Set((me?.mutedUsers || []).filter((m) => m.muteStory).map((m) => m.user.toString()));

    const visible = stories
      .filter((s) => canViewPopulatedStory(s, req.user._id, myBlockedIds, blockedByIds))
      .filter((s) => {
        const authorId = (s.author?._id || s.author).toString();
        return authorId === myId || !mutedStoryAuthorIds.has(authorId);
      })
      .map((s) => {
        const obj = stripFollowers(s);
        obj.viewedByMe = (s.views || []).some((v) => v.user?.toString() === myId);
        return obj;
      });

    res.status(200).json({ success: true, stories: visible });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= GET USER STORIES ============================
export const getUserStories = async (req, res) => {
  try {
    const { userId } = req.params;
    const myId = req.user._id.toString();

    const [stories, me, blockedByOthers] = await Promise.all([
      Story.find({ author: userId }).populate("author", "username profilePic followers").sort({ createdAt: -1 }),
      User.findById(req.user._id).select("blockedUsers mutedUsers"),
      User.find({ blockedUsers: req.user._id }).select("_id"),
    ]);

    const myBlockedIds = new Set((me?.blockedUsers || []).map((id) => id.toString()));
    const blockedByIds = new Set(blockedByOthers.map((u) => u._id.toString()));
    const mutedStoryAuthorIds = new Set(
      (me?.mutedUsers || []).filter((m) => m.muteStory).map((m) => m.user.toString())
    );

    // Step 1 — access gate only (follow/block). 403 can ONLY come from here.
    const accessible = stories.filter((s) =>
      canViewPopulatedStory(s, req.user._id, myBlockedIds, blockedByIds)
    );

    if (stories.length > 0 && accessible.length === 0) {
      return res.status(403).json({ success: false, message: "You must follow this user to view their story" });
    }

    // Step 2 — mute is a display preference, never an access error.
    const visible = accessible
      .filter((s) => {
        const authorId = (s.author?._id || s.author).toString();
        return authorId === myId || !mutedStoryAuthorIds.has(authorId);
      })
      .map((s) => {
        const obj = stripFollowers(s);
        obj.viewedByMe = (s.views || []).some((v) => v.user?.toString() === myId);
        return obj;
      });

    res.status(200).json({ success: true, stories: visible });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= VIEW STORY — UNCHANGED ==================================
export const viewStory = async (req, res) => {
  try {
    const { storyId } = req.params;
    const story = await Story.findById(storyId).select("author views viewsCount isHiddenFromNonFollowers");
    if (!story) return res.status(404).json({ success: false, message: "Story not found" });

    const allowed = await canViewStory(story, req.user._id);
    if (!allowed) {
      return res.status(403).json({ success: false, message: "You must follow this user to view their story" });
    }

    const userIdStr = req.user._id.toString();
    const alreadyViewed = story.views.some((v) => v.user.toString() === userIdStr);

    if (!alreadyViewed) {
      const updated = await Story.findOneAndUpdate(
        { _id: storyId, "views.user": { $ne: req.user._id } },
        {
          $push: { views: { user: req.user._id, viewedAt: new Date() } },
          $inc: { viewsCount: 1 },
        },
        { new: true, select: "viewsCount" }
      );

      if (updated) {
        try {
          getIO().to(`story:${storyId}`).emit(`story:${storyId}:views`, {
            viewsCount: updated.viewsCount,
          });
        } catch (e) {
          console.log("Socket emit error:", e.message);
        }
        return res.status(200).json({ success: true, message: "Story viewed", viewsCount: updated.viewsCount });
      }
    }

    return res.status(200).json({ success: true, message: "Story already viewed", viewsCount: story.viewsCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= LIKE / UNLIKE STORY — UNCHANGED =========================
export const likeStory = async (req, res) => {
  try {
    const { storyId } = req.params;
    const story = await Story.findById(storyId);
    if (!story) return res.status(404).json({ success: false, message: "Story not found" });

    const allowed = await canViewStory(story, req.user._id);
    if (!allowed) {
      return res.status(403).json({ success: false, message: "You must follow this user to like their story" });
    }

    const alreadyLiked = story.likes.includes(req.user._id);

    if (alreadyLiked) {
      story.likes = story.likes.filter((id) => id.toString() !== req.user._id.toString());
      story.likesCount -= 1;
    } else {
      story.likes.push(req.user._id);
      story.likesCount += 1;
    }

    await story.save();

    try {
      getIO().to(`story:${storyId}`).emit(`story:${storyId}:likes`, {
        likesCount: story.likesCount,
        liked: !alreadyLiked,
      });
    } catch (e) {
      console.log("Socket emit error:", e.message);
    }

    if (!alreadyLiked && story.author.toString() !== req.user._id.toString()) {
      const liker = await User.findById(req.user._id).select("username");
      await createNotification({
        recipientId: story.author,
        senderId: req.user._id,
        type: "story_like",
        message: `${liker?.username || "Someone"} liked your story`,
        storyId: story._id,
        // ← NEW — senderId here is the LIKER, not the story owner (unlike
        // story_view/story_live where senderId genuinely is the owner).
        // authorId lets the frontend fetch the right person's stories —
        // yours, the one that was actually liked — instead of the liker's.
        authorId: story.author,
        link: `/stories/${story.author}`,
      });
    }

    res.status(200).json({ success: true, likesCount: story.likesCount, likes: story.likes });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= STORY COMMENT — UNCHANGED ================================
export const commentOnStory = async (req, res) => {
  try {
    const { storyId } = req.params;
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, message: "Comment text required" });

    const story = await Story.findById(storyId).select("author comments isHiddenFromNonFollowers");
    if (!story) return res.status(404).json({ success: false, message: "Story not found" });

    const allowed = await canViewStory(story, req.user._id);
    if (!allowed) {
      return res.status(403).json({ success: false, message: "You must follow this user to comment on their story" });
    }

    const comment = { user: req.user._id, text: text.trim(), createdAt: new Date() };
    story.comments.push(comment);
    if (story.comments.length > 200) story.comments = story.comments.slice(-200);
    await story.save();

    const commenter = await User.findById(req.user._id).select("username");

    try {
      getIO().to(`story:${storyId}`).emit(`story:${storyId}:comment`, {
        userId: req.user._id,
        username: commenter?.username,
        text: comment.text,
        createdAt: comment.createdAt,
      });
    } catch (e) {
      console.log("Socket emit error:", e.message);
    }

    res.status(201).json({ success: true, comment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= GET STORY COMMENTS — UNCHANGED ==========================
export const getStoryComments = async (req, res) => {
  try {
    const { storyId } = req.params;
    const story = await Story.findById(storyId)
      .select("author comments isHiddenFromNonFollowers")
      .populate("comments.user", "username");
    if (!story) return res.status(404).json({ success: false, message: "Story not found" });

    const allowed = await canViewStory(story, req.user._id);
    if (!allowed) {
      return res.status(403).json({ success: false, message: "You must follow this user to view these comments" });
    }

    const comments = (story.comments || []).map((c) => ({
      userId: c.user?._id || c.user,
      username: c.user?.username || "Unknown",
      text: c.text,
      createdAt: c.createdAt,
    }));

    res.status(200).json({ success: true, comments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= REACT TO STORY — UNCHANGED ================================
export const reactToStory = async (req, res) => {
  try {
    const { storyId } = req.params;
    const { emoji } = req.body;
    const story = await Story.findById(storyId);
    if (!story) return res.status(404).json({ success: false, message: "Story not found" });

    const allowed = await canViewStory(story, req.user._id);
    if (!allowed) {
      return res.status(403).json({ success: false, message: "You must follow this user to react to their story" });
    }

    story.reactions = story.reactions.filter((reaction) => reaction.user.toString() !== req.user._id.toString());
    story.reactions.push({ user: req.user._id, emoji });
    await story.save();

    res.status(200).json({ success: true, reactions: story.reactions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= DELETE STORY (also wipes Cloudinary asset) =============
export const deleteStory = async (req, res) => {
  try {
    const { storyId } = req.params;
    const story = await Story.findById(storyId);
    if (!story) return res.status(404).json({ success: false, message: "Story not found" });

    if (story.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "You can delete only your own story" });
    }

    // ── A reposted story doesn't own its Cloudinary asset (the original
    // story does) — never destroy it here, or the original owner's
    // still-live story loses its media out from under them.
    if (story.media?.publicId && !story.repostOf) {
      await destroyCloudinaryAssetById(story.media.publicId, story.media.resourceType);
    }

    await Story.findByIdAndDelete(storyId);

    try {
      getIO().emit("storyDeleted", { storyId, authorId: req.user._id.toString() });
    } catch (e) {
      console.log("Socket emit error:", e.message);
    }

    res.status(200).json({ success: true, message: "Story deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= ADD TO YOUR STORY (repost) =============================
// Called from the mention message's "Add to Your Story" button. Reuses
// the ORIGINAL story's Cloudinary asset (no re-upload) — see the
// `repostOf` guard in deleteStory above and jobs/expire.stories.js.
export const repostStoryToMyStory = async (req, res) => {
  try {
    const { storyId } = req.params;
    const original = await Story.findById(storyId);
    if (!original) return res.status(404).json({ success: false, message: "Story not found" });

    if (original.storyType === "live") {
      return res.status(400).json({ success: false, message: "Live stories can't be added to your story" });
    }

    const allowed = await canViewStory(original, req.user._id);
    if (!allowed) {
      return res.status(403).json({ success: false, message: "You can't view this story" });
    }

    // ── Capture WHO the original author was, for the "Story by @username"
    // attribution card — this is what makes the repost identifiable, the
    // same way Instagram shows "user00" on a reshared story.
    const originalAuthor = await User.findById(original.author).select("username profilePic");

    const newStory = await Story.create({
      author: req.user._id,
      storyType: original.storyType,
      text: original.text,
      media: original.media,
      textStyle: original.textStyle,
      filterApplied: original.filterApplied,
      textOverlays: original.textOverlays,
      // ── NOT original.mentions — those belonged to the original
      // author's post and may reference people unrelated to this
      // repost. A repost carries no inherited mentions of its own.
      mentions: [],
      repostOf: original._id,
      repostAttribution: originalAuthor
        ? {
            user: originalAuthor._id,
            username: originalAuthor.username,
            profilePic: originalAuthor.profilePic || "",
          }
        : null,
    });

    try {
      getIO().emit("storyAdded", {
        authorId: req.user._id.toString(),
        storyId: newStory._id.toString(),
      });
    } catch (e) {
      console.log("Socket emit error:", e.message);
    }

    res.status(201).json({ success: true, story: newStory });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= GET STORY VIEWERS (owner only) — UNCHANGED =============
export const getStoryViewers = async (req, res) => {
  try {
    const { storyId } = req.params;
    const story = await Story.findById(storyId).populate("views.user", "username profilePic");
    if (!story) return res.status(404).json({ success: false, message: "Story not found" });

    if (story.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Only the story owner can view this" });
    }

    const viewers = story.views.map((v) => v.user).filter(Boolean);
    const likedBy = await User.find({ _id: { $in: story.likes } }).select("username profilePic");

    res.status(200).json({
      success: true,
      viewers,
      likedBy,
      likesCount: story.likesCount,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= GET STORY LIKE STATE — UNCHANGED ========================
export const getStoryLikeState = async (req, res) => {
  try {
    const { storyId } = req.params;
    const story = await Story.findById(storyId).select("author likes likesCount isHiddenFromNonFollowers");
    if (!story) return res.status(404).json({ success: false, message: "Story not found" });

    const allowed = await canViewStory(story, req.user._id);
    if (!allowed) {
      return res.status(403).json({ success: false, message: "You must follow this user to view their story" });
    }

    const liked = story.likes.some((id) => id.toString() === req.user._id.toString());

    res.status(200).json({ success: true, likesCount: story.likesCount, liked });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= TOGGLE HIDE FROM NON-FOLLOWERS (owner only) — UNCHANGED =
export const HideFromNonFollowers = async (req, res) => {
  try {
    const { storyId } = req.params;
    const story = await Story.findById(storyId);
    if (!story) return res.status(404).json({ success: false, message: "Story not found" });

    if (story.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Only the story owner can hide their story from non-followers" });
    }

    story.isHiddenFromNonFollowers = !story.isHiddenFromNonFollowers;
    await story.save();

    try {
      getIO().emit("storyVisibilityChanged", {
        storyId: story._id.toString(),
        authorId: story.author.toString(),
        isHiddenFromNonFollowers: story.isHiddenFromNonFollowers,
      });
    } catch (e) {
      console.log("Socket emit error:", e.message);
    }

    return res.status(200).json({
      success: true,
      isHiddenFromNonFollowers: story.isHiddenFromNonFollowers,
      storyId: story._id,
      message: "Story visibility updated successfully",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};