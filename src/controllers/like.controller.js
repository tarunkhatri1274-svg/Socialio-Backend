import Post from '../models/post/post.model.js';
import User from '../models/user/user.model.js';
import { getIO, onlineUsers } from '../config/sockets.js';
import { createNotification } from './notification.helper.js';

export const toggleLike = async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    const existingPost = await Post.findById(postId).select('likes author');
    if (!existingPost) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    const alreadyLiked = existingPost.likes.some(id => id.toString() === userId);

    // ── Atomic update — $addToSet/$pull avoid the read-then-write race
    // that let the same userId get pushed into `likes` twice when two
    // like requests (e.g. button tap + double-tap-to-like) landed close
    // together. $addToSet guarantees no duplicate entries even under
    // concurrent requests; $pull is naturally idempotent.
    const post = await Post.findByIdAndUpdate(
      postId,
      alreadyLiked
        ? { $pull: { likes: userId } }
        : { $addToSet: { likes: userId } },
      { new: true }
    ).populate('author', '_id username');

    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    // ── populate likedBy AND attach mutual-likes info for the response.
    // "Mutual" here means: does the CURRENT viewer (the person who just
    // toggled the like) follow this liker? Followed likers are sorted to
    // the front so the frontend's "Liked by X and N others" line
    // naturally surfaces someone the viewer actually knows, the same way
    // it does from getPostLikers below.
    const populatedPost = await Post.findById(postId)
      .populate('likes', 'username profilePic bio');

    const viewer = await User.findById(userId).select("following");
    const followingIds = new Set((viewer?.following || []).map(id => id.toString()));

    const likedByWithMutual = populatedPost.likes.map(u => {
      const obj = u.toObject();
      obj.isFollowedByViewer = followingIds.has(obj._id.toString());
      return obj;
    });
    // Followed-by-viewer likers first, preserving relative order otherwise.
    likedByWithMutual.sort(
      (a, b) => (b.isFollowedByViewer ? 1 : 0) - (a.isFollowedByViewer ? 1 : 0)
    );

    const io      = getIO();
    const ownerId = post.author?._id?.toString();

    // ── real-time notification to post owner ──────────────────────────────
    if (!alreadyLiked && ownerId && ownerId !== userId) {
      const ownerSocketId = onlineUsers.get(ownerId);
      if (ownerSocketId) {
        io.to(ownerSocketId).emit("receiveNotification", {
          type:      "like",
          from:      userId,
          postId,
          createdAt: new Date(),
        });
      }

      const liker = await User.findById(userId).select("username");
      await createNotification({
        recipientId: ownerId,
        senderId: userId,
        type: "like_post",
        postType: post.postType,
        message: `${liker?.username || "Someone"} liked your post`,
        postId,
        link: `/post/${postId}`,
      });
    }

    // ── broadcast live like count to everyone viewing this post ──────────
    // NOTE: likedBy broadcast here is NOT per-viewer sorted (a socket
    // broadcast has no single "viewer"), so every open client applies its
    // own mutual sort locally if it wants one; the sorted version below is
    // only returned in the direct HTTP response to the person who just
    // clicked like.
    io.to(`post:${postId}`).emit(`post:${postId}:likes`, {
      totalLikes: populatedPost.likes.length,
      liked: !alreadyLiked,
      likedBy: populatedPost.likes,
    });

    return res.status(200).json({
      success:    true,
      liked:      !alreadyLiked,
      totalLikes: populatedPost.likes.length,
      likedBy:    likedByWithMutual,
      message:    alreadyLiked ? "Post unliked" : "Post liked",
    });

  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// ================= GET POST LIKERS (with mutual-likes ordering) =================
// Returns everyone who liked the post, with each entry tagged
// `isFollowedByViewer` and the list sorted so people the current viewer
// follows appear FIRST — this is what lets the frontend's
// "Liked by <mutual friend> and N others" summary line, and the likers
// bottom-sheet, surface someone the viewer actually knows at the top
// instead of an arbitrary DB order.
export const getPostLikers = async (req, res) => {
  try {
    const viewerId = req.user._id || req.user.id;

    const post = await Post.findById(req.params.id)
      .populate('likes', 'username profilePic bio');

    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    const viewer = await User.findById(viewerId).select("following");
    const followingIds = new Set((viewer?.following || []).map(id => id.toString()));

    const likedByWithMutual = post.likes.map(u => {
      const obj = u.toObject();
      obj.isFollowedByViewer = followingIds.has(obj._id.toString());
      return obj;
    });

    likedByWithMutual.sort(
      (a, b) => (b.isFollowedByViewer ? 1 : 0) - (a.isFollowedByViewer ? 1 : 0)
    );

    const mutualLikesCount = likedByWithMutual.filter(u => u.isFollowedByViewer).length;

    res.status(200).json({
      success:          true,
      likedBy:          likedByWithMutual,
      totalLikes:       post.likes.length,
      mutualLikesCount, // ← how many likers the viewer follows, if you want to show "X mutual" separately
    });

  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};