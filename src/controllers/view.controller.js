import Post from "../models/post/post.model.js";
import { getIO } from "../config/sockets.js";
import { getBlockedIdSets, isPostBlockedFor } from "../utils/blockHelper.js";

// Everything EXCEPT the heavy fields, so isPostBlockedFor() still gets every
// field it could need (author, collaborators, visibility, mentions...).
const LIGHT_POST = "-comments -likeReactions -shares";

// ================= ADD VIEW =================
export const addView = async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user._id || req.user.id;

    const post = await Post.findById(postId).select(LIGHT_POST);
    if (!post) return res.status(404).json({ message: "Post not found" });

    // 🚫 Strict block (same as before)
    if (await isPostBlockedFor(post, userId)) {
      return res.status(404).json({ message: "Post not found" });
    }

    const alreadyViewed = post.views.some((v) => String(v) === String(userId));

    if (alreadyViewed) {
      return res.status(200).json({
        message: "Already viewed",
        totalViews: post.views.length,
        alreadyViewed: true,
      });
    }

    // $addToSet = atomic, no duplicates, no full document save()
    const updated = await Post.findByIdAndUpdate(
      postId,
      { $addToSet: { views: userId } },
      { new: true, select: "views" }
    ).lean();

    const totalViews = updated?.views?.length ?? post.views.length + 1;

    getIO().to(`post:${postId}`).emit(`post:${postId}:views`, { totalViews });

    res.status(200).json({ message: "View added successfully", totalViews });
  } catch (error) {
    console.error("Error adding view:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ================= GET VIEWS COUNT (lightweight, used by the app) =================
export const getViewsCount = async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user._id || req.user.id;

    const post = await Post.findById(postId).select(LIGHT_POST);
    if (!post) return res.status(404).json({ message: "Post not found" });

    // 🚫 Blocked users get 404, same as addView
    if (await isPostBlockedFor(post, userId)) {
      return res.status(404).json({ message: "Post not found" });
    }

    res.status(200).json({ totalViews: post.views.length });
  } catch (error) {
    console.error("Error fetching views count:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ================= GET VIEWS (viewers list - app no longer calls this) =================
export const getViews = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await Post.findById(postId).populate("views", "username profilePic bio");
    if (!post) return res.status(404).json({ message: "Post not found" });
    const viewerId = req.user._id || req.user.id;
    if (await isPostBlockedFor(post, viewerId)) return res.status(404).json({ message: "Post not found" });
    const { hidden } = await getBlockedIdSets(viewerId);
    res.status(200).json({ views: post.views.filter((u) => !hidden.includes(String(u._id))) });
  } catch (error) {
    console.error("Error fetching views:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};