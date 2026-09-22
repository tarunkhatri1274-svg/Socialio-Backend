// controllers/followlist.controller.js

import User from "../models/user/user.model.js";
import { getIO, onlineUsers } from "../config/sockets.js";

// ── GET FOLLOWERS ──────────────────────────────────────────────────────────
export const getFollowers = async (req, res) => {
  try {
    const { userId }      = req.params;
    const currentUserId   = req.user.id;
    const user = await User.findById(userId)
      .populate("followers", "_id username profilePic");
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    if (user.isPrivate && userId !== currentUserId) {
      const isFollower = user.followers.some((f) => f._id.toString() === currentUserId);
      if (!isFollower)
        return res.status(403).json({ success: false, message: "This account is private" });
    }
    res.status(200).json({ success: true, followers: user.followers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── GET FOLLOWING ──────────────────────────────────────────────────────────
export const getFollowing = async (req, res) => {
  try {
    const { userId }    = req.params;
    const currentUserId = req.user.id;
    const user = await User.findById(userId)
      .populate("following", "_id username profilePic");
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    if (user.isPrivate && userId !== currentUserId) {
      const isFollower = user.followers.some((f) => f.toString() === currentUserId);
      if (!isFollower)
        return res.status(403).json({ success: false, message: "This account is private" });
    }
    res.status(200).json({ success: true, following: user.following });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── GET MUTUAL FOLLOWERS ───────────────────────────────────────────────────
// Returns users who follow BOTH the viewer (currentUser) AND the target (userId).
// This is what "mutual followers" means on Instagram — people both of you follow.
export const getMutualFollowers = async (req, res) => {
  try {
    const { userId }    = req.params;
    const currentUserId = req.user.id;

    if (userId === currentUserId)
      return res.status(200).json({ success: true, mutuals: [], count: 0 });

    const [targetUser, currentUser] = await Promise.all([
      User.findById(userId).select("followers isPrivate"),
      User.findById(currentUserId).select("followers following"),
    ]);

    if (!targetUser) return res.status(404).json({ success: false, message: "User not found" });

    // People the current user follows
    const myFollowingIds = new Set(
      (currentUser.following || []).map((id) => id.toString())
    );

    // People who follow the target user — intersect with who I follow
    const mutualIds = (targetUser.followers || [])
      .map((id) => id.toString())
      .filter((id) => myFollowingIds.has(id) && id !== currentUserId);

    if (mutualIds.length === 0)
      return res.status(200).json({ success: true, mutuals: [], count: 0 });

    const mutuals = await User.find({ _id: { $in: mutualIds } })
      .select("_id username profilePic")
      .limit(6); // cap at 6 for display (Instagram shows "Followed by X, Y and N others")

    res.status(200).json({ success: true, mutuals, count: mutualIds.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};