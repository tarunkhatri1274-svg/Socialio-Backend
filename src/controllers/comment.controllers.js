import Post from "../models/post/post.model.js";
import User from "../models/user/user.model.js";
import { getIO } from "../config/sockets.js";
import { createNotification } from "./notification.helper.js";

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
      .populate("comments.replies.user", "username profilePic");

    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const comments = post.comments.map(c => ({
      ...c.toObject(),
      author: c.user,
    }));

    res.status(200).json({ success: true, comments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};