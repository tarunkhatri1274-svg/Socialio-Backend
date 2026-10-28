import Post from '../models/post/post.model.js';
import User from '../models/user/user.model.js';
import { getIO, onlineUsers } from '../config/sockets.js';
import { createNotification } from './notification.helper.js';
import { getBlockedIdSets } from '../utils/blockHelper.js';

const REACTION_TYPES = ["like", "love", "haha", "wow", "sad", "angry"];
const REACTION_EMOJI = { like: "👍", love: "❤️", haha: "😆", wow: "😮", sad: "😢", angry: "😡" };

// Build { userId -> reactionType } from a post's likeReactions. A liker with
// no entry (a like made before reactions existed) counts as a plain "like".
const buildReactionMap = (post) => {
  const map = new Map();
  (post.likeReactions || []).forEach((r) => map.set(r.user.toString(), r.type));
  return map;
};

// Attach `reaction` to every populated liker and total up a per-type summary.
const attachReactions = (post) => {
  const map = buildReactionMap(post);
  const counts = {};
  const list = post.likes.map((u) => {
    const obj = u.toObject();
    obj.reaction = map.get(obj._id.toString()) || "like";
    counts[obj.reaction] = (counts[obj.reaction] || 0) + 1;
    return obj;
  });
  return { list, counts };
};

// POST /auth/like/:id   body: { reaction?: "like"|"love"|"haha"|"wow"|"sad"|"angry" }
//   - not reacted yet      -> add the reaction
//   - same reaction again  -> remove it (un-like)
//   - different reaction   -> switch to the new one (still liked)
// `reaction` defaults to "like", so old clients that send no body keep working.
export const toggleLike = async (req, res) => {
  try {
    console.log("LIKE BODY:", req.body, "userId:", req.user.id);
    const postId = req.params.id;
    const userId = req.user.id;

    const reaction = req.body?.reaction ?? "like";
    if (!REACTION_TYPES.includes(reaction)) {
      return res.status(400).json({ success: false, message: "Invalid reaction" });
    }

    const existingPost = await Post.findById(postId).select('likes likeReactions author');
    if (!existingPost) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    // 🚫 Strict block: can't react to a post whose author is blocked either way
    const { hidden } = await getBlockedIdSets(userId);
    if (existingPost.author && existingPost.author.toString() !== userId && hidden.includes(existingPost.author.toString())) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    const alreadyLiked = existingPost.likes.some(id => id.toString() === userId);
    const currentReaction = alreadyLiked
      ? (buildReactionMap(existingPost).get(userId) || "like")
      : null;

    // same reaction tapped again => remove; anything else => add / switch
    const removing = alreadyLiked && currentReaction === reaction;

    // Atomic updates — $addToSet/$pull avoid the read-then-write race that
    // let the same userId get pushed into `likes` twice when two requests
    // (e.g. button tap + double-tap-to-like) landed close together.
    let post;
    if (removing) {
      post = await Post.findByIdAndUpdate(
        postId,
        { $pull: { likes: userId, likeReactions: { user: userId } } },
        { new: true }
      ).populate('author', '_id username');
    } else {
      // drop any previous entry first ($pull and $push on the same array
      // can't share one update), then add the new one.
      await Post.updateOne({ _id: postId }, { $pull: { likeReactions: { user: userId } } });
      post = await Post.findByIdAndUpdate(
        postId,
        {
          $addToSet: { likes: userId },
          $push: { likeReactions: { user: userId, type: reaction } },
        },
        { new: true }
      ).populate('author', '_id username');
    }

    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    const nowLiked = !removing;

    // populate likedBy AND attach mutual-likes info for the response.
    // "Mutual" = does the CURRENT viewer follow this liker? Followed likers
    // are sorted to the front for the "Liked by X and N others" line.
    const populatedPost = await Post.findById(postId)
      .populate('likes', 'username profilePic bio');

    const viewer = await User.findById(userId).select("following");
    const followingIds = new Set((viewer?.following || []).map(id => id.toString()));

    const { list: likedByWithReaction, counts: reactionCounts } = attachReactions({
      likes: populatedPost.likes.filter(u => !hidden.includes(String(u._id))),
      likeReactions: populatedPost.likeReactions,
    });
    const likedByWithMutual = likedByWithReaction.map(obj => ({
      ...obj,
      isFollowedByViewer: followingIds.has(obj._id.toString()),
    }));
    likedByWithMutual.sort(
      (a, b) => (b.isFollowedByViewer ? 1 : 0) - (a.isFollowedByViewer ? 1 : 0)
    );

    const io      = getIO();
    const ownerId = post.author?._id?.toString();

    // real-time notification to post owner — only when someone NEWLY reacts
    // (not when switching reaction or removing).
    if (!alreadyLiked && ownerId && ownerId !== userId) {
      const ownerSocketId = onlineUsers.get(ownerId);
      if (ownerSocketId) {
        io.to(ownerSocketId).emit("receiveNotification", {
          type:      "like",
          reaction,
          from:      userId,
          postId,
          createdAt: new Date(),
        });
      }

      const liker = await User.findById(userId).select("username");
      const who = liker?.username || "Someone";
      await createNotification({
        recipientId: ownerId,
        senderId: userId,
        type: "like_post",
        postType: post.postType,
        message: reaction === "like"
          ? `${who} liked your post`
          : `${who} reacted ${REACTION_EMOJI[reaction]} to your post`,
        postId,
        link: `/post/${postId}`,
      });
    }

    // broadcast live like count + reactions to everyone viewing this post.
    // Not per-viewer sorted (a broadcast has no single viewer); the sorted
    // version below only goes back to the person who just reacted.
    io.to(`post:${postId}`).emit(`post:${postId}:likes`, {
      totalLikes: populatedPost.likes.length,
      liked: nowLiked,
      likedBy: likedByWithReaction,
      reactionCounts,
    });

    return res.status(200).json({
      success:        true,
      liked:          nowLiked,
      reaction:       nowLiked ? reaction : null,
      totalLikes:     populatedPost.likes.length,
      likedBy:        likedByWithMutual,
      reactionCounts,
      message:        removing ? "Reaction removed" : alreadyLiked ? "Reaction updated" : "Post liked",
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

    // 🚫 Strict block: hide the post and drop blocked users from the likers list
    const { hidden } = await getBlockedIdSets(viewerId);
    if (post.author && post.author.toString() !== viewerId.toString() && hidden.includes(post.author.toString())) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }
    const visibleLikes = post.likes.filter(u => !hidden.includes(String(u._id)));

    const viewer = await User.findById(viewerId).select("following");
    const followingIds = new Set((viewer?.following || []).map(id => id.toString()));

    const { list: likedByWithReaction, counts: reactionCounts } = attachReactions({ likes: visibleLikes, likeReactions: post.likeReactions });
    const likedByWithMutual = likedByWithReaction.map(obj => ({
      ...obj,
      isFollowedByViewer: followingIds.has(obj._id.toString()),
    }));

    likedByWithMutual.sort(
      (a, b) => (b.isFollowedByViewer ? 1 : 0) - (a.isFollowedByViewer ? 1 : 0)
    );

    const mutualLikesCount = likedByWithMutual.filter(u => u.isFollowedByViewer).length;

    res.status(200).json({
      success:          true,
      likedBy:          likedByWithMutual,
      totalLikes:       visibleLikes.length,
      reactionCounts,   // e.g. { like: 4, love: 2, haha: 1 }
      mutualLikesCount, // ← how many likers the viewer follows, if you want to show "X mutual" separately
    });

  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};