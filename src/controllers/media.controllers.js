import Post from "../models/post/post.model.js";
import User from "../models/user/user.model.js";
import Notification from "../models/notifications/notification.model.js";
import cloudinary from "../config/cloudinary.js";
import { MAX_POST_IMAGE_BYTES, MAX_POST_VIDEO_BYTES } from "../config/cloudinary.js";
import { getIO, onlineUsers } from "../config/sockets.js";
import { createNotification } from "./notification.helper.js";
import { destroyCloudinaryAssetById, extractCloudinaryMeta } from "../jobs/expire.media.js";

// ── Can `viewerId` see this post, given it's a collaboration and the
// viewer is looking at it via COLLABORATOR B's profile (not the
// original author's)? Rule: stricter of the two accounts' privacy wins.
export const canViewCollabPost = async (post, viewerId, viewingOnProfileOf) => {
  const viewerIdStr = viewerId?.toString();
  const authorIdStr = post.author?._id?.toString() || post.author?.toString();

  if (viewerIdStr === authorIdStr) return true; // author can always see their own post

  const author =
    post.author?.isPrivate !== undefined
      ? post.author // already populated with isPrivate/followers
      : await User.findById(authorIdStr).select("isPrivate followers");

  const followsAuthor =
    !author?.isPrivate ||
    author?.followers?.some((id) => (id?._id ?? id).toString() === viewerIdStr);

  if (!followsAuthor) return false;

  if (viewingOnProfileOf && viewingOnProfileOf.toString() !== authorIdStr) {
    const profileOwner = await User.findById(viewingOnProfileOf).select("isPrivate followers");
    const followsProfileOwner =
      !profileOwner?.isPrivate ||
      viewerIdStr === viewingOnProfileOf.toString() ||
      profileOwner?.followers?.some((id) => (id?._id ?? id).toString() === viewerIdStr);
    if (!followsProfileOwner) return false;
  }

  return true;
};

// ── Validate every uploaded file against its type's size limit. If ANY
// file in the batch is oversized, delete ALL of them from Cloudinary
// (not just the offending one) and reject the whole request.
const enforcePostMediaLimits = async (files) => {
  if (!files || files.length === 0) return { ok: true };

  const violations = [];
  for (const file of files) {
    const isVideo = file.mimetype?.startsWith("video/");
    const limit = isVideo ? MAX_POST_VIDEO_BYTES : MAX_POST_IMAGE_BYTES;
    if (file.size > limit) {
      violations.push({ file, isVideo });
    }
  }

  if (violations.length > 0) {
    await Promise.all(
      files.map(async (file) => {
        const meta = extractCloudinaryMeta(file);
        if (meta?.publicId) {
          await destroyCloudinaryAssetById(meta.publicId, meta.resourceType);
        }
      })
    );

    const hasOversizedVideo = violations.some((v) => v.isVideo);
    const hasOversizedImage = violations.some((v) => !v.isVideo);
    let message = "File too large.";
    if (hasOversizedVideo && hasOversizedImage) {
      message = "Some files exceed the size limit (images: 10MB, videos: 20MB).";
    } else if (hasOversizedVideo) {
      message = "Video must be under 20MB.";
    } else if (hasOversizedImage) {
      message = "Image must be under 10MB.";
    }

    return { ok: false, message };
  }

  return { ok: true };
};

// ================= UPLOAD SINGLE POST MEDIA FILE =================
// Dedicated upload endpoint for the post-creation screens (CreateImagePost,
// CreateTextPost, VideoPostFormat) to call BEFORE creating the post — they
// upload one file, get back a Cloudinary URL, then POST that URL as real
// JSON (with real booleans/arrays) to AddMediaPost/AddTextPost.
//
// This exists so those screens don't have to borrow the chat-attachment
// route (POST /messages/upload) — that route's size limits are tuned for
// DM attachments (25MB video), not posts. This one runs through the same
// `uploadPost` multer/Cloudinary config already used by /add-media-post
// etc, so the size rules actually match (10MB image / 20MB video via
// enforcePostMediaLimits below).
export const uploadPostMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const check = await enforcePostMediaLimits([req.file]);
    if (!check.ok) {
      return res.status(400).json({ success: false, message: check.message });
    }

    res.status(200).json({
      success: true,
      url: req.file.path,
      secure_url: req.file.path,
      type: req.file.mimetype?.startsWith("video/") ? "video" : "image",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= IMAGE OR VIDEO POST =================
// NEW: accepts and stores hideLikeCount / hideCommentCount /
// disableDownload from CreateImagePost.jsx's "Advanced settings" toggles.
export const AddMediaPost = async (req, res) => {
  try {
    const {
      caption, text, tags, postType, url, media: bodyMedia, collaborators,
      hideLikeCount, hideCommentCount, disableDownload, disableComments,
    } = req.body;

    let media = [];

    // ← case 1: multiple files uploaded via multer
    if (req.files && req.files.length > 0) {
      const check = await enforcePostMediaLimits(req.files);
      if (!check.ok) {
        return res.status(400).json({ success: false, message: check.message });
      }

      media = req.files.map((file) => ({
        url: file.path,
        type: file.mimetype.startsWith("video/") ? "video" : "image",
      }));
    }
    // ← case 2: media array sent from frontend (CreateImagePost /
    // CreateTextPost / VideoPostFormat). These URLs come from our own
    // /auth/upload-media route (uploadPostMedia below), which already
    // ran enforcePostMediaLimits on the file server-side before handing
    // back a URL — so no separate size check is needed for this path.
    else if (bodyMedia && Array.isArray(bodyMedia) && bodyMedia.length > 0) {
      media = bodyMedia;
    }
    // ← case 3: single url sent from frontend (old flow)
    else if (url) {
      media = [{ url, type: postType === "video" ? "video" : "image" }];
    }

    // ================= VALIDATION =================
    if (!text && media.length === 0) {
      return res.status(400).json({ success: false, message: "Post cannot be empty" });
    }

    // ================= FINAL POST TYPE =================
    const finalPostType =
      postType ||
      (media.length > 1 ? "carousel" : media[0]?.type || "text");

    // ================= TAGS FIX =================
    const finalTags = tags
      ? Array.isArray(tags) ? tags : tags.split(",")
      : [];

    // ================= COLLABORATORS — initial invites start PENDING ===
    const initialCollaborators = Array.isArray(collaborators)
      ? collaborators
          .filter((id) => id?.toString() !== req.user._id.toString())
          .map((id) => ({ user: id, status: "pending" }))
      : [];

    // ================= CREATE POST =================
    const post = await Post.create({
      author: req.user._id,
      caption: caption || "",
      text: text || "",
      media,
      tags: finalTags,
      postType: finalPostType,
      collaborators: initialCollaborators,
      // ← NEW — coerced to boolean so an omitted field defaults to false
      hideLikeCount: !!hideLikeCount,
      hideCommentCount: !!hideCommentCount,
      disableDownload: !!disableDownload,
      disableComments: !!disableComments,
    });

    await post.populate("author", "username profilePic");
    await post.populate("collaborators.user", "username profilePic");

    // ── notify followers: new post/reel/text was shared ─────────────────
    const authorForFeed = await User.findById(req.user._id).select("username followers");
    const feedFollowerIds = (authorForFeed?.followers || []).map((id) => id.toString());

    if (feedFollowerIds.length > 0 && feedFollowerIds.length <= 5000) {
      const label =
        finalPostType === "video" ? "reel" :
        finalPostType === "text" ? "text post" : "post";

      await Promise.all(
        feedFollowerIds.map((followerId) =>
          createNotification({
            recipientId: followerId,
            senderId: req.user._id,
            type: "new_post",
            postType: finalPostType,
            message: `${authorForFeed.username} shared a new ${label}`,
            postId: post._id,
            link: `/post/${post._id}`,
          })
        )
      );
    }

    // ← notify each initial collaborator added at post-creation time
    if (initialCollaborators.length > 0) {
      const author = await User.findById(req.user._id).select("username");
      await Promise.all(
        initialCollaborators.map((c) =>
          createNotification({
            recipientId: c.user,
            senderId: req.user._id,
            type: "collab_request",
            message: `${author?.username || "Someone"} invited you to collaborate on a post`,
            postId: post._id,
            link: `/post/${post._id}`,
          })
        )
      );
    }

    res.status(201).json({ success: true, post });
    const io = getIO();
    io.to(`user:${req.user._id}`).emit("newPost", { post });
  } catch (error) {
    console.error("ADD POST ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= TEXT POST =================
// NEW: also accepts hideLikeCount / hideCommentCount / disableDownload,
// same as AddMediaPost, so a text post with attached images gets the
// same settings support.
export const TextPost = async (req, res) => {
  try {

    const {
      text,
      caption,
      tags,
      collaborators,
      hideLikeCount,
      hideCommentCount,
      disableDownload,
      disableComments,
    } = req.body;

    // ================= MEDIA =================
    const media =
      req.files?.map((file) => ({
        url: file.path,
        type: "image",
      })) || [];

    if (req.files && req.files.length > 0) {
      const check = await enforcePostMediaLimits(req.files);
      if (!check.ok) {
        return res.status(400).json({ success: false, message: check.message });
      }
    }

    // ================= VALIDATION =================
    if (!text && media.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Post cannot be empty",
      });
    }

    // ================= TAGS FIX =================
    const finalTags = tags
      ? Array.isArray(tags)
        ? tags
        : tags.split(",")
      : [];

    // ================= COLLABORATORS — initial invites start PENDING ===
    const initialCollaborators = Array.isArray(collaborators)
      ? collaborators
          .filter((id) => id?.toString() !== req.user._id.toString())
          .map((id) => ({ user: id, status: "pending" }))
      : [];

    // ================= CREATE POST =================
    const finalPostType =
      media.length > 1 ? "carousel" : media.length === 1 ? "image" : "text";

    const post = await Post.create({
      author: req.user._id,
      postType: finalPostType,
      text: text || "",
      caption: caption || "",
      media,
      tags: finalTags,
      collaborators: initialCollaborators,
      hideLikeCount: !!hideLikeCount,
      hideCommentCount: !!hideCommentCount,
      disableDownload: !!disableDownload,
      disableComments: !!disableComments,
    });

    // ================= POPULATE AUTHOR =================
    await post.populate(
      "author",
      "username profilePic"
    );
    await post.populate("collaborators.user", "username profilePic");

    // ── notify followers: new post/reel/text was shared ─────────────────
    const authorForFeed = await User.findById(req.user._id).select("username followers");
    const feedFollowerIds = (authorForFeed?.followers || []).map((id) => id.toString());

    if (feedFollowerIds.length > 0 && feedFollowerIds.length <= 5000) {
      const label =
        finalPostType === "video" ? "reel" :
        finalPostType === "text" ? "text post" : "post";

      await Promise.all(
        feedFollowerIds.map((followerId) =>
          createNotification({
            recipientId: followerId,
            senderId: req.user._id,
            type: "new_post",
            postType: finalPostType,
            message: `${authorForFeed.username} shared a new ${label}`,
            postId: post._id,
            link: `/post/${post._id}`,
          })
        )
      );
    }

    // ← notify each initial collaborator added at post-creation time
    if (initialCollaborators.length > 0) {
      const author = await User.findById(req.user._id).select("username");
      await Promise.all(
        initialCollaborators.map((c) =>
          createNotification({
            recipientId: c.user,
            senderId: req.user._id,
            type: "collab_request",
            message: `${author?.username || "Someone"} invited you to collaborate on a post`,
            postId: post._id,
            link: `/post/${post._id}`,
          })
        )
      );
    }

    res.status(201).json({
      success: true,
      post,
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ================= GET POSTS =================
export const getPosts = async (req, res) => {
  try {

    // ================= PAGINATION =================
    const page =
      Number(req.query.page) || 1;

    const limit =
      Number(req.query.limit) || 10;

    const skip =
      (page - 1) * limit;

    const posts = await Post.find()

      .populate(
        "author",
        "username profilePic"
      )
      .populate("collaborators.user", "username profilePic")

      .sort({ createdAt: -1 })

      .skip(skip)

      .limit(limit);

    res.status(200).json({
      success: true,
      posts,
    });

  } catch (error) {

    console.error(
      "GET POSTS ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ================= ADD TEXT POST =================
export const AddTextPost = async (
  req,
  res
) => {
  try {

    const {
      text,
      tags,
      media,
      hideLikeCount,
      hideCommentCount,
      disableDownload,
      disableComments,
      collaborators, // ← was missing entirely — this is why collab invites
                      //   sent from CreateTextPost.jsx never went anywhere.
                      //   The frontend was sending them correctly all along;
                      //   this endpoint just never read the field.
    } = req.body;

    // ================= VALIDATION =================
    if (!text) {
      return res.status(400).json({
        success: false,
        message: "Text is required",
      });
    }

    // ================= TAGS FIX =================
    const finalTags = tags
      ? Array.isArray(tags)
        ? tags
        : tags.split(",")
      : [];

    // ================= COLLABORATORS — initial invites start PENDING ===
    // Same convention as AddMediaPost/TextPost: collaborators added at
    // creation time are INVITES, not immediate adds. They show on the
    // inviter's profile right away; they only show on the invitee's
    // profile once accepted via respondToCollaborator.
    const initialCollaborators = Array.isArray(collaborators)
      ? collaborators
          .filter((id) => id?.toString() !== req.user._id.toString())
          .map((id) => ({ user: id, status: "pending" }))
      : [];

    // NOTE: `media` here is pre-uploaded Cloudinary URLs from the
    // frontend (no req.files), so there's no raw file size available to
    // check server-side. If you want a hard server-side guarantee for
    // this path too, have the frontend send { url, type, bytes } per
    // media item and validate `bytes` here against MAX_POST_IMAGE_BYTES.

    const post = await Post.create({

      author: req.user._id,

      postType: "text",

      text,

      tags: finalTags,

      media: media || [],

      collaborators: initialCollaborators,

      hideLikeCount: !!hideLikeCount,
      hideCommentCount: !!hideCommentCount,
      disableDownload: !!disableDownload,
      disableComments: !!disableComments,
    });

    // ================= POPULATE AUTHOR =================
    await post.populate(
      "author",
      "username profilePic"
    );
    await post.populate("collaborators.user", "username profilePic");

    // ── notify followers: new text post was shared ──────────────────────
    const authorForFeed = await User.findById(req.user._id).select("username followers");
    const feedFollowerIds = (authorForFeed?.followers || []).map((id) => id.toString());

    if (feedFollowerIds.length > 0 && feedFollowerIds.length <= 5000) {
      await Promise.all(
        feedFollowerIds.map((followerId) =>
          createNotification({
            recipientId: followerId,
            senderId: req.user._id,
            type: "new_post",
            postType: "text",
            message: `${authorForFeed.username} shared a new text post`,
            postId: post._id,
            link: `/post/${post._id}`,
          })
        )
      );
    }

    // ← notify each initial collaborator added at post-creation time —
    // this was the other half of the bug: even if collaborators HAD
    // been stored, nobody would have been told they were invited.
    if (initialCollaborators.length > 0) {
      const author = await User.findById(req.user._id).select("username");
      await Promise.all(
        initialCollaborators.map((c) =>
          createNotification({
            recipientId: c.user,
            senderId: req.user._id,
            type: "collab_request",
            message: `${author?.username || "Someone"} invited you to collaborate on a post`,
            postId: post._id,
            link: `/post/${post._id}`,
          })
        )
      );
    }

    res.status(201).json({
      success: true,
      post,
    });

  } catch (error) {

    console.error(
      "ADD TEXT POST ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ================= DELETE POST =================
export const deletePost = async (req, res) => {
  try {
    const postId = req.params.postId;

    const post = await Post.findById(postId);

    // ================= CHECK POST =================
    if (!post) {
      return res.status(404).json({
        success: false,
        message: "Post not found",
      });
    }

    // ================= CHECK OWNER =================
    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can delete only your own post",
      });
    }

    // ================= DELETE MEDIA FROM CLOUDINARY =================
    if (post.media && post.media.length > 0) {
      const deletePromises = post.media.map(async (mediaItem) => {
        try {
          const urlParts = mediaItem.url.split("/");
          const uploadIndex = urlParts.indexOf("upload");

          const publicIdWithExtension = urlParts
            .slice(uploadIndex + 2)
            .join("/");

          const publicId = publicIdWithExtension.replace(/\.[^/.]+$/, "");

          const resourceType = mediaItem.type === "video" ? "video" : "image";

          await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
          console.log(`Deleted from Cloudinary: ${publicId}`);
        } catch (err) {
          console.error("Cloudinary delete failed for:", mediaItem.url, err.message);
        }
      });

      await Promise.all(deletePromises);
    }

    const collaboratorIds = (post.collaborators || [])
      .filter((c) => c.status === "accepted")
      .map((c) => c.user?.toString())
      .filter(Boolean);

    // ================= DELETE POST FROM DB =================
    await Post.findByIdAndDelete(postId);

    const io = getIO();
    io.to(`user:${req.user._id}`).emit("postDeleted", { postId });
    collaboratorIds.forEach((collabId) => {
      io.to(`user:${collabId}`).emit("postDeleted", { postId });
    });

    res.status(200).json({
      success: true,
      message: "Post deleted successfully",
    });

  } catch (error) {
    console.error("DELETE POST ERROR:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ================= GET USER POSTS (own profile — Profile.jsx) =================
export const getUserPosts = async (req, res) => {
  try {
    const targetId = req.params.userId || req.user._id;
    const viewerId = req.user._id;
    if (req.params.userId && !targetId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ success: false, message: "Invalid user ID" });
    }

    const [ownPosts, collabPosts] = await Promise.all([
      Post.find({ author: targetId })
        .populate("author", "username profilePic isPrivate")
        .populate("comments.user", "username profilePic")
        .populate("comments.replies.user", "username profilePic")
        .populate("collaborators.user", "username profilePic")
        .sort({ createdAt: -1 }),

      Post.find({
        author: { $ne: targetId },
        collaborators: { $elemMatch: { user: targetId, status: "accepted" } },
      })
        .populate("author", "username profilePic isPrivate followers")
        .populate("comments.user", "username profilePic")
        .populate("comments.replies.user", "username profilePic")
        .populate("collaborators.user", "username profilePic")
        .sort({ createdAt: -1 }),
    ]);

    const visibleCollabPosts = [];
    for (const post of collabPosts) {
      const allowed = await canViewCollabPost(post, viewerId, targetId);
      if (allowed) {
        const obj = post.toObject();
        obj.isCollab = true;
        visibleCollabPosts.push(obj);
      }
    }

    const ownPostsFlagged = ownPosts.map((post) => {
      const obj = post.toObject();
      obj.isCollab = (post.collaborators || []).some((c) => c.status === "accepted");
      return obj;
    });

    const merged = [...ownPostsFlagged, ...visibleCollabPosts].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    res.json({ success: true, posts: merged });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/posts/feed
// ================= GET FEED =================
export const getFeed = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const currentUserIdStr = userId.toString();

    // ← NEW: Explore.jsx passes ?includeMuted=true to reuse this same
    // endpoint for the public discovery grid, which must NOT be affected
    // by mute (mute only hides content from your following feed/tray,
    // same as Instagram). Home.jsx omits this flag, so it keeps filtering.
    const skipMuteFilter = req.query.includeMuted === "true";

    const currentUser = await User.findById(userId).select("following blockedUsers mutedUsers");
    const followingIds = currentUser?.following || [];
    const blockedIds = currentUser?.blockedUsers || [];

    const mutedPostAuthorIds = skipMuteFilter
      ? new Set()
      : new Set(
          (currentUser?.mutedUsers || [])
            .filter((m) => m.mutePost)
            .map((m) => m.user.toString())
        );

    const posts = await Post.find()
      .populate("author", "username profilePic isPrivate")
      .populate("collaborators.user", "username profilePic")
      .sort({ createdAt: -1 });

    const filteredPosts = posts.filter((post) => {
      const author = post.author;
      if (!author) return false;
      const authorId = author._id.toString();

      if (blockedIds.some(id => id.toString() === authorId)) return false;
      if (mutedPostAuthorIds.has(authorId)) return false;

      if (authorId === currentUserIdStr) return true;

      if (author.isPrivate) {
        const isFollowing = followingIds.some(id => id.toString() === authorId);
        if (!isFollowing) return false;
      }
      if (post.isHiddenFromNonFollowers) {
        const viewerFollowsAuthor = followingIds.some(id => id.toString() === authorId);
        if (!viewerFollowsAuthor) return false;
      }
      if (post.notInterested?.some(id => id.toString() === currentUserIdStr)) return false;

      return true;
    });

    res.status(200).json({ success: true, posts: filteredPosts });
  } catch (err) {
    console.error("GET FEED ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const HideFromNonFollowers = async (req, res) => {
  try {
    const currentUserId = req.user._id || req.user.id;
    const { postId } = req.params;

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    if (post.author.toString() !== currentUserId.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    post.isHiddenFromNonFollowers = !post.isHiddenFromNonFollowers;
    await post.save();

    return res.status(200).json({
      success: true,
      isHidden: post.isHiddenFromNonFollowers,
       postId: post._id,
      message: post.isHiddenFromNonFollowers
        ? "Post hidden from non-followers"
        : "Post visible to everyone",
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const toggleNotInterested = async (req, res) => {
  try {
    const { postId } = req.params;

    const post = await Post.findById(postId);

    if (!post) {
      return res.status(404).json({
        success: false,
        message: "Post not found",
      });
    }

    const userId = req.user._id;

    const alreadyMarked = (post.notInterested || []).some(
      (id) => id.toString() === req.user._id.toString()
    );

    if (alreadyMarked) {
      await post.updateOne({
        $pull: { notInterested: userId },
      });

      return res.status(200).json({
        success: true,
        isNotInterested: false,
        message: "Post added back to feed",
      });
    }

    await post.updateOne({
      $addToSet: { notInterested: userId },
    });

    return res.status(200).json({
      success: true,
      isNotInterested: true,
      message: "Post hidden from feed",
    });
  } catch (error) {
    console.log("toggleNotInterested error:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ================= ADD TAG TO POST =================
export const addTag = async (req, res) => {
  try {
    const { postId } = req.params;
    const { tag } = req.body;

    if (!tag || !tag.trim()) {
      return res.status(400).json({ success: false, message: "Tag is required" });
    }

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    if (post.tags.includes(tag.trim())) {
      return res.status(400).json({ success: false, message: "Tag already exists" });
    }

    post.tags.push(tag.trim());
    await post.save();

    res.status(200).json({ success: true, tags: post.tags, message: "Tag added" });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= REMOVE TAG FROM POST =================
export const removeTag = async (req, res) => {
  try {
    const { postId } = req.params;
    const { tag } = req.body;

    if (!tag || !tag.trim()) {
      return res.status(400).json({ success: false, message: "Tag is required" });
    }

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    post.tags = post.tags.filter(t => t !== tag.trim());
    await post.save();

    res.status(200).json({ success: true, tags: post.tags, message: "Tag removed" });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= ADD COLLABORATOR TO POST (sends a pending invite) =====
// FIX: previously, ANY existing collaborators entry — pending, accepted,
// OR declined — permanently blocked re-inviting that user (this is what
// caused the 400 Bad Request you were seeing, since respondToCollaborator
// never removes a declined entry, it just flips its status). Now only a
// live "pending" or "accepted" entry blocks a new invite; a "declined"
// entry is reset back to "pending" in place instead of being rejected.
export const addCollaborator = async (req, res) => {
  try {
    const { postId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, message: "User ID is required" });
    }

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    // check user exists
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    // can't add yourself
    if (userId.toString() === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: "You cannot add yourself as a collaborator" });
    }

    const existingIndex = (post.collaborators || []).findIndex(
      (c) => c.user?.toString() === userId.toString()
    );

    if (existingIndex !== -1) {
      const existingStatus = post.collaborators[existingIndex].status;

      if (existingStatus === "pending" || existingStatus === "accepted") {
        return res.status(400).json({ success: false, message: "User is already invited or a collaborator" });
      }

      // existingStatus === "declined" → re-invite by resetting in place
      post.collaborators[existingIndex].status = "pending";
      post.collaborators[existingIndex].respondedAt = undefined;
      await post.save();
    } else {
      await post.updateOne({
        $push: { collaborators: { user: userId, status: "pending" } },
      });
    }

    const updatedPost = await Post.findById(postId)
      .populate("collaborators.user", "username profilePic");

    // ← notify: collab invite sent (NOT a done deal — needs acceptance)
    const author = await User.findById(req.user._id).select("username");
    await createNotification({
      recipientId: userId,
      senderId: req.user._id,
      type: "collab_request",
      message: `${author?.username || "Someone"} invited you to collaborate on their post`,
      postId,
      link: `/post/${postId}`,
    });

    res.status(200).json({
      success: true,
      collaborators: updatedPost.collaborators,
      message: `Invite sent to ${user.username}`,
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= RESPOND TO COLLABORATOR INVITE =================
export const respondToCollaborator = async (req, res) => {
  try {
    const { postId } = req.params;
    const { accept } = req.body; // boolean

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const entry = post.collaborators.find(
      (c) => c.user?.toString() === req.user._id.toString()
    );
    if (!entry) {
      return res.status(404).json({ success: false, message: "You were not invited to this post" });
    }
    if (entry.status !== "pending") {
      return res.status(400).json({ success: false, message: `Invite already ${entry.status}` });
    }

    entry.status = accept ? "accepted" : "declined";
    entry.respondedAt = new Date();
    await post.save();

    await Notification.deleteMany({
      recipient: req.user._id,
      type: "collab_request",
      post: post._id,
      message: { $regex: /invited you/i },
    });

    const responder = await User.findById(req.user._id).select("username");
    await createNotification({
      recipientId: post.author,
      senderId: req.user._id,
      type: "collab_request",
      message: accept
        ? `${responder?.username || "Someone"} accepted your collab invite`
        : `${responder?.username || "Someone"} declined your collab invite`,
      postId,
      link: `/post/${postId}`,
    });

    try {
      const io = getIO();
      io.to(`user:${req.user._id}`).emit("collabResponded", {
        postId,
        accepted: !!accept,
        userId: req.user._id.toString(),
      });
      io.to(`user:${post.author.toString()}`).emit("collabResponded", {
        postId,
        accepted: !!accept,
        userId: req.user._id.toString(),
      });
      io.to(`user:${req.user._id}`).emit("collabInviteResolved", { postId });
    } catch (e) {
      console.log("Socket emit error:", e.message);
    }

    const updatedPost = await Post.findById(postId)
      .populate("collaborators.user", "username profilePic");

    res.status(200).json({
      success: true,
      status: entry.status,
      collaborators: updatedPost.collaborators,
      message: accept ? "Collab invite accepted" : "Collab invite declined",
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= REMOVE COLLABORATOR FROM POST =================
export const removeCollaborator = async (req, res) => {
  try {
    const { postId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, message: "User ID is required" });
    }

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const isOwner = post.author.toString() === req.user._id.toString();
    const isSelf  = userId.toString() === req.user._id.toString();

    if (!isOwner && !isSelf) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const wasAccepted = (post.collaborators || []).some(
      (c) => c.user?.toString() === userId.toString() && c.status === "accepted"
    );

    await post.updateOne({ $pull: { collaborators: { user: userId } } });

    const updatedPost = await Post.findById(postId)
      .populate("collaborators.user", "username profilePic")
      .populate("author", "username profilePic");

    try {
      const io = getIO();
      const actor = await User.findById(req.user._id).select("username");
      const authorIdStr = post.author.toString();

      if (isOwner && userId.toString() !== authorIdStr) {
        await createNotification({
          recipientId: userId,
          senderId: req.user._id,
          type: "collab_request",
          message: `${actor?.username || "Someone"} removed you as a collaborator on their post`,
          postId,
          link: `/post/${postId}`,
        });
        io.to(`user:${userId}`).emit("collabRemoved", { postId, userId: userId.toString() });
      } else if (isSelf && !isOwner) {
        await createNotification({
          recipientId: post.author,
          senderId: req.user._id,
          type: "collab_request",
          message: `${actor?.username || "Someone"} removed themself as a collaborator on your post`,
          postId,
          link: `/post/${postId}`,
        });
        io.to(`user:${authorIdStr}`).emit("collabRemoved", { postId, userId: userId.toString() });
      }

      if (wasAccepted) {
        io.to(`user:${userId}`).emit("postDeleted", { postId });
      }
    } catch (e) {
      console.log("removeCollaborator notify/socket error:", e.message);
    }

    res.status(200).json({
      success: true,
      collaborators: updatedPost.collaborators,
      message: "Collaborator removed",
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


export const getPostById = async (req, res) => {
  try {
    const { postId } = req.params;
    const viewerId = req.user._id || req.user.id;

    const post = await Post.findById(postId)
      .populate("author", "username profilePic isPrivate followers")
      .populate("comments.user", "username profilePic")
      .populate("comments.replies.user", "username profilePic")
      .populate("collaborators.user", "username profilePic");

    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    const authorId = post.author?._id?.toString();
    const isOwner = authorId === viewerId.toString();

    const isAcceptedCollaborator = (post.collaborators || []).some(
      (c) => c.status === "accepted" && (c.user?._id ?? c.user)?.toString() === viewerId.toString()
    );

    if (!isOwner && !isAcceptedCollaborator && post.author?.isPrivate) {
      const isFollower = (post.author.followers || []).some(
        (f) => (f?._id ?? f)?.toString() === viewerId.toString()
      );
      if (!isFollower) {
        return res.status(404).json({ success: false, message: "Post not found" });
      }
    }

    if (!isOwner && authorId !== viewerId.toString()) {
      const allowed = await canViewCollabPost(post, viewerId, authorId);
      if (!allowed && !isAcceptedCollaborator) {
        return res.status(404).json({ success: false, message: "Post not found" });
      }
    }

    const postObj = post.toObject();
    postObj.isNotInterested = post.notInterested?.some(
      (uid) => uid.toString() === viewerId.toString()
    );

    res.status(200).json({ success: true, post: postObj });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// router.get("/get-post/:id", protectRoute, getPostById);

// ═════════════════════════════════════════════════════════════════════════
// disableComments — SERVER-SIDE ENFORCEMENT NOTE
// This file only stores/returns the flag. The frontend hides the comment
// button/sheet when it's set, but that's UI-only — someone could still
// hit your comment-creation endpoint (POST /auth/comment/:postId) directly.
// In whichever controller handles that route, add a guard like:
//
//   const post = await Post.findById(req.params.id).select("author disableComments");
//   if (!post) return res.status(404).json({ success: false, message: "Post not found" });
//   const isOwner = post.author.toString() === req.user._id.toString();
//   if (post.disableComments && !isOwner) {
//     return res.status(403).json({ success: false, message: "Comments are turned off for this post" });
//   }
//
// before creating the comment, so the restriction actually holds even if
// someone bypasses the UI.
// ═════════════════════════════════════════════════════════════════════════