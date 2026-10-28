import Post from "../models/post/post.model.js";
import { getIO } from "../config/sockets.js"; // ← matches like.controller.js exactly
import { getBlockedIdSets, isPostBlockedFor } from "../utils/blockHelper.js";

// ================= ADD VIEW =================
export const addView = async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user._id;
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ message: "Post not found" });

    // 🚫 Strict block
    if (await isPostBlockedFor(post, userId)) return res.status(404).json({ message: "Post not found" });

    if (post.views.includes(userId)) {
      // Not an error — just a no-op confirming the view is already recorded
      return res.status(200).json({ message: "Already viewed", totalViews: post.views.length, alreadyViewed: true });
    }

    post.views.push(userId);
    await post.save();

    const io = getIO();
    io.to(`post:${postId}`).emit(`post:${postId}:views`, { totalViews: post.views.length });

    res.status(200).json({ message: "View added successfully", totalViews: post.views.length });
  } catch (error) {
    console.error("Error adding view:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ================= GET VIEWS =================
export const getViews = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await Post.findById(postId).populate("views", "username profilePic bio");
    if (!post) return res.status(404).json({ message: "Post not found" });
    // 🚫 Strict block: hide the list entirely across a block, and drop blocked viewers
    const viewerId = req.user._id || req.user.id;
    if (await isPostBlockedFor(post, viewerId)) return res.status(404).json({ message: "Post not found" });
    const { hidden } = await getBlockedIdSets(viewerId);
    res.status(200).json({ views: post.views.filter((u) => !hidden.includes(String(u._id))) });
  } catch (error) {
    console.error("Error fetching views:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};