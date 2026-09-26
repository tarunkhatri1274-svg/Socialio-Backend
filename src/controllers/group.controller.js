import mongoose from "mongoose";
import Group from "../models/messages/group.model.js";
import Message from "../models/messages/message.model.js";
import User from "../models/user/user.model.js";
import { getIO, onlineUsers } from "../config/sockets.js";
import { createNotification } from "./notification.helper.js";
import { sendPushToUser } from "../utils/pushNotification.js";
import cloudinary from "../config/cloudinary.js";

const GROUP_PREFIX = "group_";

// Kept in sync with THREE_DAYS_MS in message.controllers.js / jobs/expire.media.js
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────
// Helper: broadcast to every ACCEPTED member currently online, optionally
// skipping one user id (usually the actor who triggered the event).
// ─────────────────────────────────────────────────────────────────────────
const emitToGroupMembers = (group, event, payload, { skip } = {}) => {
  const io = getIO();
  group.members.forEach((m) => {
    if (m.status !== "accepted") return;
    if (skip && m.user.toString() === skip.toString()) return;
    const sid = onlineUsers.get(m.user.toString());
    if (sid) io.to(sid).emit(event, payload);
  });
};

const pushGroupCounts = async (userId) => {
  const io = getIO();
  const sid = onlineUsers.get(userId.toString());
  if (!sid) return;
  const requestCount = await Group.countDocuments({
    members: { $elemMatch: { user: userId, status: "pending" } },
  });
  io.to(sid).emit("groupInboxCounts", { groupRequestCount: requestCount });
};

// ── Cloudinary cleanup — same shape as message.controllers.js's version ──
async function destroyCloudinaryAsset(media) {
  try {
    if (!media?.url) return;
    const urlParts = media.url.split("/");
    const uploadIndex = urlParts.indexOf("upload");
    if (uploadIndex === -1) return;
    const publicIdWithExtension = urlParts.slice(uploadIndex + 2).join("/");
    const publicId = publicIdWithExtension.replace(/\.[^/.]+$/, "");

    const mediaType = media.mediaType;
    const resourceType =
      mediaType === "image" ? "image" :
      mediaType === "video" ? "video" :
      mediaType === "audio" ? "video" :
      "raw";

    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error("Cloudinary delete failed (group):", err.message);
  }
}

// ── Create a group + invite the initial member list ────────────────────
export const createGroup = async (req, res) => {
  try {
    const creatorId = req.user._id;
    const { name, memberIds = [] } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Group name is required" });
    }

    const uniqueMemberIds = [...new Set((memberIds || []).map(String))].filter(
      (id) => id !== creatorId.toString()
    );

    if (uniqueMemberIds.length === 0) {
      return res.status(400).json({ success: false, message: "Add at least one member" });
    }

    const groupId = new mongoose.Types.ObjectId();
    const chatId = `${GROUP_PREFIX}${groupId.toString()}`;

    const members = [
      { user: creatorId, status: "accepted", role: "admin", joinedAt: new Date(), invitedBy: creatorId },
      ...uniqueMemberIds.map((id) => ({
        user: id,
        status: "pending",
        role: "member",
        invitedBy: creatorId,
      })),
    ];

    const group = await Group.create({
      _id: groupId,
      chatId,
      name: name.trim(),
      creator: creatorId,
      members,
      lastMessageText: "",
    });

    const creator = await User.findById(creatorId).select("username");

    const sysMsg = await Message.create({
      chatId,
      group: group._id,
      isSystem: true,
      text: `${creator?.username || "Someone"} created the group "${group.name}"`,
    });
    group.lastMessageAt = sysMsg.createdAt;
    group.lastMessageText = sysMsg.text;
    await group.save();

    const io = getIO();
    for (const id of uniqueMemberIds) {
      const sid = onlineUsers.get(id.toString());
      if (sid) {
        io.to(sid).emit("groupInviteReceived", {
          chatId,
          groupId: group._id,
          name: group.name,
          invitedBy: { _id: creatorId, username: creator?.username },
        });
      }
      await pushGroupCounts(id);
      await createNotification({
        recipientId: id,
        senderId: creatorId,
        type: "group_invite",
        message: `${creator?.username || "Someone"} added you to the group "${group.name}"`,
        chatId,
        link: `/messages/${chatId}`,
      });
    }

    const populated = await Group.findById(group._id).populate(
      "members.user",
      "username profilePic isPrivate"
    );

    res.status(201).json({ success: true, group: populated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ── Invite / add more members to an existing group ─────────────────────
// ANY accepted member can add people — not just admins.
export const inviteToGroup = async (req, res) => {
  try {
    const userId = req.user._id;
    const { chatId } = req.params;
    const { memberIds = [] } = req.body;

    const group = await Group.findOne({ chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });
    if (!group.isAcceptedMember(userId)) {
      return res.status(403).json({ success: false, message: "You are not a member of this group" });
    }

    // A previously-declined/left member re-added should go back to pending,
    // not be silently skipped as "already a member".
    const activeIds = new Set(
      group.members.filter((m) => m.status !== "declined").map((m) => m.user.toString())
    );
    const toAdd = [...new Set((memberIds || []).map(String))].filter((id) => !activeIds.has(id));
    const toReinvite = group.members.filter(
      (m) => m.status === "declined" && (memberIds || []).map(String).includes(m.user.toString())
    );

    if (toAdd.length === 0 && toReinvite.length === 0) {
      return res.status(400).json({ success: false, message: "No new members to add" });
    }

    toAdd.forEach((id) => {
      group.members.push({ user: id, status: "pending", role: "member", invitedBy: userId });
    });
    toReinvite.forEach((m) => {
      m.status = "pending";
      m.invitedBy = userId;
      m.leftAt = null;
    });
    await group.save();

    const allNewIds = [...toAdd, ...toReinvite.map((m) => m.user.toString())];
    const actor = await User.findById(userId).select("username");
    const io = getIO();
    for (const id of allNewIds) {
      const sid = onlineUsers.get(id.toString());
      if (sid) {
        io.to(sid).emit("groupInviteReceived", {
          chatId,
          groupId: group._id,
          name: group.name,
          invitedBy: { _id: userId, username: actor?.username },
        });
      }
      await pushGroupCounts(id);
      await createNotification({
        recipientId: id,
        senderId: userId,
        type: "group_invite",
        message: `${actor?.username || "Someone"} added you to the group "${group.name}"`,
        chatId,
        link: `/messages/${chatId}`,
      });
    }

    res.status(200).json({ success: true, addedCount: allNewIds.length });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ── Pending group invites for the current user ─────────────────────────
export const getGroupRequests = async (req, res) => {
  try {
    const userId = req.user._id;
    const groups = await Group.find({
      members: { $elemMatch: { user: userId, status: "pending" } },
    })
      .populate("members.user", "username profilePic")
      .populate("creator", "username profilePic")
      .sort({ lastMessageAt: -1 })
      .lean();

    const requests = groups.map((g) => {
      const me = g.members.find((m) => m.user._id.toString() === userId.toString());
      return {
        chatId: g.chatId,
        groupId: g._id,
        name: g.name,
        avatar: g.avatar,
        creator: g.creator,
        invitedBy: me?.invitedBy,
        memberCount: g.members.filter((m) => m.status === "accepted").length,
      };
    });

    res.status(200).json({ success: true, requests });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Accept a group invite ───────────────────────────────────────────────
export const acceptGroupInvite = async (req, res) => {
  try {
    const userId = req.user._id;
    const { chatId } = req.params;

    const group = await Group.findOne({ chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });

    const member = group.members.find(
      (m) => m.user.toString() === userId.toString() && m.status === "pending"
    );
    if (!member) return res.status(404).json({ success: false, message: "Invite not found" });

    member.status = "accepted";
    member.joinedAt = new Date();
    await group.save();

    const me = await User.findById(userId).select("username");
    const sysMsg = await Message.create({
      chatId,
      group: group._id,
      isSystem: true,
      text: `${me?.username || "Someone"} joined the group`,
    });
    group.lastMessageAt = sysMsg.createdAt;
    group.lastMessageText = sysMsg.text;
    await group.save();

    emitToGroupMembers(group, "groupMemberJoined", {
      chatId,
      user: { _id: userId, username: me?.username },
      message: sysMsg,
    });
    await pushGroupCounts(userId);

    const populated = await Group.findById(group._id).populate(
      "members.user",
      "username profilePic isPrivate"
    );
    res.status(200).json({ success: true, group: populated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Decline a group invite ──────────────────────────────────────────────
export const declineGroupInvite = async (req, res) => {
  try {
    const userId = req.user._id;
    const { chatId } = req.params;

    const group = await Group.findOne({ chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });

    const member = group.members.find(
      (m) => m.user.toString() === userId.toString() && m.status === "pending"
    );
    if (!member) return res.status(404).json({ success: false, message: "Invite not found" });

    member.status = "declined";
    await group.save();
    await pushGroupCounts(userId);

    res.status(200).json({ success: true, message: "Invite declined" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Exit a group (any accepted member, including admins) ───────────────
export const exitGroup = async (req, res) => {
  try {
    const userId = req.user._id;
    const { chatId } = req.params;

    const group = await Group.findOne({ chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });

    const member = group.members.find(
      (m) => m.user.toString() === userId.toString() && m.status === "accepted"
    );
    if (!member) return res.status(404).json({ success: false, message: "You're not in this group" });

    member.status = "declined";
    member.leftAt = new Date();

    const me = await User.findById(userId).select("username");
    const remainingAdmins = group.members.some(
      (m) => m.status === "accepted" && m.role === "admin" && m.user.toString() !== userId.toString()
    );
    const remainingAccepted = group.members.filter(
      (m) => m.status === "accepted" && m.user.toString() !== userId.toString()
    );

    if (member.role === "admin" && !remainingAdmins && remainingAccepted.length > 0) {
      const next = remainingAccepted.sort(
        (a, b) => new Date(a.joinedAt || 0) - new Date(b.joinedAt || 0)
      )[0];
      const nextMember = group.members.find((m) => m.user.toString() === next.user.toString());
      if (nextMember) nextMember.role = "admin";
    }

    await group.save();

    const sysMsg = await Message.create({
      chatId,
      group: group._id,
      isSystem: true,
      text: `${me?.username || "Someone"} left the group`,
    });
    group.lastMessageAt = sysMsg.createdAt;
    group.lastMessageText = sysMsg.text;
    await group.save();

    emitToGroupMembers(group, "groupMemberLeft", {
      chatId,
      user: { _id: userId, username: me?.username },
      message: sysMsg,
    }, { skip: userId });

    const stillHasMembers = group.members.some((m) => m.status === "accepted");
    if (!stillHasMembers) {
      const remainingMessages = await Message.find({ chatId });
      const withMedia = remainingMessages.filter((m) => m.media?.url);
      await Promise.all(withMedia.map((m) => destroyCloudinaryAsset(m.media)));
      await Message.deleteMany({ chatId });
      await Group.deleteOne({ _id: group._id });
    }

    res.status(200).json({ success: true, message: "Left the group" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Remove a member ──────────────────────────────────────────────────────
// CHANGED: any accepted member can remove any other accepted member —
// this is no longer admin-only. (A member still can't remove themselves
// this way; they should use "Exit Group" instead.)
export const removeGroupMember = async (req, res) => {
  try {
    const userId = req.user._id;
    const { chatId } = req.params;
    const { memberId } = req.body;

    if (!memberId) return res.status(400).json({ success: false, message: "memberId is required" });
    if (memberId.toString() === userId.toString()) {
      return res.status(400).json({ success: false, message: "Use Exit Group to remove yourself" });
    }

    const group = await Group.findOne({ chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });
    if (!group.isAcceptedMember(userId)) {
      return res.status(403).json({ success: false, message: "You're not a member of this group" });
    }

    const member = group.members.find(
      (m) => m.user.toString() === memberId && m.status === "accepted"
    );
    if (!member) return res.status(404).json({ success: false, message: "Member not found" });

    member.status = "declined";
    member.leftAt = new Date();
    await group.save();

    const actor = await User.findById(userId).select("username");
    const removedUser = await User.findById(memberId).select("username");
    const sysMsg = await Message.create({
      chatId,
      group: group._id,
      isSystem: true,
      text: `${removedUser?.username || "A member"} was removed from the group by ${actor?.username || "a member"}`,
    });
    group.lastMessageAt = sysMsg.createdAt;
    group.lastMessageText = sysMsg.text;
    await group.save();

    emitToGroupMembers(group, "groupMemberLeft", {
      chatId,
      user: { _id: memberId, username: removedUser?.username },
      message: sysMsg,
      removed: true,
    });

    const sid = onlineUsers.get(memberId.toString());
    if (sid) getIO().to(sid).emit("removedFromGroup", { chatId, groupName: group.name });

    res.status(200).json({ success: true, message: "Member removed" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Rename a group (admin only — unchanged) ─────────────────────────────
export const renameGroup = async (req, res) => {
  try {
    const userId = req.user._id;
    const { chatId } = req.params;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Name can't be empty" });
    }

    const group = await Group.findOne({ chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });
    if (!group.isAdmin(userId)) {
      return res.status(403).json({ success: false, message: "Only admins can rename the group" });
    }

    const oldName = group.name;
    group.name = name.trim();

    const me = await User.findById(userId).select("username");
    const sysMsg = await Message.create({
      chatId,
      group: group._id,
      isSystem: true,
      text: `${me?.username || "Someone"} renamed the group from "${oldName}" to "${group.name}"`,
    });
    group.lastMessageAt = sysMsg.createdAt;
    group.lastMessageText = sysMsg.text;
    await group.save();

    emitToGroupMembers(group, "groupRenamed", { chatId, name: group.name, message: sysMsg });

    res.status(200).json({ success: true, name: group.name });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── My groups ─────────────────────────────────────────────────────────
export const getMyGroups = async (req, res) => {
  try {
    const userId = req.user._id;
    const groups = await Group.find({
      members: { $elemMatch: { user: userId, status: "accepted" } },
      clearedFor: { $ne: userId },
    })
      .populate("members.user", "username profilePic")
      .sort({ lastMessageAt: -1 })
      .lean();

    const result = groups.map((g) => ({
      chatId: g.chatId,
      groupId: g._id,
      name: g.name,
      avatar: g.avatar,
      isGroup: true,
      members: g.members.filter((m) => m.status === "accepted"),
      lastMessageAt: g.lastMessageAt,
      lastMessageText: g.lastMessageText,
      unreadCounts: g.unreadCounts || {},
    }));

    res.status(200).json({ success: true, groups: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Group details ────────────────────────────────────────────────────
export const getGroupDetails = async (req, res) => {
  try {
    const { chatId } = req.params;
    const group = await Group.findOne({ chatId }).populate(
      "members.user",
      "username profilePic isPrivate"
    );
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });
    res.status(200).json({ success: true, group });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Send a message into a group ─────────────────────────────────────────
export const sendGroupMessage = async (req, res) => {
  try {
    const senderId = req.user._id;
    const { chatId, text, media, replyTo, sharedPost } = req.body;

    const group = await Group.findOne({ chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });
    if (!group.isAcceptedMember(senderId)) {
      return res.status(403).json({ success: false, message: "You're not a member of this group" });
    }

    const newMessage = await Message.create({
      chatId,
      group: group._id,
      user: senderId,
      text,
      media,
      sharedPost,
      replyTo: replyTo || null,
      mediaExpiresAt: media?.url ? new Date(Date.now() + THREE_DAYS_MS) : null,
    });

    await newMessage.populate("user", "username profilePic");
    await newMessage.populate({
      path: "replyTo",
      populate: { path: "user", select: "username profilePic" },
    });

    group.lastMessageAt = new Date();
    group.lastMessageText = text?.slice(0, 80) || (media?.url ? "📎 Media" : sharedPost ? "📷 Shared a post" : "");
    group.members.forEach((m) => {
      if (m.status !== "accepted") return;
      if (m.user.toString() === senderId.toString()) return;
      const current = group.unreadCounts.get(m.user.toString()) || 0;
      group.unreadCounts.set(m.user.toString(), current + 1);
    });
    group.clearedFor = [];
    await group.save();

    emitToGroupMembers(
      group,
      "receiveGroupMessage",
      { chatId, groupId: group._id, message: newMessage },
      { skip: senderId }
    );

    // ── NEW — offline-member push fallback. emitToGroupMembers() above
    // only reaches members with a live socket connection right now;
    // unlike 1:1 messages (which go through createNotification() in
    // message.controller.js and so already get a DB record + push
    // fallback), group messages had no equivalent at all — an offline
    // or fully-closed-app member got nothing, not even a badge update
    // on next open. Sending a direct FCM push here (rather than through
    // createNotification/the Notification model) keeps this change
    // self-contained without needing a schema change for a new
    // "group_message" notification type; add that persistence later if
    // you want group messages to show up in the notification feed too.
    const senderName = newMessage.user?.username || "Someone";
    const previewText =
      text?.slice(0, 100) || (media?.url ? "📎 Media" : sharedPost ? "📷 Shared a post" : "Sent a message");
    group.members.forEach((m) => {
      if (m.status !== "accepted") return;
      if (m.user.toString() === senderId.toString()) return;
      const sid = onlineUsers.get(m.user.toString());
      if (!sid) {
        sendPushToUser(m.user, {
          title: group.name || "Group message",
          body: `${senderName}: ${previewText}`,
          data: { type: "group_message", chatId, groupId: group._id.toString() },
        });
      }
    });

    res.status(201).json(newMessage);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ── Get group messages (oldest first) ───────────────────────────────────
export const getGroupMessages = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user._id;

    const group = await Group.findOne({ chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });
    if (!group.isAcceptedMember(userId)) {
      return res.status(403).json({ success: false, message: "You're not a member of this group" });
    }

    const messages = await Message.find({
      chatId,
      deletedFor: { $nin: [userId] },
      deletedForEveryone: { $ne: true },
    })
      .sort({ createdAt: 1 })
      .populate("user", "username profilePic")
      .populate({
        path: "replyTo",
        populate: { path: "user", select: "username profilePic" },
      });

    group.unreadCounts.set(userId.toString(), 0);
    await group.save();

    res.status(200).json(messages);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ── NEW — Edit a group message (text only, sender only) ────────────────
export const editGroupMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { text, chatId } = req.body;
    const userId = req.user._id;

    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ success: false, message: "Message not found" });

    const group = await Group.findOne({ chatId: chatId || message.chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });
    if (!group.isAcceptedMember(userId)) {
      return res.status(403).json({ success: false, message: "You're not a member of this group" });
    }
    if (message.user?.toString() !== userId.toString()) {
      return res.status(403).json({ success: false, message: "You are not the owner of this message" });
    }
    if (message.media?.url || message.sharedPost?.postId || message.sharedPost?.storyId) {
      return res.status(400).json({ success: false, message: "Media and shared-post messages can't be edited" });
    }

    message.text = text;
    message.isEdited = true;
    const updatedMessage = await message.save();
    await updatedMessage.populate("user", "username profilePic");

    emitToGroupMembers(group, "groupMessageEdited", {
      messageId,
      text,
      chatId: group.chatId,
      editedAt: new Date(),
    }, { skip: userId });

    res.status(200).json(updatedMessage);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ── NEW — Like / unlike a group message ─────────────────────────────────
export const toggleLikeGroupMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { chatId } = req.body;
    const userId = req.user._id;

    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ success: false, message: "Message not found" });

    const group = await Group.findOne({ chatId: chatId || message.chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });
    if (!group.isAcceptedMember(userId)) {
      return res.status(403).json({ success: false, message: "You're not a member of this group" });
    }

    const alreadyLiked = message.likes?.some((id) => id.toString() === userId.toString());
    if (alreadyLiked) {
      message.likes = message.likes.filter((id) => id.toString() !== userId.toString());
    } else {
      message.likes = [...(message.likes || []), userId];
    }
    const updatedMessage = await message.save();

    emitToGroupMembers(group, "groupMessageLiked", {
      messageId,
      chatId: group.chatId,
      likes: updatedMessage.likes,
      likedBy: userId,
      liked: !alreadyLiked,
    });

    res.status(200).json(updatedMessage);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ── NEW — Forward any message (1:1 or group origin) INTO a group ───────
export const forwardMessageToGroup = async (req, res) => {
  try {
    const userId = req.user._id;
    const { chatId } = req.params; // destination group chatId
    const { messageId } = req.body;

    const group = await Group.findOne({ chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });
    if (!group.isAcceptedMember(userId)) {
      return res.status(403).json({ success: false, message: "You're not a member of this group" });
    }

    const original = await Message.findById(messageId);
    if (!original) return res.status(404).json({ success: false, message: "Original message not found" });

    const forwardedMessage = await Message.create({
      chatId,
      group: group._id,
      user: userId,
      text: original.text,
      media: original.media,
      sharedPost: original.sharedPost,
      isForwarded: true,
      originalMessageId: original._id,
      mediaExpiresAt: original.media?.url ? new Date(Date.now() + THREE_DAYS_MS) : null,
    });

    await forwardedMessage.populate("user", "username profilePic");

    group.lastMessageAt = new Date();
    group.lastMessageText = original.text?.slice(0, 80) || "📎 Media";
    group.members.forEach((m) => {
      if (m.status !== "accepted" || m.user.toString() === userId.toString()) return;
      const current = group.unreadCounts.get(m.user.toString()) || 0;
      group.unreadCounts.set(m.user.toString(), current + 1);
    });
    group.clearedFor = [];
    await group.save();

    emitToGroupMembers(
      group,
      "receiveGroupMessage",
      { chatId, groupId: group._id, message: forwardedMessage },
      { skip: userId }
    );

    res.status(201).json(forwardedMessage);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ── Delete a group message (for me OR for everyone) ─────────────────────
export const deleteGroupMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { chatId, forEveryone } = req.body;
    const userId = req.user._id;

    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ success: false, message: "Message not found" });

    const group = await Group.findOne({ chatId: chatId || message.chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });
    if (!group.isAcceptedMember(userId)) {
      return res.status(403).json({ success: false, message: "You're not a member of this group" });
    }

    const isOwner = message.user?.toString() === userId.toString();

    if (forEveryone) {
      if (!isOwner && !group.isAdmin(userId)) {
        return res.status(403).json({
          success: false,
          message: "Only the sender or a group admin can delete this for everyone",
        });
      }

      if (message.media?.url) {
        await destroyCloudinaryAsset(message.media);
      }

      await Message.deleteOne({ _id: messageId });

      emitToGroupMembers(group, "groupMessageDeletedForEveryone", {
        messageId,
        chatId: group.chatId,
        deletedAt: new Date(),
      });

      return res.status(200).json({ success: true, message: "Message deleted for everyone", messageId });
    }

    if (!message.deletedFor.some((id) => id.toString() === userId.toString())) {
      message.deletedFor.push(userId);
      await message.save();
    }

    const acceptedIds = group.members
      .filter((m) => m.status === "accepted")
      .map((m) => m.user.toString());
    const allDeleted = acceptedIds.every((id) =>
      message.deletedFor.some((d) => d.toString() === id)
    );
    if (allDeleted) {
      if (message.media?.url) await destroyCloudinaryAsset(message.media);
      await Message.deleteOne({ _id: message._id });
    }

    res.status(200).json({ success: true, message: "Message deleted for you", messageId });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────
// Group chat wallpaper — per-user, per-group. Same pattern as the 1:1
// version in message.controllers.js: stored on the Group doc's
// `wallpapers` map (see group.model.js), keyed by userId, instead of only
// in the app's AsyncStorage. The old Cloudinary photo is destroyed
// straight from its URL when it's replaced or cleared.
// ─────────────────────────────────────────────────────────────────────────
export const getGroupWallpaper = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user._id.toString();

    const group = await Group.findOne({ chatId }).select("wallpapers");
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });

    const wallpaper = group.wallpapers?.get(userId) || null;
    res.status(200).json({ success: true, wallpaper });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const setGroupWallpaper = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user._id.toString();

    const group = await Group.findOne({ chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });
    if (!group.isAcceptedMember(userId)) {
      return res.status(403).json({ success: false, message: "You're not a member of this group" });
    }

    const previous = group.wallpapers?.get(userId) || null;

    let wallpaper;
    if (req.file) {
      wallpaper = { presetId: null, type: "image", value: req.file.path.replace(/^http:\/\//i, "https://") };
    } else {
      const { id, type, value, sticker, stickerOpacity, stickerSize, stickerGap, icons, iconColor, iconOpacity, iconSize, gap } = req.body;
      wallpaper = { presetId: id ?? null, type, value, sticker, stickerOpacity, stickerSize, stickerGap, icons, iconColor, iconOpacity, iconSize, gap };
    }

    group.wallpapers.set(userId, wallpaper);
    await group.save();

    if (previous?.type === "image" && previous.value && previous.value !== wallpaper.value) {
      await destroyCloudinaryAsset({ url: previous.value, mediaType: "image" });
    }

    res.status(200).json({ success: true, wallpaper });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const clearGroupWallpaper = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user._id.toString();

    const group = await Group.findOne({ chatId });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });

    const previous = group.wallpapers?.get(userId) || null;
    group.wallpapers.delete(userId);
    await group.save();

    if (previous?.type === "image" && previous.value) {
      await destroyCloudinaryAsset({ url: previous.value, mediaType: "image" });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};