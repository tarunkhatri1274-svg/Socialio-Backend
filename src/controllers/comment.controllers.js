import mongoose from "mongoose";
import Post from "../models/post/post.model.js";
import User from "../models/user/user.model.js";
import { getIO } from "../config/sockets.js";
import { createNotification } from "./notification.helper.js";

// ── Comment-poll / pin settings ───────────────────────────────────────────
const MAX_PINNED_COMMENTS = 3;
const MAX_POLL_OPTIONS = 12;
// true  = only the post owner can create polls (on their OWN post).
// false = any commenter can create a poll comment.
const POLL_OWNER_ONLY = true;

const emitToPost = (postId, event, data) => {
  try {
    getIO().to(`post:${postId}`).emit(event, data);
  } catch (e) {
    console.log("Socket emit error:", e.message);
  }
};

// ================= ADD COMMENT =================
export const addComment = async (req, res) => {
  try {
    const { text } = req.body;
    const { postId } = req.params;

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    post.comments.push({ user: req.user._id, text });
    await post.save();

    await post.populate("comments.user", "username profilePic");
    await post.populate("comments.replies.user", "username profilePic");

    const newComment = post.comments[post.comments.length - 1];
    const commentToSend = {
      ...newComment.toObject(),
      author: newComment.user,
      postAuthor: post.author,
    };

    // ✅ Only one scoped emit
    emitToPost(postId, `post:${postId}:newComment`, { comment: commentToSend });

    // ← notify: commented on your post
    // postType passed through so "Reel" / "Text" mute correctly applies
    // to comments on video/text posts specifically, not just images.
    if (post.author.toString() !== req.user._id.toString()) {
      const commenter = await User.findById(req.user._id).select("username");
      await createNotification({
        recipientId: post.author,
        senderId: req.user._id,
        type: "comment",
        postType: post.postType,
        message: `${commenter?.username || "Someone"} commented on your post`,
        postId,
        commentId: newComment._id,
        link: `/post/${postId}`,
      });
    }

    res.status(201).json({ success: true, comment: commentToSend });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= EDIT COMMENT =================
export const editComment = async (req, res) => {
  try {
    const { text } = req.body;
    const { postId, commentId } = req.params;

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const comment = post.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    if (comment.user.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: "Unauthorized" });

    if (comment.poll) {
      return res.status(400).json({ success: false, message: "Poll comments can't be edited" });
    }

    comment.text = text;
    comment.isEdited = true;
    await post.save();

    // ✅ scoped emit
    emitToPost(postId, `post:${postId}:commentEdited`, { commentId, text, isEdited: true });

    res.status(200).json({ success: true, comment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= DELETE COMMENT =================
export const deleteComment = async (req, res) => {
  try {
    const { postId, commentId } = req.params;

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const comment = post.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    if (comment.user.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: "Unauthorized" });

    comment.deleteOne();
    await post.save();

    // ✅ scoped emit
    emitToPost(postId, `post:${postId}:commentDeleted`, { commentId });

    res.status(200).json({ success: true, message: "Comment deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= LIKE COMMENT =================
export const likeComment = async (req, res) => {
  try {
    const { postId, commentId } = req.params;

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const comment = post.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    const alreadyLiked = comment.likes.includes(req.user._id);
    if (alreadyLiked) {
      comment.likes = comment.likes.filter(id => id.toString() !== req.user._id.toString());
    } else {
      comment.likes.push(req.user._id);
    }

    await post.save();

    // ✅ scoped emit
    emitToPost(postId, `post:${postId}:commentLiked`, {
      commentId,
      liked: !alreadyLiked,
      totalLikes: comment.likes.length,
      userId: req.user._id,
    });

    // ← notify: liked your comment
    if (!alreadyLiked && comment.user.toString() !== req.user._id.toString()) {
      const liker = await User.findById(req.user._id).select("username");
      await createNotification({
        recipientId: comment.user,
        senderId: req.user._id,
        type: "like_comment",
        postType: post.postType,
        message: `${liker?.username || "Someone"} liked your comment`,
        postId,
        commentId,
        link: `/post/${postId}`,
      });
    }

    res.status(200).json({ success: true, liked: !alreadyLiked, totalLikes: comment.likes.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= REPLY TO COMMENT =================
export const replyComment = async (req, res) => {
  try {
    // ← NEW — parentReplyId is sent when the user tapped "reply" on a
    // specific reply rather than the top-level comment. There's no
    // actual nested-reply storage (everything still lands in the same
    // comment.replies[] array), but knowing WHICH reply this was aimed
    // at lets us notify that person instead of always notifying the
    // top-level comment's author regardless of who you were replying to.
    const { text, parentReplyId = null } = req.body;
    const { postId, commentId } = req.params;

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const comment = post.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    // ← NEW — resolve who this reply is actually directed at, before
    // pushing the new reply (so we're reading the PRE-existing thread).
    const targetReply = parentReplyId ? comment.replies.id(parentReplyId) : null;
    const targetUserId = targetReply ? targetReply.user : comment.user;

    comment.replies.push({ user: req.user._id, text });
    await post.save();

    await post.populate("comments.replies.user", "username profilePic");

    const updatedComment = post.comments.id(commentId);
    const newReply = updatedComment.replies[updatedComment.replies.length - 1];

    // ✅ scoped emit
    emitToPost(postId, `post:${postId}:newReply`, { commentId, reply: newReply });

    // ← FIXED — notifies whoever you actually replied to (the specific
    // reply's author, if any) instead of unconditionally notifying the
    // top-level comment's author. Previously, replying to someone's reply
    // deep in a thread notified the ORIGINAL commenter again and the
    // person you actually responded to got nothing.
    if (targetUserId.toString() !== req.user._id.toString()) {
      const replier = await User.findById(req.user._id).select("username");
      await createNotification({
        recipientId: targetUserId,
        senderId: req.user._id,
        type: "reply",
        postType: post.postType,
        message: `${replier?.username || "Someone"} replied to your ${targetReply ? "reply" : "comment"}`,
        postId,
        commentId,
        replyId: newReply._id,
        link: `/post/${postId}`,
      });
    }

    res.status(201).json({ success: true, reply: newReply, replies: updatedComment.replies });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= EDIT REPLY =================
export const editReply = async (req, res) => {
  try {
    const { text } = req.body;
    const { postId, commentId, replyId } = req.params;

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const comment = post.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    const reply = comment.replies.id(replyId);
    if (!reply) return res.status(404).json({ success: false, message: "Reply not found" });

    if (reply.user.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: "Unauthorized" });

    reply.text = text;
    reply.isEdited = true;
    await post.save();

    // ✅ scoped emit
    emitToPost(postId, `post:${postId}:replyEdited`, { commentId, replyId, text, isEdited: true });

    res.status(200).json({ success: true, reply });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= DELETE REPLY =================
export const deleteReply = async (req, res) => {
  try {
    const { postId, commentId, replyId } = req.params;

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const comment = post.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    const reply = comment.replies.id(replyId);
    if (!reply) return res.status(404).json({ success: false, message: "Reply not found" });

    if (reply.user.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: "Unauthorized" });

    reply.deleteOne();
    await post.save();

    // ✅ scoped emit
    emitToPost(postId, `post:${postId}:replyDeleted`, { commentId, replyId });

    res.status(200).json({ success: true, message: "Reply deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= LIKE REPLY =================
export const likeReply = async (req, res) => {
  try {
    const { postId, commentId, replyId } = req.params;

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const comment = post.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    const reply = comment.replies.id(replyId);
    if (!reply) return res.status(404).json({ success: false, message: "Reply not found" });

    const alreadyLiked = reply.likes.includes(req.user._id);
    if (alreadyLiked) {
      reply.likes = reply.likes.filter(id => id.toString() !== req.user._id.toString());
    } else {
      reply.likes.push(req.user._id);
    }

    await post.save();

    // ✅ scoped emit
    emitToPost(postId, `post:${postId}:replyLiked`, {
      commentId,
      replyId,
      liked: !alreadyLiked,
      totalLikes: reply.likes.length,
      userId: req.user._id,
    });

    // ← NEW — this never notified anyone before. Liking a top-level
    // comment (likeComment above) already does; liking a reply is the
    // same action one level deeper and was silently skipped.
    if (!alreadyLiked && reply.user.toString() !== req.user._id.toString()) {
      const liker = await User.findById(req.user._id).select("username");
      await createNotification({
        recipientId: reply.user,
        senderId: req.user._id,
        type: "like_reply",
        postType: post.postType,
        message: `${liker?.username || "Someone"} liked your reply`,
        postId,
        commentId,
        replyId,
        link: `/post/${postId}`,
      });
    }

    res.status(200).json({ success: true, liked: !alreadyLiked, totalLikes: reply.likes.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= GET COMMENTS =================
export const getComments = async (req, res) => {
  try {
    const { postId } = req.params;

    const post = await Post.findById(postId)
      .populate("comments.user", "username profilePic")
      .populate("comments.replies.user", "username profilePic")
      .populate("comments.poll.options.votes", "username profilePic");

    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const comments = post.comments.map(c => ({
      ...c.toObject(),
      author: c.user,
      postAuthor: post.author,
    }));

    // Pinned comments first (most recently pinned on top); rest keep order.
    comments.sort((a, b) => {
      if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
      if (a.isPinned && b.isPinned) return new Date(b.pinnedAt || 0) - new Date(a.pinnedAt || 0);
      return 0;
    });

    res.status(200).json({ success: true, comments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= ADD POLL COMMENT =================
export const addCommentPoll = async (req, res) => {
  try {
    const { question, options = [], allowMultiple = true } = req.body;
    const { postId } = req.params;

    const q = (question || "").trim();
    if (!q) return res.status(400).json({ success: false, message: "Poll question is required" });
    if (q.length > 250) return res.status(400).json({ success: false, message: "Question is too long (max 250)" });

    const cleaned = [...new Set((options || []).map((o) => String(o || "").trim()).filter(Boolean))];
    if (cleaned.length < 2) {
      return res.status(400).json({ success: false, message: "A poll needs at least 2 different options" });
    }
    if (cleaned.length > MAX_POLL_OPTIONS) {
      return res.status(400).json({ success: false, message: `A poll can have at most ${MAX_POLL_OPTIONS} options` });
    }

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const isOwner = post.author.toString() === req.user._id.toString();
    if (post.disableComments && !isOwner) {
      return res.status(403).json({ success: false, message: "Comments are turned off for this post" });
    }
    if (POLL_OWNER_ONLY && !isOwner) {
      return res.status(403).json({ success: false, message: "You can only create polls on your own posts" });
    }

    post.comments.push({
      user: req.user._id,
      text: q,
      poll: {
        question: q,
        allowMultiple: allowMultiple !== false,
        options: cleaned.map((text) => ({ text: text.slice(0, 100), votes: [] })),
      },
    });
    await post.save();
    await post.populate("comments.user", "username profilePic");

    const newComment = post.comments[post.comments.length - 1];
    const commentToSend = {
      ...newComment.toObject(),
      author: newComment.user,
      postAuthor: post.author,
    };

    emitToPost(postId, `post:${postId}:newComment`, { comment: commentToSend });

    if (!isOwner) {
      const commenter = await User.findById(req.user._id).select("username");
      await createNotification({
        recipientId: post.author,
        senderId: req.user._id,
        type: "comment",
        postType: post.postType,
        message: `${commenter?.username || "Someone"} added a poll on your post`,
        postId,
        commentId: newComment._id,
        link: `/post/${postId}`,
      });
    }

    res.status(201).json({ success: true, comment: commentToSend });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= VOTE ON A POLL COMMENT =================
// Body: { optionIds: [...] } = the user's FULL selection after this action.
// [] removes the user's vote.
export const voteCommentPoll = async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const { optionIds = [] } = req.body;
    const userId = req.user._id;

    const post = await Post.findById(postId).select("comments._id comments.poll");
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const comment = post.comments.id(commentId);
    if (!comment || !comment.poll) {
      return res.status(404).json({ success: false, message: "Poll not found" });
    }

    const validIds = new Set(comment.poll.options.map((o) => o._id.toString()));
    let chosen = [...new Set((optionIds || []).map(String))].filter((id) => validIds.has(id));
    if (!comment.poll.allowMultiple) chosen = chosen.slice(0, 1);

    const cid = new mongoose.Types.ObjectId(commentId);

    // Atomic updates (no save()) so simultaneous voters can't overwrite
    // each other, and `timestamps: false` so votes don't bump post.updatedAt.
    await Post.updateOne(
      { _id: postId },
      { $pull: { "comments.$[c].poll.options.$[].votes": userId } },
      { arrayFilters: [{ "c._id": cid }], timestamps: false }
    );
    if (chosen.length) {
      await Post.updateOne(
        { _id: postId },
        { $addToSet: { "comments.$[c].poll.options.$[o].votes": userId } },
        {
          arrayFilters: [
            { "c._id": cid },
            { "o._id": { $in: chosen.map((id) => new mongoose.Types.ObjectId(id)) } },
          ],
          timestamps: false,
        }
      );
    }

    const fresh = await Post.findOne({ _id: postId, "comments._id": cid }, { "comments.$": 1 })
      .populate("comments.poll.options.votes", "username profilePic")
      .lean();
    const options = fresh?.comments?.[0]?.poll?.options || [];

    emitToPost(postId, `post:${postId}:commentPollUpdated`, { commentId, options });

    res.status(200).json({ success: true, commentId, options });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= PIN / UNPIN A COMMENT (post owner only) =================
export const pinComment = async (req, res) => {
  try {
    const { postId, commentId } = req.params;

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Only the post owner can pin comments" });
    }

    const comment = post.comments.id(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    const nextPinned = !comment.isPinned;
    if (nextPinned) {
      const pinnedCount = post.comments.filter((c) => c.isPinned).length;
      if (pinnedCount >= MAX_PINNED_COMMENTS) {
        return res.status(400).json({
          success: false,
          message: `You can pin up to ${MAX_PINNED_COMMENTS} comments. Unpin one first.`,
        });
      }
    }
    const pinnedAt = nextPinned ? new Date() : null;

    await Post.updateOne(
      { _id: postId },
      { $set: { "comments.$[c].isPinned": nextPinned, "comments.$[c].pinnedAt": pinnedAt } },
      { arrayFilters: [{ "c._id": new mongoose.Types.ObjectId(commentId) }], timestamps: false }
    );

    emitToPost(postId, `post:${postId}:commentPinned`, { commentId, isPinned: nextPinned, pinnedAt });

    res.status(200).json({ success: true, commentId, isPinned: nextPinned, pinnedAt });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};