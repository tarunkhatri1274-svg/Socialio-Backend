import Post from "../models/post/post.model.js";
import { getIO } from "../config/sockets.js";
import { isPostBlockedFor } from "../utils/blockHelper.js";

// Everything except the heavy fields; isPostBlockedFor still gets what it needs.
const LIGHT_POST = "-comments -likeReactions -shares";

// ================= ADD VIEW (counter only) =================
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

    const updated = await Post.findByIdAndUpdate(
      postId,
      { $inc: { viewsCount: 1 } },
      { new: true, select: "viewsCount" }
    ).lean();

    const totalViews = updated?.viewsCount ?? 0;

    getIO().to(`post:${postId}`).emit(`post:${postId}:views`, { totalViews });

    res.status(200).json({ message: "View added successfully", totalViews });
  } catch (error) {
    console.error("Error adding view:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ================= GET VIEWS COUNT =================
export const getViewsCount = async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user._id || req.user.id;

    const post = await Post.findById(postId).select(LIGHT_POST);
    if (!post) return res.status(404).json({ message: "Post not found" });

    if (await isPostBlockedFor(post, userId)) {
      return res.status(404).json({ message: "Post not found" });
    }

    res.status(200).json({ totalViews: post.viewsCount || 0 });
  } catch (error) {
    console.error("Error fetching views count:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};