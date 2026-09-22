// controllers/mute.controllers.js
import User from "../models/user/user.model.js";

// ── Toggle one mute category ("story" | "post" | "message") for a target user
export const toggleMute = async (req, res) => {
  try {
    const currentUserId = req.user._id || req.user.id;
    const targetUserId = req.params.id;
    const { type } = req.body; // "story" | "post" | "message"

    if (!["story", "post", "message"].includes(type)) {
      return res.status(400).json({ success: false, message: "Invalid mute type" });
    }
    if (currentUserId.toString() === targetUserId) {
      return res.status(400).json({ success: false, message: "You cannot mute yourself" });
    }

    const field = type === "story" ? "muteStory" : type === "post" ? "mutePost" : "muteMessage";
    const user = await User.findById(currentUserId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    let entry = user.mutedUsers.find((m) => m.user.toString() === targetUserId);
    if (!entry) {
      user.mutedUsers.push({ user: targetUserId, muteStory: false, mutePost: false, muteMessage: false });
      entry = user.mutedUsers[user.mutedUsers.length - 1];
    }

    entry[field] = !entry[field];

    // Clean up: if nothing muted anymore, drop the entry entirely
    if (!entry.muteStory && !entry.mutePost && !entry.muteMessage) {
      user.mutedUsers = user.mutedUsers.filter((m) => m.user.toString() !== targetUserId);
    }

    await user.save();

    const current = user.mutedUsers.find((m) => m.user.toString() === targetUserId);
    res.status(200).json({
      success: true,
      targetUserId,
      muteStory: current?.muteStory || false,
      mutePost: current?.mutePost || false,
      muteMessage: current?.muteMessage || false,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Full mute map for the current user: { userId: {muteStory, mutePost, muteMessage} }
export const getMutedMap = async (req, res) => {
  try {
    const currentUserId = req.user._id || req.user.id;
    const user = await User.findById(currentUserId).select("mutedUsers");
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const map = {};
    (user.mutedUsers || []).forEach((m) => {
      map[m.user.toString()] = {
        muteStory: m.muteStory,
        mutePost: m.mutePost,
        muteMessage: m.muteMessage,
      };
    });

    res.status(200).json({ success: true, muted: map });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};