import User from "../models/user/user.model.js";
import Post from "../models/post/post.model.js";
import Story from "../models/story/story.model.js";
import Conversation from "../models/messages/conversation.model.js";
import Message from "../models/messages/message.model.js";
import Group from "../models/messages/group.model.js";
import MemoryGroup from "../models/memory/memoryGroup.modal.js";
import MemoryItem from "../models/memory/memoryItem.modal.js";
import Notification from "../models/notifications/notification.model.js";
import NotificationSettings from "../models/notificationsettings/notification.settings.js";
import bcrypt from "bcryptjs";
import generateToken from "../utils/generateToken.js";
import { OAuth2Client } from "google-auth-library";
import { sendOtpEmail, generateOtp } from "../utils/sendEmail.js";
import { getIO, onlineUsers } from "../config/sockets.js";
import { canViewCollabPost } from "./media.controllers.js";
import cloudinary from "../config/cloudinary.js";
import jwt from "jsonwebtoken";
import env from "../services/simpleENV.js";
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── Helper: extract Cloudinary public_id from a URL ───────────────────────
const extractPublicId = (url) => {
  if (!url) return null;
  try {
    const parts = url.split("/");
    const uploadIdx = parts.indexOf("upload");
    if (uploadIdx === -1) return null;
    const afterUpload = parts.slice(uploadIdx + 1);
    if (afterUpload[0]?.startsWith("v") && !isNaN(afterUpload[0].slice(1))) {
      afterUpload.shift();
    }
    const withExt = afterUpload.join("/");
    return withExt.replace(/\.[^/.]+$/, "");
  } catch {
    return null;
  }
};

// ── Helper: destroy a Cloudinary asset safely ─────────────────────────────
const destroyCloudinary = async (url, resourceType = "image") => {
  const publicId = extractPublicId(url);
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (e) {
    console.log("Cloudinary destroy error:", e.message);
  }
};

// ── Helper: destroy a Message.media asset (uses the mediaType enum
// image/video/audio/file, same mapping used everywhere else in the app
// — audio is stored as a Cloudinary "video" resource, "file" as "raw") ──
const destroyMessageMedia = async (media) => {
  if (!media?.url) return;
  const resourceType =
    media.mediaType === "video" ? "video" :
    media.mediaType === "audio" ? "video" :
    media.mediaType === "file"  ? "raw" :
    "image";
  await destroyCloudinary(media.url, resourceType);
};

// ── Helper: destroy a MemoryItem.media asset (only image/video) ──────────
const destroyMemoryItemMedia = async (media) => {
  if (!media?.url) return;
  await destroyCloudinary(media.url, media.type === "video" ? "video" : "image");
};

export const sendOtp = async (req, res) => {
  try {
    const email = req.body.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ message: "Email is required" });

    const existingUser = await User.findOne({ email });

    // ✅ FIX: cooldown was previously missing entirely on this route
    const COOLDOWN_MS = 60 * 1000;
    if (existingUser?.otpLastSentAt && Date.now() - existingUser.otpLastSentAt < COOLDOWN_MS) {
      const waitSec = Math.ceil((COOLDOWN_MS - (Date.now() - existingUser.otpLastSentAt)) / 1000);
      return res.status(429).json({ message: `Please wait ${waitSec}s before requesting a new OTP` });
    }

    const otp = generateOtp();
    const hashedOtp = await bcrypt.hash(otp, 10);
    await User.findOneAndUpdate(
      { email },
      {
        email,
        otp: hashedOtp,
        otpExpires: Date.now() + 5 * 60 * 1000,
        otpLastSentAt: Date.now(),
      },
      { upsert: true, new: true }
    );
    await sendOtpEmail(email, otp);
    res.json({ message: "OTP sent" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const verifyOtp = async (req, res) => {
  try {
    const email = req.body.email?.toLowerCase().trim();
    const { otp } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "User not found" });
    if (!user.otpExpires || Date.now() > user.otpExpires)
      return res.status(400).json({ message: "OTP expired" });
    const isMatch = await bcrypt.compare(otp, user.otp);
    if (!isMatch) return res.status(400).json({ message: "Invalid OTP" });
    await User.updateOne(
      { email },
      {
        $set: {
          isVerified: true,
          isOtpVerified: true,
          // ✅ FIX: also set the reset-scoped flag with its own short expiry,
          // so this OTP verification event can be safely reused later
          // ONLY within the reset-password window it was actually issued for.
          resetOtpVerified: true,
          resetOtpVerifiedExpires: Date.now() + 10 * 60 * 1000, // 10 min window
        },
        $unset: { otp: "", otpExpires: "" },
      }
    );
    res.json({
      _id: user._id,
      email: user.email,
      token: generateToken.generateAccessToken(user._id),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
export const refreshAccessToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(401).json({ success: false, message: "No refresh token" });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, env.refreshtoken);
    } catch (err) {
      return res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ success: false, message: "User not found" });
    }

    const newToken = generateToken.generateAccessToken(user._id);
    res.json({ success: true, token: newToken });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
export const registerUser = async (req, res) => {
  try {
    const email = req.body.email?.toLowerCase().trim();
    const { password } = req.body;
    const username = req.body.username?.toLowerCase().trim();
    const age = Number(req.body.age);
    const gender = req.body.gender?.toLowerCase().trim();

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "Please verify email first" });
    if (!user.isVerified) return res.status(400).json({ message: "Email not verified. Please verify first." });
    if (user.username) return res.status(400).json({ message: "User already registered" });

    // Age validation
    if (!req.body.age || isNaN(age)) {
      return res.status(400).json({ message: "Age is required" });
    }
    if (age < 18) {
      return res.status(403).json({ message: "You are not eligible to use Socialio" });
    }

    // Gender validation
    const allowedGenders = ["male", "female", "other"];
    if (!gender || !allowedGenders.includes(gender)) {
      return res.status(400).json({ message: "Please select a valid gender" });
    }

    // Proactively check username availability
    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return res.status(409).json({ message: "Username already taken. Please choose another." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await User.updateOne(
      { email },
      { $set: { username, password: hashedPassword, age, gender } }
    );
    const updatedUser = await User.findOne({ email });
    res.json({
      token: generateToken.generateAccessToken(updatedUser._id),
      refreshToken: generateToken.generateRefreshToken(updatedUser._id),
      _id: updatedUser._id,
      username: updatedUser.username,
      email: updatedUser.email,
      age: updatedUser.age,
      gender: updatedUser.gender,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Username already taken. Please choose another." });
    }
    res.status(500).json({ message: err.message });
  }
};

export const loginUser = async (req, res) => {
  try {
    const username = req.body.username?.toLowerCase().trim();
    const { password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.password)
      return res.status(400).json({ message: "This account uses Google Sign-In. Please log in with Google." });
    if (!user.isVerified) return res.status(400).json({ message: "Email not verified" });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid password" });
    res.json({
      _id: user._id,
      username: user.username,
      email: user.email,
      token: generateToken.generateAccessToken(user._id),
      refreshToken: generateToken.generateRefreshToken(user._id),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const forgotPassword = async (req, res) => {
  try {
    const email = req.body.email?.toLowerCase().trim();
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    // ✅ FIX: was checking otpExpires (wrong field — an expiry timestamp,
    // not a sent-at timestamp), which effectively blocked resends for ~6
    // minutes instead of the intended 60 seconds.
    const COOLDOWN_MS = 60 * 1000;
    if (user.otpLastSentAt && Date.now() - user.otpLastSentAt < COOLDOWN_MS) {
      const waitSec = Math.ceil((COOLDOWN_MS - (Date.now() - user.otpLastSentAt)) / 1000);
      return res.status(429).json({ message: `Please wait ${waitSec}s before requesting a new OTP` });
    }

    const otp = generateOtp();
    const hashedOtp = await bcrypt.hash(otp, 10);
    user.otp = hashedOtp;
    user.otpExpires = Date.now() + 5 * 60 * 1000;
    user.otpLastSentAt = Date.now();
    // ✅ FIX: clear any stale reset-verification flag before a fresh cycle
    user.resetOtpVerified = false;
    user.resetOtpVerifiedExpires = null;
    await user.save();
    await sendOtpEmail(email, otp);
    res.status(200).json({ message: "OTP sent to email" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const email = req.body.email?.toLowerCase().trim();
    const { newPassword } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    // ✅ FIX: previously checked isOtpVerified, which stays true forever
    // after signup verification — meaning anyone could reset any verified
    // user's password without ever requesting or entering an OTP. Now
    // checks a flow-scoped flag with its own short expiry instead.
    if (
      !user.resetOtpVerified ||
      !user.resetOtpVerifiedExpires ||
      Date.now() > user.resetOtpVerifiedExpires
    ) {
      return res.status(400).json({ message: "OTP not verified. Please verify OTP first." });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    user.resetOtpVerified = false;
    user.resetOtpVerifiedExpires = null;
    user.otp = null;
    user.otpExpires = null;
    await user.save();
    res.json({ message: "Password reset successful" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select("-password")
      .populate("followRequests", "_id username profilePic")
      .populate("followers", "_id")
      .populate("following", "_id");
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.status(200).json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const updateProfile = async (req, res) => {
  try {
    const userId = req.user._id;
    const { username, bio } = req.body;
    const currentUser = await User.findById(userId);
    let updateData = { bio };
    if (username) updateData.username = username.toLowerCase().trim();

    if (req.files?.profilePic) {
      const newUrl = req.files.profilePic[0].path;
      if (currentUser.profilePic && currentUser.profilePic !== newUrl) {
        await destroyCloudinary(currentUser.profilePic, "image");
      }
      updateData.profilePic = newUrl;
    }

    if (req.files?.coverPic) {
      const newUrl = req.files.coverPic[0].path;
      if (currentUser.coverPic && currentUser.coverPic !== newUrl) {
        await destroyCloudinary(currentUser.coverPic, "image");
      }
      updateData.coverPic = newUrl;
    }

    const updatedUser = await User.findByIdAndUpdate(userId, updateData, { new: true }).select("-password");

    const io = getIO();
    io.to(`user:${userId}`).emit("profileUpdated", {
      userId: userId.toString(),
      profilePic: updatedUser.profilePic,
      coverPic:   updatedUser.coverPic,
      username:   updatedUser.username,
      bio:        updatedUser.bio,
    });

    res.status(200).json({ success: true, user: updatedUser });
  } catch (error) {
    res.status(500).json({ success: false, message: "Profile update failed" });
  }
};

export const changePassword = async (req, res) => {
  try {
    const userId = req.user._id;
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ message: "All fields are required" });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.password)
      return res.status(400).json({ message: "This account uses Google Sign-In and has no password set" });
    const ismatch = await bcrypt.compare(currentPassword, user.password);
    if (!ismatch) return res.status(400).json({ message: "Current password is incorrect" });
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ message: "Password changed successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// DELETE ACCOUNT — full cascade
//
// Order of cleanup (each step destroys its own Cloudinary assets BEFORE
// deleting the owning Mongo docs, so nothing is ever orphaned in storage
// even if the process crashes mid-way through a later step):
//   1. Posts (+ their media)
//   2. Post references from other people's docs (comments/likes/etc.)
//   3. Stories (+ their media) and references from other people's docs
//   4. Profile / cover pics
//   5. Memories: MemoryItems (+ their media) and MemoryGroups
//   6. Groups: user exits every group they're in (same rule as
//      exitGroup()) — group + its messages/media are wiped only if that
//      leaves the group with zero accepted members; otherwise a "left
//      the group" system message is posted and admin role is handed off
//      exactly like the normal exit flow.
//   7. 1:1 messages: media destroyed for BOTH sent AND received media
//      (previously only messages the user SENT were checked, so media
//      other people sent TO the deleted user was never destroyed even
//      though its message doc was being deleted).
//   8. Conversations, notifications, notification settings.
//   9. Pull this user's id out of everyone else's followers/following/
//      followRequests/blockedUsers/savedPosts arrays.
// ═══════════════════════════════════════════════════════════════════════
export const deleteAccount = async (req, res) => {
  try {
    const username = req.body.username?.toLowerCase().trim();
    const { password } = req.body;

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.password)
      return res.status(400).json({ message: "This account uses Google Sign-In and has no password set" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid credentials" });

    const userId = user._id;

    // ── 1 & 2. Posts ──────────────────────────────────────────────────
    const posts = await Post.find({ author: userId });
    for (const post of posts) {
      for (const media of post.media || []) {
        if (media.url) {
          const resourceType = media.type === "video" ? "video" : "image";
          await destroyCloudinary(media.url, resourceType);
        }
      }
    }
    await Post.deleteMany({ author: userId });

    await Post.updateMany(
      { "collaborators.user": userId },
      { $pull: { collaborators: { user: userId } } }
    );

    await Post.updateMany(
      { "comments.user": userId },
      { $pull: { comments: { user: userId } } }
    );
    await Post.updateMany(
      { "comments.replies.user": userId },
      { $pull: { "comments.$[].replies": { user: userId } } }
    );
    await Post.updateMany(
      { "comments.likes": userId },
      { $pull: { "comments.$[].likes": userId } }
    );
    await Post.updateMany(
      { "comments.replies.likes": userId },
      { $pull: { "comments.$[].replies.$[].likes": userId } }
    );
    await Post.updateMany(
      {},
      {
        $pull: {
          likes: userId,
          notInterested: userId,
          savedBy: userId,
          mentions: userId,
          views: userId,
          shares: { user: userId },
        },
      }
    );

    // ── 3. Stories ───────────────────────────────────────────────────
    const stories = await Story.find({ author: userId });
    for (const story of stories) {
      if (story.media?.url) {
        const resourceType = story.media.type === "video" ? "video" : "image";
        await destroyCloudinary(story.media.url, resourceType);
      }
    }
    await Story.deleteMany({ author: userId });

    await Story.updateMany(
      {},
      {
        $pull: {
          likes: userId,
          reactions: { user: userId },
          views: { user: userId },
          comments: { user: userId },
        },
      }
    );

    // ── 4. Profile / cover pics ──────────────────────────────────────
    if (user.profilePic) await destroyCloudinary(user.profilePic, "image");
    if (user.coverPic)   await destroyCloudinary(user.coverPic,   "image");

    // ── 5. Memories (Highlights) — was completely missing before ─────
    const memoryItems = await MemoryItem.find({ author: userId });
    for (const item of memoryItems) {
      await destroyMemoryItemMedia(item.media);
    }
    await MemoryItem.deleteMany({ author: userId });
    await MemoryGroup.deleteMany({ author: userId });

    // ── 6. Groups — was completely missing before ────────────────────
    const myGroups = await Group.find({ "members.user": userId });
    for (const group of myGroups) {
      const member = group.members.find((m) => m.user.toString() === userId.toString());
      if (!member) continue;

      const wasAcceptedAdmin = member.status === "accepted" && member.role === "admin";
      member.status = "declined";
      member.leftAt = new Date();

      if (wasAcceptedAdmin) {
        const remainingAccepted = group.members.filter(
          (m) => m.status === "accepted" && m.user.toString() !== userId.toString()
        );
        const hasOtherAdmin = remainingAccepted.some((m) => m.role === "admin");
        if (!hasOtherAdmin && remainingAccepted.length > 0) {
          const next = remainingAccepted.sort(
            (a, b) => new Date(a.joinedAt || 0) - new Date(b.joinedAt || 0)
          )[0];
          const nextMember = group.members.find((m) => m.user.toString() === next.user.toString());
          if (nextMember) nextMember.role = "admin";
        }
      }

      const stillHasMembers = group.members.some((m) => m.status === "accepted");

      if (!stillHasMembers) {
        // No accepted members left — safe to fully wipe the group,
        // its messages, and their Cloudinary media.
        const groupMessages = await Message.find({ chatId: group.chatId });
        for (const gm of groupMessages) await destroyMessageMedia(gm.media);
        await Message.deleteMany({ chatId: group.chatId });
        await Group.deleteOne({ _id: group._id });
      } else {
        await group.save();
        try {
          const sysMsg = await Message.create({
            chatId: group.chatId,
            group: group._id,
            isSystem: true,
            text: `${user.username || "Someone"} left the group`,
          });
          group.lastMessageAt = sysMsg.createdAt;
          group.lastMessageText = sysMsg.text;
          await group.save();

          const io = getIO();
          group.members.forEach((m) => {
            if (m.status !== "accepted") return;
            const sid = onlineUsers.get(m.user.toString());
            if (sid) {
              io.to(sid).emit("groupMemberLeft", {
                chatId: group.chatId,
                user: { _id: userId, username: user.username },
                message: sysMsg,
              });
            }
          });
        } catch (e) {
          console.error("Group exit system message failed:", e.message);
        }
      }
    }

    // ── 7. 1:1 messages — now destroys media on BOTH sides ───────────
    const userMessages = await Message.find({ $or: [{ user: userId }, { to: userId }] });
    for (const msg of userMessages) {
      await destroyMessageMedia(msg.media);
    }
    await Message.deleteMany({ $or: [{ user: userId }, { to: userId }] });

    // ── 8. Conversations / notifications ──────────────────────────────
    await Conversation.updateMany(
      { members: userId },
      { $pull: { members: userId, clearedFor: userId } }
    );
    await Conversation.deleteMany({
      $or: [{ members: { $size: 0 } }, { members: { $size: 1 } }],
    });

    await Notification.deleteMany({
      $or: [{ recipient: userId }, { sender: userId }],
    });

    await NotificationSettings.deleteOne({ user: userId });

    // ── 9. Strip this user's id out of everyone else's arrays ────────
    await User.updateMany(
      {},
      {
        $pull: {
          followers:      userId,
          following:      userId,
          followRequests: userId,
          blockedUsers:   userId,
          recentSearches: { user: userId }, 
          savedPosts:     { $in: posts.map((p) => p._id) },
        },
      }
    );

    try {
      const io = getIO();
      const followerIds = (user.followers || []).map((id) => id.toString());
      followerIds.forEach((fid) => {
        const sid = onlineUsers.get(fid);
        if (sid) io.to(sid).emit("userAccountDeleted", { userId: userId.toString() });
      });
    } catch {}

    await user.deleteOne();

    res.json({ message: "Account deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const searchUsers = async (req, res) => {
  try {
    const query = req.query.q || req.query.query;
    if (!query) return res.json({ users: [] });
    const users = await User.find({ username: { $regex: query, $options: "i" } })
      .select("username profilePic bio isPrivate");
    res.json({ users });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
// ── RECENT SEARCHES ────────────────────────────────────────────────────────
const RECENT_SEARCH_MAX = 15;

export const getRecentSearches = async (req, res) => {
  try {
    const me = await User.findById(req.user.id)
      .select("recentSearches blockedUsers")
      .populate("recentSearches.user", "_id username profilePic bio isPrivate");
    if (!me) return res.status(404).json({ success: false, message: "User not found" });

    const blocked = new Set((me.blockedUsers || []).map((id) => id.toString()));
    const users = (me.recentSearches || [])
      .map((r) => r.user)
      .filter((u) => u && !blocked.has(u._id.toString())); // drops deleted + blocked users

    res.status(200).json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const addRecentSearch = async (req, res) => {
  try {
    const me = req.user.id;
    const targetId = req.params.id;
    if (me === targetId) return res.status(200).json({ success: true });

    const exists = await User.exists({ _id: targetId });
    if (!exists) return res.status(404).json({ success: false, message: "User not found" });

    // remove any old entry first so it moves to the top (Mongo can't $pull and $push the same field in one update)
    await User.updateOne({ _id: me }, { $pull: { recentSearches: { user: targetId } } });
    await User.updateOne(
      { _id: me },
      {
        $push: {
          recentSearches: {
            $each: [{ user: targetId, searchedAt: new Date() }],
            $position: 0,
            $slice: RECENT_SEARCH_MAX,
          },
        },
      }
    );

    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const removeRecentSearch = async (req, res) => {
  try {
    await User.updateOne(
      { _id: req.user.id },
      { $pull: { recentSearches: { user: req.params.id } } }
    );
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const clearRecentSearches = async (req, res) => {
  try {
    await User.updateOne({ _id: req.user.id }, { $set: { recentSearches: [] } });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
export const getUserById = async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await User.findById(userId)
      .select("-password -otp -otpExpires")
      .populate("followRequests", "_id")
      .populate("followers", "_id")
      .populate("following", "_id");
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    const currentUser = await User.findById(req.user.id).select("blockedUsers following");
    const isBlockedByMe = currentUser?.blockedUsers?.some((id) => id.toString() === userId) ?? false;

    const isFollowedByMe = (currentUser?.following ?? []).some(
      (id) => id.toString() === userId
    );

    const followRequestPending = (user.followRequests ?? []).some(
      (id) => (id._id ?? id).toString() === req.user.id.toString()
    );

    res.status(200).json({
      success: true,
      user: { ...user.toObject(), isBlockedByMe, isFollowedByMe, followRequestPending },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPostsByUserId = async (req, res) => {
  try {
    const { userId } = req.params;
    const viewerId = req.user._id;
    const [ownPosts, collabPosts] = await Promise.all([
      Post.find({ author: userId })
        .populate("author", "username profilePic")
        .populate("comments.user", "username profilePic")
        .populate("comments.replies.user", "username profilePic")
        .populate("collaborators.user", "username profilePic")
        .sort({ createdAt: -1 }),
      Post.find({
        author: { $ne: userId },
        collaborators: { $elemMatch: { user: userId, status: "accepted" } },
      })
        .populate("author", "username profilePic isPrivate followers")
        .populate("comments.user", "username profilePic")
        .populate("comments.replies.user", "username profilePic")
        .populate("collaborators.user", "username profilePic")
        .sort({ createdAt: -1 }),
    ]);
    const visibleCollabPosts = [];
    for (const post of collabPosts) {
      const allowed = await canViewCollabPost(post, viewerId, userId);
      if (allowed) visibleCollabPosts.push(post);
    }
    const merged = [...ownPosts, ...visibleCollabPosts].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    const postsWithStatus = merged.map((post) => ({
      ...post.toObject(),
      isNotInterested: post.notInterested?.some((id) => id.toString() === viewerId.toString()),
      isCollab: post.author._id.toString() !== userId.toString(),
    }));
    res.json({ success: true, posts: postsWithStatus });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
// ── GET SINGLE POST BY ID ─────────────────────────────────────────────────
// Used by the feed cards (Home/Explore/ExploreReels) to refresh a single
// post's collaborators (and other fields) on mount without refetching the
// whole feed. Populates the same fields the feed list queries do.
export const getPostById = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await Post.findById(postId)
      .populate("author", "username profilePic isPrivate")
      .populate("comments.user", "username profilePic")
      .populate("comments.replies.user", "username profilePic")
      .populate("collaborators.user", "username profilePic");

    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    res.status(200).json({ success: true, post });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
export const followUser = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const targetUserId  = req.params.id;
    if (currentUserId === targetUserId)
      return res.status(400).json({ success: false, message: "You cannot follow yourself" });
    const currentUser = await User.findById(currentUserId);
    const targetUser  = await User.findById(targetUserId);
    if (!currentUser || !targetUser)
      return res.status(404).json({ success: false, message: "User not found" });

    // ✅ FIX: previously nothing stopped following across a block in either
    // direction, even though blockUser explicitly severs the relationship.
    const iBlockedThem = (currentUser.blockedUsers ?? []).some((id) => id.toString() === targetUserId);
    const theyBlockedMe = (targetUser.blockedUsers ?? []).some((id) => id.toString() === currentUserId);
    if (iBlockedThem || theyBlockedMe) {
      return res.status(403).json({ success: false, message: "You cannot follow this user" });
    }

    if (currentUser.following.includes(targetUserId))
      return res.status(400).json({ success: false, message: "You are already following this user" });

    if (targetUser.isPrivate) {
      const alreadyRequested = (targetUser.followRequests ?? []).some(
        (id) => id.toString() === currentUserId
      );
      if (alreadyRequested)
        return res.status(400).json({ success: false, message: "Follow request already sent" });
      targetUser.followRequests = [...(targetUser.followRequests ?? []), currentUserId];
      await targetUser.save();

      const io = getIO();
      const targetSocketId = onlineUsers.get(targetUserId.toString());

      if (targetSocketId) {
        io.to(targetSocketId).emit("newFollowRequest", { fromUserId: currentUserId });
        const updatedTarget = await User.findById(targetUserId)
          .select("followRequests")
          .populate("followRequests", "_id username profilePic");
        io.to(targetSocketId).emit("followRequestsList", { requests: updatedTarget.followRequests });
      }
      io.to(`user:${targetUserId}`).emit("followRequested", { fromUserId: currentUserId, toUserId: targetUserId });

      return res.status(200).json({ success: true, message: "Follow request sent", requested: true });
    }

    currentUser.following.push(targetUserId);
    targetUser.followers.push(currentUserId);
    await Promise.all([currentUser.save(), targetUser.save()]);

    const io = getIO();
    const targetSocketId = onlineUsers.get(targetUserId.toString());
    if (targetSocketId) {
      io.to(targetSocketId).emit("newFollower", { fromUserId: currentUserId });
    }
    io.to(`user:${targetUserId}`).emit("userFollowed", { fromUserId: currentUserId, toUserId: targetUserId });

    const updatedTarget = await User.findById(targetUserId)
      .select("followers")
      .populate("followers", "_id username profilePic");
    io.to(`user:${targetUserId}`).emit("followersList", {
      userId: targetUserId,
      followers: updatedTarget.followers,
    });

    const updatedCurrent = await User.findById(currentUserId)
      .select("following")
      .populate("following", "_id username profilePic");
    io.to(`user:${currentUserId}`).emit("followingList", {
      userId: currentUserId,
      following: updatedCurrent.following,
    });

    res.status(200).json({ success: true, message: "User followed successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const unfollowUser = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const targetUserId  = req.params.id;
    const currentUser = await User.findById(currentUserId);
    const targetUser  = await User.findById(targetUserId);
    if (!currentUser || !targetUser)
      return res.status(404).json({ success: false, message: "User not found" });
    currentUser.following = currentUser.following.filter((id) => id.toString() !== targetUserId);
    targetUser.followers  = targetUser.followers.filter((id) => id.toString() !== currentUserId);
    await Promise.all([currentUser.save(), targetUser.save()]);

    const io = getIO();
    io.to(`user:${targetUserId}`).emit("userUnfollowed", { fromUserId: currentUserId, toUserId: targetUserId });

    const updatedTarget = await User.findById(targetUserId)
      .select("followers")
      .populate("followers", "_id username profilePic");
    io.to(`user:${targetUserId}`).emit("followersList", {
      userId: targetUserId,
      followers: updatedTarget.followers,
    });

    const updatedCurrent = await User.findById(currentUserId)
      .select("following")
      .populate("following", "_id username profilePic");
    io.to(`user:${currentUserId}`).emit("followingList", {
      userId: currentUserId,
      following: updatedCurrent.following,
    });

    res.status(200).json({ success: true, message: "User unfollowed successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const blockUser = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const targetUserId  = req.params.id;
    if (currentUserId === targetUserId)
      return res.status(400).json({ success: false, message: "You cannot block yourself" });
    const currentUser = await User.findById(currentUserId);
    const targetUser  = await User.findById(targetUserId);
    if (!currentUser || !targetUser)
      return res.status(404).json({ success: false, message: "User not found" });
    if (currentUser.blockedUsers?.includes(targetUserId))
      return res.status(400).json({ success: false, message: "User is already blocked" });
    currentUser.following = currentUser.following.filter((id) => id.toString() !== targetUserId);
    currentUser.followers = currentUser.followers.filter((id) => id.toString() !== targetUserId);
    targetUser.following  = targetUser.following.filter((id)  => id.toString() !== currentUserId);
    targetUser.followers  = targetUser.followers.filter((id)  => id.toString() !== currentUserId);
    currentUser.followRequests = (currentUser.followRequests ?? []).filter((id) => id.toString() !== targetUserId);
    targetUser.followRequests  = (targetUser.followRequests ?? []).filter((id)  => id.toString() !== currentUserId);
    if (!currentUser.blockedUsers) currentUser.blockedUsers = [];
    currentUser.blockedUsers.push(targetUserId);
    await Promise.all([currentUser.save(), targetUser.save()]);
    res.status(200).json({ success: true, message: "User blocked successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const unblockUser = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const targetUserId  = req.params.id;
    const currentUser   = await User.findById(currentUserId);
    if (!currentUser) return res.status(404).json({ success: false, message: "User not found" });
    if (!currentUser.blockedUsers?.includes(targetUserId))
      return res.status(400).json({ success: false, message: "User is not blocked" });
    currentUser.blockedUsers = currentUser.blockedUsers.filter((id) => id.toString() !== targetUserId);
    await currentUser.save();
    res.status(200).json({ success: true, message: "User unblocked successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getBlockedUsers = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("blockedUsers", "username profilePic");
    res.status(200).json({ success: true, blockedUsers: user.blockedUsers ?? [] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getPublicReels = async (req, res) => {
  try {
    const currentUserId = req.user._id || req.user.id;
    const currentUser   = await User.findById(currentUserId).select("blockedUsers following");
    const blockedIds    = (currentUser?.blockedUsers || []).map((id) => id.toString());
    const followingIds  = (currentUser?.following || []).map((id) => id.toString());
    const publicUsers   = await User.find({ isPrivate: false }).select("_id");
    const publicUserIds = publicUsers.map((u) => u._id);
    const reels = await Post.find({
      author: { $in: publicUserIds },
      postType: "video",
      notInterested: { $nin: [currentUserId] },
      $or: [
        { isHiddenFromNonFollowers: false },
        { isHiddenFromNonFollowers: true, author: { $in: followingIds } },
        { author: currentUserId },
      ],
    })
      .populate("author", "username profilePic isPrivate followers following blockedUsers")
      .populate("collaborators.user", "username profilePic")
      .populate("comments.user", "username profilePic")
      .populate("comments.replies.user", "username profilePic")
      .sort({ createdAt: -1 });
    const filteredReels = reels.filter((reel) => {
      const authorId = reel.author?._id?.toString();
      if (!authorId) return false;
      if (blockedIds.includes(authorId)) return false;
      return true;
    });
    res.json({ success: true, reels: filteredReels });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch reels" });
  }
};

export const resendOtp = async (req, res) => {
  try {
    const email = req.body.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ message: "Email is required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const COOLDOWN_MS = 60 * 1000;
    if (user.otpLastSentAt && Date.now() - user.otpLastSentAt < COOLDOWN_MS) {
      const waitSec = Math.ceil((COOLDOWN_MS - (Date.now() - user.otpLastSentAt)) / 1000);
      return res.status(429).json({ message: `Please wait ${waitSec}s before requesting a new OTP` });
    }

    const otp = generateOtp();
    const hashedOtp = await bcrypt.hash(otp, 10);

    user.otp = hashedOtp;
    user.otpExpires = Date.now() + 5 * 60 * 1000;
    user.otpLastSentAt = Date.now();
    await user.save();

    await sendOtpEmail(email, otp);

    res.status(200).json({ message: "OTP resent successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Shared: verify the Google ID token and return its payload ────────────
const verifyGoogleToken = async (idToken) => {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload();
};

// ── SIGNUP via Google ──────────────────────────────────────────────────
export const googleSignup = async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ message: "idToken is required" });

    const payload = await verifyGoogleToken(idToken);
    const email = payload.email?.toLowerCase().trim();
    const { sub } = payload;

    let user = await User.findOne({ email });

    if (user && user.username && user.password) {
      if (!user.googleId) {
        user.googleId = sub;
        await user.save();
      }
      const token = generateToken.generateAccessToken(user._id);
      const refreshToken = generateToken.generateRefreshToken(user._id);
      return res.json({
        registered: true,
        token,
        refreshToken,
        _id: user._id,
        username: user.username,
        email: user.email,
        profilePic: user.profilePic,
      });
    }

    user = await User.findOneAndUpdate(
      { email },
      { email, isVerified: true, googleId: sub },
      { upsert: true, new: true }
    );

    return res.json({
      registered: false,
      email: user.email,
      message: "Email verified via Google. Please finish creating your account.",
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Google Signup Failed" });
  }
};

// ── LOGIN via Google ──────────────────────────────────────────────────
export const googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ message: "idToken is required" });

    const payload = await verifyGoogleToken(idToken);
    const email = payload.email?.toLowerCase().trim();
    const sub = payload.sub;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        message: "No account found with this email. Please register first.",
        notRegistered: true,
      });
    }

    if (!user.username || !user.isVerified || !user.password) {
      return res.status(400).json({
        message: "Registration incomplete. Please finish creating your account.",
        notRegistered: true,
        email: user.email,
      });
    }

    if (!user.googleId) {
      user.googleId = sub;
      await user.save();
    }

    const token = generateToken.generateAccessToken(user._id);
    const refreshToken = generateToken.generateRefreshToken(user._id);

    res.json({
      token,
      refreshToken,
      _id: user._id,
      username: user.username,
      email: user.email,
      profilePic: user.profilePic,
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Google Login Failed" });
  }
};

export const logoutUser = async (req, res) => {
  try {
    const userId = req.user?._id?.toString() || req.user?.id;
    if (userId) {
      try {
        const io = getIO();
        const socketId = onlineUsers.get(userId);
        if (socketId) {
          io.to(socketId).emit("forceLogout");
          onlineUsers.delete(userId);
        }
      } catch {}
    }
    res.status(200).json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

