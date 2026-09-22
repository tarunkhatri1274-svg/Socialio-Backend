import MemoryGroup from "../models/memory/memoryGroup.modal.js";
import MemoryItem from "../models/memory/memoryItem.modal.js";
import User from "../models/user/user.model.js";
import cloudinary from "../config/cloudinary.js";
import { getIO } from "../config/sockets.js";
import { createNotification } from "./notification.helper.js";
import { isBlockedEitherWay } from "../utils/blockCheck.js";

const emitToMemoryItem = (itemId, event, data) => {
  try {
    getIO().to(`memoryItem:${itemId}`).emit(event, data);
  } catch (e) {
    console.log("Socket emit error:", e.message);
  }
};

// ── ACCESS RULE — same idea as Story/Post: owner always sees their own;
// a block in either direction always wins; a private account only lets
// followers in; a specific item additionally hidden from non-followers
// tightens that further.
export const canAccessMemoryItem = async (item, viewerId) => {
  if (!item || !viewerId) return false;
  const authorId = item.author?._id?.toString() || item.author?.toString();
  if (authorId === viewerId.toString()) return true;

  const blocked = await isBlockedEitherWay(authorId, viewerId);
  if (blocked) return false;

  const owner = await User.findById(authorId).select("isPrivate followers");
  if (!owner) return false;

  const isFollower = (owner.followers || []).some(
    (id) => (id?._id ?? id).toString() === viewerId.toString()
  );

  if (owner.isPrivate && !isFollower) return false;
  if (item.isHiddenFromNonFollowers && !isFollower) return false;

  return true;
};

const extractPublicId = (url) => {
  if (!url) return null;
  try {
    const parts = url.split("/");
    const uploadIdx = parts.indexOf("upload");
    if (uploadIdx === -1) return null;
    const afterUpload = parts.slice(uploadIdx + 1);
    if (afterUpload[0]?.startsWith("v") && !isNaN(afterUpload[0].slice(1))) {
      afterUpload.shift();
    }
    return afterUpload.join("/").replace(/\.[^/.]+$/, "");
  } catch {
    return null;
  }
};

const destroyMemoryMedia = async (media) => {
  const publicId = extractPublicId(media?.url);
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: media.type === "video" ? "video" : "image",
    });
  } catch (e) {
    console.error("Cloudinary delete failed:", e.message);
  }
};

// Multipart/FormData bodies send booleans as the STRINGS "true"/"false",
// not real booleans — `!!disableComments` would treat "false" (a
// non-empty string) as truthy and silently disable comments on every
// memory regardless of what the checkbox said. This coerces correctly
// for real booleans, "true"/"false" strings, and missing values alike.
const toBool = (v) => v === true || v === "true";

// Builds one MemoryItem doc (unsaved) per uploaded file.
const filesToItemDocs = (files, groupId, authorId, disableComments) =>
  files.map((file) => ({
    group: groupId,
    author: authorId,
    media: {
      url: file.path,
      type: file.mimetype?.startsWith("video/") ? "video" : "image",
    },
    disableComments: toBool(disableComments),
  }));

// ══════════════════════════════════════════════════════════════════════
// ── GROUPS ("Highlights") ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

// ================= CREATE GROUP (+ one or more starting items) =========
export const createMemoryGroup = async (req, res) => {
  try {
    const { name, disableComments } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Memory name is required" });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: "At least one photo or video is required" });
    }

    const group = await MemoryGroup.create({ author: req.user._id, name: name.trim() });

    const itemDocs = filesToItemDocs(req.files, group._id, req.user._id, disableComments);
    const items = await MemoryItem.insertMany(itemDocs);

    res.status(201).json({
      success: true,
      group: {
        _id: group._id,
        name: group.name,
        coverUrl: items[0].media.url,
        coverType: items[0].media.type,
        itemsCount: items.length,
        createdAt: group.createdAt,
      },
      items,
    });

    try {
      getIO().emit("memoryGroupAdded", { authorId: req.user._id.toString(), groupId: group._id.toString() });
    } catch {}
  } catch (error) {
    console.error("CREATE MEMORY GROUP ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= ADD ITEM(S) TO AN EXISTING GROUP =====================
export const addMemoryItem = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { disableComments } = req.body;

    const group = await MemoryGroup.findById(groupId);
    if (!group) return res.status(404).json({ success: false, message: "Memory group not found" });
    if (group.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: "At least one photo or video is required" });
    }

    const itemDocs = filesToItemDocs(req.files, group._id, req.user._id, disableComments);
    const items = await MemoryItem.insertMany(itemDocs);

    res.status(201).json({ success: true, items });

    try {
      getIO().emit("memoryItemAdded", {
        authorId: req.user._id.toString(),
        groupId: group._id.toString(),
        itemIds: items.map((it) => it._id.toString()),
      });
    } catch {}
  } catch (error) {
    console.error("ADD MEMORY ITEM ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= GET A USER'S GROUPS (for the profile bubble row) =====
export const getUserMemoryGroups = async (req, res) => {
  try {
    const targetId = req.params.userId;
    const viewerId = req.user._id;

    const groups = await MemoryGroup.find({ author: targetId }).sort({ createdAt: -1 });
    if (groups.length === 0) return res.status(200).json({ success: true, groups: [] });

    const items = await MemoryItem.find({ group: { $in: groups.map((g) => g._id) } }).sort({ createdAt: -1 });

    const result = [];
    for (const group of groups) {
      const groupItems = items.filter((it) => it.group.toString() === group._id.toString());
      const visibleItems = [];
      for (const item of groupItems) {
        if (await canAccessMemoryItem(item, viewerId)) visibleItems.push(item);
      }
      if (visibleItems.length === 0) continue; // nothing to show — skip the bubble entirely
      result.push({
        _id: group._id,
        name: group.name,
        coverUrl: visibleItems[0].media.url,
        coverType: visibleItems[0].media.type,
        itemsCount: visibleItems.length,
        createdAt: group.createdAt,
      });
    }

    res.status(200).json({ success: true, groups: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= GET ITEMS WITHIN ONE GROUP (for the viewer) ==========
export const getGroupItems = async (req, res) => {
  try {
    const { groupId } = req.params;
    const viewerId = req.user._id;

    const group = await MemoryGroup.findById(groupId).populate("author", "username profilePic");
    if (!group) return res.status(404).json({ success: false, message: "Memory group not found" });

    const items = await MemoryItem.find({ group: groupId }).sort({ createdAt: 1 });

    const visible = [];
    for (const item of items) {
      const allowed = await canAccessMemoryItem(item, viewerId);
      if (!allowed) continue;
      const obj = item.toObject();
      obj.likesCount = item.likes.length;
      obj.viewsCount = item.views.length;
      obj.liked = item.likes.some((id) => id.toString() === viewerId.toString());
      obj.viewedByMe = item.views.some((id) => id.toString() === viewerId.toString());
      delete obj.comments; // comments are fetched per-item, same as Post
      visible.push(obj);
    }

    res.status(200).json({
      success: true,
      group: { _id: group._id, name: group.name, author: group.author },
      items: visible,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= DELETE ONE ITEM =================
export const deleteMemoryItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });
    if (item.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const groupId = item.group.toString();
    await destroyMemoryMedia(item.media);
    await MemoryItem.findByIdAndDelete(itemId);

    const remaining = await MemoryItem.countDocuments({ group: groupId });
    let groupDeleted = false;
    if (remaining === 0) {
      await MemoryGroup.findByIdAndDelete(groupId);
      groupDeleted = true;
    }

    try {
      const io = getIO();
      io.emit("memoryItemDeleted", { authorId: req.user._id.toString(), groupId, itemId });
      if (groupDeleted) {
        io.emit("memoryGroupDeleted", { authorId: req.user._id.toString(), groupId });
      }
    } catch {}

    res.status(200).json({ success: true, groupDeleted, message: "Memory deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= TOGGLE HIDE FROM NON-FOLLOWERS (per item) ============
export const toggleHideItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });
    if (item.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    item.isHiddenFromNonFollowers = !item.isHiddenFromNonFollowers;
    await item.save();

    try {
      getIO().emit("memoryVisibilityChanged", {
        authorId: req.user._id.toString(),
        itemId,
        isHidden: item.isHiddenFromNonFollowers,
      });
    } catch {}

    res.status(200).json({
      success: true,
      isHiddenFromNonFollowers: item.isHiddenFromNonFollowers,
      message: item.isHiddenFromNonFollowers
        ? "Memory hidden from non-followers"
        : "Memory visible to everyone",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= TOGGLE COMMENTS ON/OFF (per item) — NEW ==============
// Owner-only. This is the escape hatch for items that got stuck with
// disableComments:true from before the FormData-boolean fix (toBool()
// above) — previously the only way to "turn comments back on" for one of
// those was to delete the memory and re-upload it. Mirrors
// toggleHideItem exactly.
export const toggleMemoryComments = async (req, res) => {
  try {
    const { itemId } = req.params;
    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });
    if (item.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    item.disableComments = !item.disableComments;
    await item.save();

    try {
      getIO().emit("memoryCommentsToggled", {
        authorId: req.user._id.toString(),
        itemId,
        disableComments: item.disableComments,
      });
    } catch {}

    res.status(200).json({
      success: true,
      disableComments: item.disableComments,
      message: item.disableComments ? "Comments turned off" : "Comments turned on",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= TOGGLE COMMENTS ON/OFF (per item) — NEW ==============
// PATCH /memories/items/:itemId/toggle-comments
// Same idea as toggleHideItem exactly. This is the piece that was
// missing: disableComments could only ever be SET at creation time —
// there was no way for the owner to flip it back on afterwards. If an
// item got stuck with disableComments:true (e.g. it was created before
// the multipart-boolean-parsing fix, back when "false" strings were
// being coerced to true), the owner had no way to fix it short of
// deleting and re-uploading the memory. This closes that gap.
export const toggleDisableComments = async (req, res) => {
  try {
    const { itemId } = req.params;
    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });
    if (item.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    item.disableComments = !item.disableComments;
    await item.save();

    emitToMemoryItem(itemId, `memoryItem:${itemId}:commentsToggled`, {
      disableComments: item.disableComments,
    });

    res.status(200).json({
      success: true,
      disableComments: item.disableComments,
      message: item.disableComments
        ? "Comments turned off for this memory"
        : "Comments turned on for this memory",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= VIEW ITEM =================
export const viewMemoryItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    const userId = req.user._id;
    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });

    const allowed = await canAccessMemoryItem(item, userId);
    if (!allowed) return res.status(403).json({ success: false, message: "Not allowed" });

    const already = item.views.some((id) => id.toString() === userId.toString());
    if (!already) {
      item.views.push(userId);
      await item.save();
      // ← NEW — live-push the updated view count, same pattern as likes,
      // so an open viewer (e.g. the owner watching their own memory in
      // another tab) sees the count tick up in real time.
      emitToMemoryItem(itemId, `memoryItem:${itemId}:views`, { viewsCount: item.views.length });
    }

    res.status(200).json({ success: true, viewsCount: item.views.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= GET VIEWERS (with search) — NEW ======================
// GET /memories/items/:itemId/viewers?q=search
// Mirrors getMemoryLikers below. Owner-only (viewing who watched your
// memory is private, same convention as Story views), everyone else gets
// 403 rather than an empty list so the frontend can tell the difference
// between "no viewers yet" and "not allowed to see viewers".
export const getMemoryViewers = async (req, res) => {
  try {
    const { itemId } = req.params;
    const q = (req.query.q || "").trim();
    const viewerId = req.user._id;

    const item = await MemoryItem.findById(itemId).populate("views", "username profilePic bio");
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });

    if (item.author.toString() !== viewerId.toString()) {
      return res.status(403).json({ success: false, message: "Only the owner can see who viewed this memory" });
    }

    let viewers = item.views;
    if (q) {
      const rx = new RegExp(q, "i");
      viewers = viewers.filter((u) => rx.test(u.username || ""));
    }

    res.status(200).json({ success: true, viewers, totalViews: item.views.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= LIKE STATE =================
export const getMemoryLikeState = async (req, res) => {
  try {
    const { itemId } = req.params;
    const userId = req.user._id;
    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });

    const allowed = await canAccessMemoryItem(item, userId);
    if (!allowed) return res.status(403).json({ success: false, message: "Not allowed" });

    res.status(200).json({
      success: true,
      likesCount: item.likes.length,
      liked: item.likes.some((id) => id.toString() === userId.toString()),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= TOGGLE LIKE =================
export const toggleMemoryLike = async (req, res) => {
  try {
    const { itemId } = req.params;
    const userId = req.user._id;

    const item = await MemoryItem.findById(itemId).populate("author", "_id username");
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });

    const allowed = await canAccessMemoryItem(item, userId);
    if (!allowed) return res.status(403).json({ success: false, message: "Not allowed" });

    const alreadyLiked = item.likes.some((id) => id.toString() === userId.toString());
    if (alreadyLiked) {
      item.likes = item.likes.filter((id) => id.toString() !== userId.toString());
    } else {
      item.likes.push(userId);
    }
    await item.save();

    emitToMemoryItem(itemId, `memoryItem:${itemId}:likes`, { likesCount: item.likes.length });

    const ownerId = item.author?._id?.toString();
    if (!alreadyLiked && ownerId && ownerId !== userId.toString()) {
      const liker = await User.findById(userId).select("username");
      // ← memoryGroupId/memoryItemId let the recipient's Activity page
      // deep-link straight to this exact memory slide instead of just
      // the owner's profile. authorId is sent explicitly (not just
      // embedded in `link`) so the frontend doesn't have to parse it
      // out of a URL string.
      await createNotification({
        recipientId: ownerId,
        senderId: userId,
        type: "memory_like",
        message: `${liker?.username || "Someone"} liked your memory`,
        memoryGroupId: item.group,
        memoryItemId: item._id,
        authorId: ownerId,
        link: `/profile/${ownerId}`,
      });
    }

    res.status(200).json({ success: true, liked: !alreadyLiked, likesCount: item.likes.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= GET LIKERS (with search) =================
export const getMemoryLikers = async (req, res) => {
  try {
    const { itemId } = req.params;
    const q = (req.query.q || "").trim();
    const viewerId = req.user._id;

    const item = await MemoryItem.findById(itemId).populate("likes", "username profilePic bio");
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });

    const allowed = await canAccessMemoryItem(item, viewerId);
    if (!allowed) return res.status(403).json({ success: false, message: "Not allowed" });

    let likers = item.likes;
    if (q) {
      const rx = new RegExp(q, "i");
      likers = likers.filter((u) => rx.test(u.username || ""));
    }

    res.status(200).json({ success: true, likers, totalLikes: item.likes.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ══════════════════════════════════════════════════════════════════════
// ── COMMENTS / REPLIES — mirrors controllers/comment.controllers.js
// 1:1, just scoped to a MemoryItem instead of a Post, and emitting to
// `memoryItem:{id}` rooms instead of `post:{id}` rooms.
// ══════════════════════════════════════════════════════════════════════

// ================= GET COMMENTS =================
export const getMemoryComments = async (req, res) => {
  try {
    const { itemId } = req.params;
    const viewerId = req.user._id;

    const item = await MemoryItem.findById(itemId)
      .populate("comments.user", "username profilePic")
      .populate("comments.replies.user", "username profilePic");
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });

    const allowed = await canAccessMemoryItem(item, viewerId);
    if (!allowed) return res.status(403).json({ success: false, message: "Not allowed" });

    const comments = item.comments.map((c) => ({ ...c.toObject(), author: c.user }));
    res.status(200).json({ success: true, comments, disableComments: item.disableComments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= ADD COMMENT =================
export const addMemoryComment = async (req, res) => {
  try {
    const { text } = req.body;
    const { itemId } = req.params;

    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: "Comment text is required" });
    }

    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });

    // ── Access gate: anyone who can SEE this memory (public account, or
    // a follower of a private one, or the owner) can comment on it. This
    // was already correct here — if comments from other users were being
    // rejected with 403 in your app, it was almost always either (a) the
    // memory's author has a private account and the commenter isn't
    // following yet (expected — same as Instagram), or (b) stale data:
    // an older buggy build of this endpoint stored disableComments=true
    // on items created before this fix. Re-create the memory (or PATCH
    // its disableComments in the DB) to clear that.
    const allowed = await canAccessMemoryItem(item, req.user._id);
    if (!allowed) return res.status(403).json({ success: false, message: "Not allowed" });

    if (item.disableComments && item.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Comments are turned off for this memory" });
    }

    item.comments.push({ user: req.user._id, text: text.trim() });
    await item.save();

    await item.populate("comments.user", "username profilePic");
    await item.populate("comments.replies.user", "username profilePic");

    const newComment = item.comments[item.comments.length - 1];
    const commentToSend = { ...newComment.toObject(), author: newComment.user };

    emitToMemoryItem(itemId, `memoryItem:${itemId}:newComment`, { comment: commentToSend });

    if (item.author.toString() !== req.user._id.toString()) {
      const commenter = await User.findById(req.user._id).select("username");
      await createNotification({
        recipientId: item.author,
        senderId: req.user._id,
        type: "memory_comment",
        message: `${commenter?.username || "Someone"} commented on your memory`,
        memoryGroupId: item.group,
        memoryItemId: item._id,
        commentId: newComment._id,
        authorId: item.author,
        link: `/profile/${item.author}`,
      });
    }

    res.status(201).json({ success: true, comment: commentToSend });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= EDIT COMMENT =================
export const editMemoryComment = async (req, res) => {
  try {
    const { text } = req.body;
    const { itemId, commentId } = req.params;

    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });

    const comment = item.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    if (comment.user.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: "Unauthorized" });

    comment.text = text;
    comment.isEdited = true;
    await item.save();

    emitToMemoryItem(itemId, `memoryItem:${itemId}:commentEdited`, { commentId, text, isEdited: true });

    res.status(200).json({ success: true, comment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= DELETE COMMENT =================
export const deleteMemoryComment = async (req, res) => {
  try {
    const { itemId, commentId } = req.params;

    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });

    const comment = item.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    if (comment.user.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: "Unauthorized" });

    comment.deleteOne();
    await item.save();

    emitToMemoryItem(itemId, `memoryItem:${itemId}:commentDeleted`, { commentId });

    res.status(200).json({ success: true, message: "Comment deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= LIKE COMMENT =================
export const likeMemoryComment = async (req, res) => {
  try {
    const { itemId, commentId } = req.params;

    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });

    const comment = item.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    const alreadyLiked = comment.likes.includes(req.user._id);
    if (alreadyLiked) {
      comment.likes = comment.likes.filter((id) => id.toString() !== req.user._id.toString());
    } else {
      comment.likes.push(req.user._id);
    }
    await item.save();

    emitToMemoryItem(itemId, `memoryItem:${itemId}:commentLiked`, {
      commentId,
      liked: !alreadyLiked,
      totalLikes: comment.likes.length,
      userId: req.user._id,
    });

    if (!alreadyLiked && comment.user.toString() !== req.user._id.toString()) {
      const liker = await User.findById(req.user._id).select("username");
      await createNotification({
        recipientId: comment.user,
        senderId: req.user._id,
        type: "memory_like_comment",
        message: `${liker?.username || "Someone"} liked your comment`,
        memoryGroupId: item.group,
        memoryItemId: item._id,
        commentId: comment._id,
        authorId: item.author,
        link: `/profile/${item.author}`,
      });
    }

    res.status(200).json({ success: true, liked: !alreadyLiked, totalLikes: comment.likes.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= REPLY TO COMMENT =================
export const replyMemoryComment = async (req, res) => {
  try {
    // ← NEW — same fix as comment.controllers.js's replyComment: know
    // WHICH reply (if any) this was aimed at, so we can notify that
    // person instead of always notifying the top-level comment's author.
    const { text, parentReplyId = null } = req.body;
    const { itemId, commentId } = req.params;

    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });

    const comment = item.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    if (item.disableComments && item.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Comments are turned off for this memory" });
    }

    // ← NEW — resolve who this reply is actually directed at, before
    // pushing the new reply (so we're reading the PRE-existing thread).
    const targetReply = parentReplyId ? comment.replies.id(parentReplyId) : null;
    const targetUserId = targetReply ? targetReply.user : comment.user;

    comment.replies.push({ user: req.user._id, text });
    await item.save();

    await item.populate("comments.replies.user", "username profilePic");
    const updatedComment = item.comments.id(commentId);
    const newReply = updatedComment.replies[updatedComment.replies.length - 1];

    emitToMemoryItem(itemId, `memoryItem:${itemId}:newReply`, { commentId, reply: newReply });

    // ← FIXED — notifies whoever you actually replied to (the specific
    // reply's author, if any) instead of unconditionally notifying the
    // top-level comment's author. Previously, replying to someone's reply
    // deep in a memory's comment thread notified the ORIGINAL commenter
    // again and the person you actually responded to got nothing.
    if (targetUserId.toString() !== req.user._id.toString()) {
      const replier = await User.findById(req.user._id).select("username");
      await createNotification({
        recipientId: targetUserId,
        senderId: req.user._id,
        type: "memory_reply",
        message: `${replier?.username || "Someone"} replied to your ${targetReply ? "reply" : "comment"}`,
        memoryGroupId: item.group,
        memoryItemId: item._id,
        commentId: comment._id,
        replyId: newReply._id,
        authorId: item.author,
        link: `/profile/${item.author}`,
      });
    }

    res.status(201).json({ success: true, reply: newReply, replies: updatedComment.replies });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= EDIT REPLY =================
export const editMemoryReply = async (req, res) => {
  try {
    const { text } = req.body;
    const { itemId, commentId, replyId } = req.params;

    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });

    const comment = item.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    const reply = comment.replies.id(replyId);
    if (!reply) return res.status(404).json({ success: false, message: "Reply not found" });

    if (reply.user.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: "Unauthorized" });

    reply.text = text;
    reply.isEdited = true;
    await item.save();

    emitToMemoryItem(itemId, `memoryItem:${itemId}:replyEdited`, { commentId, replyId, text, isEdited: true });

    res.status(200).json({ success: true, reply });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= DELETE REPLY =================
export const deleteMemoryReply = async (req, res) => {
  try {
    const { itemId, commentId, replyId } = req.params;

    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });

    const comment = item.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    const reply = comment.replies.id(replyId);
    if (!reply) return res.status(404).json({ success: false, message: "Reply not found" });

    if (reply.user.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: "Unauthorized" });

    reply.deleteOne();
    await item.save();

    emitToMemoryItem(itemId, `memoryItem:${itemId}:replyDeleted`, { commentId, replyId });

    res.status(200).json({ success: true, message: "Reply deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= LIKE REPLY =================
export const likeMemoryReply = async (req, res) => {
  try {
    const { itemId, commentId, replyId } = req.params;

    const item = await MemoryItem.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Memory not found" });
    const comment = item.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });
    const reply = comment.replies.id(replyId);
    if (!reply) return res.status(404).json({ success: false, message: "Reply not found" });

    const alreadyLiked = reply.likes.includes(req.user._id);
    if (alreadyLiked) {
      reply.likes = reply.likes.filter((id) => id.toString() !== req.user._id.toString());
    } else {
      reply.likes.push(req.user._id);
    }
    await item.save();

    emitToMemoryItem(itemId, `memoryItem:${itemId}:replyLiked`, {
      commentId,
      replyId,
      liked: !alreadyLiked,
      totalLikes: reply.likes.length,
      userId: req.user._id,
    });

    // ← NEW — this never notified anyone before, same gap as post
    // comments' likeReply. Liking a memory comment already notifies;
    // liking a reply one level deeper was silently skipped.
    if (!alreadyLiked && reply.user.toString() !== req.user._id.toString()) {
      const liker = await User.findById(req.user._id).select("username");
      await createNotification({
        recipientId: reply.user,
        senderId: req.user._id,
        type: "memory_like_reply",
        message: `${liker?.username || "Someone"} liked your reply`,
        memoryGroupId: item.group,
        memoryItemId: item._id,
        commentId,
        replyId,
        authorId: item.author,
        link: `/profile/${item.author}`,
      });
    }

    res.status(200).json({ success: true, liked: !alreadyLiked, totalLikes: reply.likes.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};