import User from '../models/user/user.model.js';
import Message from '../models/messages/message.model.js';
import Conversation from '../models/messages/conversation.model.js';
import Group from '../models/messages/group.model.js';
import { getIO, onlineUsers } from '../config/sockets.js';

import cloudinary, {
  MAX_MESSAGE_IMAGE_BYTES,
  MAX_MESSAGE_AUDIO_BYTES,
  MAX_MESSAGE_VIDEO_BYTES,
  MAX_MESSAGE_FILE_BYTES,
} from '../config/cloudinary.js';
import { createNotification } from './notification.helper.js';

// ─────────────────────────────────────────────────────────────────────────
// Helper: build a stable chatId from two user ids
// ─────────────────────────────────────────────────────────────────────────
const buildChatId = (a, b) => [a.toString(), b.toString()].sort().join('_');

// ── Media auto-expiry window ────────────────────────────────────────────
// Changed from 7 days -> 3 days. Keep this in sync with MEDIA_RETENTION_MS
// in jobs/expire.media.js (that constant is only a fallback for messages
// with no mediaExpiresAt set; this one is what actually gets stamped on
// every new media message).
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────
// Helper: decide whether sender → recipient should be a "message request"
// Instagram rule: if recipient is PRIVATE and does NOT follow the sender
// (i.e. sender is a stranger to them), it's a request.
// If recipient is public, OR recipient already follows sender, it's a
// normal inbox message.
// ─────────────────────────────────────────────────────────────────────────
const shouldBeRequest = (recipient, senderId) => {
  if (!recipient) return false;
  if (!recipient.isPrivate) return false; // public accounts: no requests gate
  const recipientFollowsSender = (recipient.following || []).some(
    id => id.toString() === senderId.toString()
  );
  return !recipientFollowsSender;
};

// ─────────────────────────────────────────────────────────────────────────
// Helper: get or create the Conversation doc for a chat, applying request
// logic only on first creation (subsequent messages don't re-evaluate).
// ─────────────────────────────────────────────────────────────────────────
export const getOrCreateConversation = async ({ chatId, senderId, recipientId }) => {
  let convo = await Conversation.findOne({ chatId });

  const recipient = await User.findById(recipientId).select('isPrivate following');
  const isRequest = shouldBeRequest(recipient, senderId);

  if (!convo) {
    convo = await Conversation.create({
      chatId,
      members: [senderId, recipientId],
      initiator: senderId,
      recipient: recipientId,
      status: isRequest ? 'pending' : 'none',
    });
    return convo;
  }

  // Once the recipient has explicitly accepted or declined, respect that
  // decision — don't flip it back just because follow state changed again.
  if (convo.status === 'accepted' || convo.status === 'declined') {
    return convo;
  }

  // Otherwise (status is 'none' or still 'pending'), re-derive it from the
  // CURRENT private/follow relationship, so an old thread correctly moves
  // to Requests if the recipient went private / unfollowed since then.
  const correctStatus = isRequest ? 'pending' : 'none';
  if (convo.status !== correctStatus) {
    convo.status = correctStatus;
    await convo.save();
  }

  return convo;
};

// ─────────────────────────────────────────────────────────────────────────
// Helper: bump unread + lastMessage on a conversation
// ─────────────────────────────────────────────────────────────────────────
export const touchConversation = async (convo, { text, forUserId }) => {
  convo.lastMessageAt = new Date();
  convo.lastMessageText = text?.slice(0, 80) || '';
  if (forUserId) {
    const current = convo.unreadCounts.get(forUserId.toString()) || 0;
    convo.unreadCounts.set(forUserId.toString(), current + 1);
  }
  // Sending a new message un-clears the conversation for everyone
  convo.clearedFor = [];
  await convo.save();
};

// ── Create a new message ───────────────────────────────────────────────────
export const createMessage = async (req, res) => {
  try {
    const { chatId, text, media, to, replyTo, isSystem, sharedPost, isEphemeral } = req.body;
    const senderId = req.user._id;
    if (to && to.toString() === senderId.toString()) {
      return res.status(400).json({ message: "Cannot message yourself" });
    }
    let convo = null;
    if (!isSystem && to) {
      convo = await getOrCreateConversation({ chatId, senderId, recipientId: to });
    }

    const newMessage = new Message({
      chatId,
      user: isSystem ? undefined : senderId,
      to,
      text,
      media,
      sharedPost,
      replyTo: replyTo || null,
      isSystem: isSystem || false,
      isEphemeral: isEphemeral || false,
      isMessageRequest: convo?.status === 'pending',
      requestStatus: convo ? convo.status : 'none',
      mediaExpiresAt: media?.url ? new Date(Date.now() + THREE_DAYS_MS) : null,
    });

    const savedMessage = await newMessage.save();

    if (!isSystem) {
      await savedMessage.populate("user", "username profilePic");
      await savedMessage.populate({
        path: "replyTo",
        populate: { path: "user", select: "username profilePic" },
      });
    }

    const io = getIO();

    if (to && !isSystem && convo) {
      await touchConversation(convo, { text, forUserId: to });

      // ── NEW: check if recipient muted the SENDER's messages ──────────
      const recipientUser = await User.findById(to).select("mutedUsers");
      const isMutedForMessages = recipientUser?.mutedUsers?.some(
        (m) => m.user.toString() === senderId.toString() && m.muteMessage
      );

      const recipientSocketId = onlineUsers.get(to.toString());
      if (recipientSocketId) {
        if (!isMutedForMessages) {
          // Normal path: live toast/notification event
          const eventName = convo.status === 'pending' ? 'newMessageRequest' : 'receiveMessage';
          io.to(recipientSocketId).emit(eventName, {
            from: senderId,
            text,
            conversationId: chatId,
            message: savedMessage,
            createdAt: savedMessage.createdAt,
            isRequest: convo.status === 'pending',
          });
        }
        // Always sync unread badge counts, muted or not — the message
        // still exists in their inbox, just without a toast/sound.
        const [unreadCount, requestCount] = await Promise.all([
          getUnreadCountForUser(to),
          getRequestCountForUser(to),
        ]);
        io.to(recipientSocketId).emit('inboxCounts', { unreadCount, requestCount });
      }

      // ← persisted notification: skipped if muted
      if (!isMutedForMessages) {
        const sender = await User.findById(senderId).select("username");
        await createNotification({
          recipientId: to,
          senderId,
          type: "message",
          message:
            convo.status === 'pending'
              ? `${sender?.username || "Someone"} sent you a message request`
              : `${sender?.username || "Someone"} sent you a message`,
          chatId,
          link: `/messages/${chatId}`,
        });
      }
    }

    res.status(201).json(savedMessage);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// ── Get messages for a specific chat (oldest first) ────────────────────────
export const getMessages = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user._id;

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

    // Mark conversation as read for this user + clear unread badge
    const convo = await Conversation.findOne({ chatId });
    if (convo) {
      convo.unreadCounts.set(userId.toString(), 0);
      await convo.save();

      const io = getIO();
      const mySocketId = onlineUsers.get(userId.toString());
      if (mySocketId) {
        const [unreadCount, requestCount] = await Promise.all([
          getUnreadCountForUser(userId),
          getRequestCountForUser(userId),
        ]);
        io.to(mySocketId).emit('inboxCounts', { unreadCount, requestCount });
      }
    }

    res.status(200).json(messages);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// ── Clear all messages in a chat ───────────────────────────────────────────
export const clearChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { to, onlyForMe } = req.body;
    const userId = req.user._id;

 if (onlyForMe) {
  await Message.updateMany(
    { chatId, deletedFor: { $nin: [userId] } },
    { $addToSet: { deletedFor: userId } }
  );

  const convo = await Conversation.findOne({ chatId });
  if (convo && !convo.clearedFor.some(id => id.toString() === userId.toString())) {
    convo.clearedFor.push(userId);
    await convo.save();
  }

  // ── If every member of this conversation has now deleted-for-me all
  // messages, there's no one left who can still see them — safe to
  // physically purge (Cloudinary + Mongo) instead of leaking storage.
  if (convo) {
    const memberIds = convo.members.map(id => id.toString());
    const fullyDeleted = await Message.find({
      chatId,
      deletedFor: { $all: memberIds },
    });
    if (fullyDeleted.length) await purgeMessages(fullyDeleted);
  }

  return res.status(200).json({ message: "Chat cleared for you only" });
}

  const allMessages = await Message.find({ chatId });
await purgeMessages(allMessages);
await Conversation.deleteOne({ chatId });

    const io = getIO();
    if (to) {
      const recipientSocketId = onlineUsers.get(to.toString());
      if (recipientSocketId) {
        io.to(recipientSocketId).emit("chatCleared", { chatId });
      }
    }

    res.status(200).json({ message: "Chat cleared successfully" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// ── Like or unlike a message ───────────────────────────────────────────────
export const toggleLikeMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user._id;

    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ message: "Message not found" });

    const alreadyLiked = message.likes?.includes(userId);
    if (alreadyLiked) {
      message.likes = message.likes.filter((id) => id.toString() !== userId.toString());
    } else {
      message.likes = [...(message.likes || []), userId];
    }

    const updatedMessage = await message.save();

    const io = getIO();
    const ownerSocketId = onlineUsers.get(message.user.toString());
    if (ownerSocketId && message.user.toString() !== userId.toString()) {
      io.to(ownerSocketId).emit("messageLiked", {
        messageId,
        likedBy: userId,
        liked: !alreadyLiked,
        chatId: message.chatId,
        likes: updatedMessage.likes,
      });
    }

    res.status(200).json(updatedMessage);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// ── Edit a message ─────────────────────────────────────────────────────────
// ── Edit a message ─────────────────────────────────────────────────────────
export const editMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { text, to } = req.body;
    const userId = req.user._id;

    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ message: "Message not found" });

    if (message.user.toString() !== userId.toString()) {
      return res.status(403).json({ message: "You are not the owner of this message" });
    }

    // ← FIXED: previously only checked sharedPost.postId, so a shared
    // STORY (sharedPost.storyId) — including "X mentioned you in their
    // story" notifications and regular story-shares from StoryShareSheet
    // — could have its text edited into anything. Now blocked exactly
    // like a shared post or media message.
    if (message.media?.url || message.sharedPost?.postId || message.sharedPost?.storyId) {
      return res.status(400).json({ message: "Media and shared-post messages can't be edited" });
    }

    message.text = text;
    message.isEdited = true;

    const updatedMessage = await message.save();
    await updatedMessage.populate("user", "username profilePic");

    const io = getIO();
    if (to) {
      const recipientSocketId = onlineUsers.get(to.toString());
      if (recipientSocketId) {
        io.to(recipientSocketId).emit("messageEdited", {
          messageId,
          text,
          chatId: message.chatId,
          editedAt: new Date(),
        });
      }
    }

    res.status(200).json(updatedMessage);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// ── Delete a single message (for me OR for everyone) ───────────────────────
export const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { to, forEveryone } = req.body;
    const userId = req.user._id;

    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ message: "Message not found" });

    const isOwner = message.user?.toString() === userId.toString();

    // ── Delete for everyone — only the sender can do this ────────────────
    if (forEveryone) {
      if (!isOwner) {
        return res.status(403).json({ message: "You can only delete your own messages for everyone" });
      }

      // Wipe media from Cloudinary too
      if (message.media?.url) {
        await destroyCloudinaryAsset(message.media);
      }

      await Message.deleteOne({ _id: messageId });

      const io = getIO();
      if (to) {
        const recipientSocketId = onlineUsers.get(to.toString());
        if (recipientSocketId) {
          io.to(recipientSocketId).emit("messageDeletedForEveryone", {
            messageId,
            chatId: message.chatId,
            deletedAt: new Date(),
          });
        }
      }

      return res.status(200).json({ message: "Message deleted for everyone", messageId });
    }

    // ── Delete for me only ─────────────────────────────────────────────
if (!message.deletedFor.some(id => id.toString() === userId.toString())) {
  message.deletedFor.push(userId);
  await message.save();
}

// If everyone in the conversation has deleted-for-me this message,
// purge it for real instead of leaving a dead doc + orphaned asset.
const convo = await Conversation.findOne({ chatId: message.chatId });
if (convo) {
  const memberIds = convo.members.map(id => id.toString());
  const allDeleted = memberIds.every(id =>
    message.deletedFor.some(d => d.toString() === id)
  );
  if (allDeleted) await purgeMessages([message]);
}

res.status(200).json({ message: "Message deleted for you", messageId });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Cloudinary cleanup helper ───────────────────────────────────────────────
async function destroyCloudinaryAsset(media) {
  try {
    const urlParts = media.url.split("/");
    const uploadIndex = urlParts.indexOf("upload");
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
    console.error("Cloudinary delete failed:", err.message);
  }
}
// ── Hard-delete messages: destroy Cloudinary assets first, then remove
// the Mongo docs. Call this ONLY for messages that are safe to fully
// purge (e.g. every member has deleted/cleared them).
async function purgeMessages(messages) {
  const withMedia = messages.filter(m => m.media?.url);
  await Promise.all(withMedia.map(m => destroyCloudinaryAsset(m.media)));
  const ids = messages.map(m => m._id);
  if (ids.length) await Message.deleteMany({ _id: { $in: ids } });
}

// ─────────────────────────────────────────────────────────────────────────
// Upload a chat attachment (image / video / audio / file). Same pattern
// as enforcePostMediaLimits in media.controllers.js and addStory in
// story.controllers.js: multer's `uploadMessage` config (see
// config/cloudinary.js) only enforces a single ceiling at the transport
// layer (25MB, the video limit) because it can't vary by mimetype on its
// own. This handler enforces the PRECISE per-type limit afterward, and
// — critically — deletes the just-uploaded Cloudinary asset immediately
// if it's oversized for its actual type, so nothing oversized lingers in
// storage just because it happened to be under the shared ceiling.
// ─────────────────────────────────────────────────────────────────────────
export const uploadMessageMedia = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

    const mediaType = req.body?.mediaType || inferMediaType(req.file.mimetype);
    const limit =
      mediaType === "image" ? MAX_MESSAGE_IMAGE_BYTES :
      mediaType === "video" ? MAX_MESSAGE_VIDEO_BYTES :
      mediaType === "audio" ? MAX_MESSAGE_AUDIO_BYTES :
      MAX_MESSAGE_FILE_BYTES;

    if (req.file.size > limit) {
      await destroyCloudinaryAsset({ url: req.file.path, mediaType });
      const limitMb = Math.round(limit / (1024 * 1024));
      return res.status(400).json({
        success: false,
        message: `${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)} must be under ${limitMb}MB.`,
      });
    }

    res.status(200).json({
      success: true,
      url: req.file.path,
      secure_url: req.file.path,
      fileName: req.body?.fileName || req.file.originalname,
      fileSize: req.file.size,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

function inferMediaType(mimetype) {
  if (!mimetype) return "file";
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.startsWith("audio/")) return "audio";
  return "file";
}

// ── Forward a message ──────────────────────────────────────────────────────
export const forwardMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { toChatId, to } = req.body;
    const userId = req.user._id;

    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ message: "Message not found" });

    const convo = await getOrCreateConversation({ chatId: toChatId, senderId: userId, recipientId: to });

    const forwardedMessage = new Message({
      chatId: toChatId,
      user: userId,
      to,
      text: message.text,
      media: message.media,
      sharedPost: message.sharedPost,
      isForwarded: true,
      originalMessageId: message._id,
      isMessageRequest: convo.status === 'pending',
      requestStatus: convo.status,
      // Forwarded media gets a fresh 3-day window starting from now.
      mediaExpiresAt: message.media?.url ? new Date(Date.now() + THREE_DAYS_MS) : null,
    });

    const savedForwardedMessage = await forwardedMessage.save();
    await savedForwardedMessage.populate("user", "username profilePic");

    await touchConversation(convo, { text: message.text || '📎 Media', forUserId: to });

    const io = getIO();
    if (to) {
      const recipientSocketId = onlineUsers.get(to.toString());
      if (recipientSocketId) {
        const eventName = convo.status === 'pending' ? 'newMessageRequest' : 'receiveMessage';
        io.to(recipientSocketId).emit(eventName, {
          from: userId,
          conversationId: toChatId,
          message: savedForwardedMessage,
          isForwarded: true,
          createdAt: savedForwardedMessage.createdAt,
          isRequest: convo.status === 'pending',
        });

        const [unreadCount, requestCount] = await Promise.all([
          getUnreadCountForUser(to),
          getRequestCountForUser(to),
        ]);
        io.to(recipientSocketId).emit('inboxCounts', { unreadCount, requestCount });
      }

      // ← persisted notification: sent you a message (forwarded)
      const sender = await User.findById(userId).select("username");
      await createNotification({
        recipientId: to,
        senderId: userId,
        type: "message",
        message:
          convo.status === 'pending'
            ? `${sender?.username || "Someone"} sent you a message request`
            : `${sender?.username || "Someone"} sent you a message`,
        chatId: toChatId,
        link: `/messages/${toChatId}`,
      });
    }

    res.status(201).json(savedForwardedMessage);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};


export const searchAllUsers = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { q = '', followingOnly, includeSuggested } = req.query;
    const query = q.trim();

    const me = await User.findById(userId).select('blockedUsers following');
    const myBlockedIds = (me?.blockedUsers || []).map(id => id.toString());
    const followingIds = new Set((me?.following || []).map(id => id.toString()));

    const usersWhoBlockedMe = await User.find(
      { blockedUsers: { $elemMatch: { $eq: userId } } },
      { _id: 1 }
    ).lean();
    const blockedMeIds = new Set(usersWhoBlockedMe.map(u => u._id.toString()));

    const notBlocked = (u) => !blockedMeIds.has(u._id.toString());

    // ── DEFAULT LISTING MODE (no query) ──────────────────────────────
    // Used by NewChatSheet/ForwardModal on open, before any typing, so
    // there's something tappable immediately instead of an empty sheet.
    if (!query) {
      const followingList = await User.find({
        _id: { $in: Array.from(followingIds), $nin: myBlockedIds },
      })
        .select('_id username profilePic isPrivate bio')
        .limit(50)
        .lean();

      const following = followingList
        .filter(notBlocked)
        .map(u => ({ ...u, isFollowing: true }));

      let suggested = [];
      if (includeSuggested === 'true' || includeSuggested === '1') {
        // Public accounts the user does NOT already follow — a simple
        // "suggested" set, not personalized beyond excluding people
        // already followed/blocked/self.
        const suggestedList = await User.find({
          _id: { $ne: userId, $nin: [...myBlockedIds, ...Array.from(followingIds)] },
          isPrivate: false,
        })
          .select('_id username profilePic isPrivate bio')
          .limit(20)
          .lean();

        suggested = suggestedList
          .filter(notBlocked)
          .map(u => ({ ...u, isFollowing: false }));
      }

      return res.status(200).json({ success: true, users: following, following, suggested });
    }

    // ── SEARCH MODE (query provided) — existing behavior ─────────────
    const idFilter = { $ne: userId, $nin: myBlockedIds };
    if (followingOnly === 'true' || followingOnly === '1') {
      idFilter.$in = Array.from(followingIds);
    }

    const results = await User.find({
      _id: idFilter,
      username: { $regex: query, $options: 'i' },
    })
      .select('_id username profilePic isPrivate bio')
      .limit(25)
      .lean();

    const filtered = results
      .filter(notBlocked)
      .map(u => ({
        ...u,
        isFollowing: followingIds.has(u._id.toString()),
      }));

    res.status(200).json({ success: true, users: filtered });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// GET CONVERSATION LIST (inbox) — excludes requests + cleared + blocked
//
// ALSO now merges in "virtual" entries for people the user FOLLOWS who
// don't have an existing conversation yet, so Primary shows your whole
// following list as tappable "start a chat" rows, not just people
// you've already messaged. Real conversations always take precedence
// over a virtual entry for the same person (deduped by otherUser id) —
// a virtual entry only fills in the gap when no real conversation
// exists at all.
// ─────────────────────────────────────────────────────────────────────────
export const getInbox = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const me = await User.findById(userId).select('blockedUsers following');
    const myBlockedIds = new Set((me?.blockedUsers || []).map(id => id.toString()));
    const followingIds = (me?.following || []).map(id => id.toString());

    const conversations = await Conversation.find({
      members: userId,
      status: { $in: ['none', 'accepted'] },
      clearedFor: { $ne: userId },
    })
      .populate('members', 'username profilePic isPrivate')
      .sort({ lastMessageAt: -1 })
      .lean();

    const real = conversations
      .map(c => {
        const otherUser = c.members.find(m => m._id.toString() !== userId.toString());
        return { ...c, otherUser, isVirtual: false };
      })
      .filter(c => c.otherUser && !myBlockedIds.has(c.otherUser._id.toString()));

    const realOtherUserIds = new Set(real.map(c => c.otherUser._id.toString()));

    // ── Virtual entries: followed users with no existing conversation ──
    const missingFollowingIds = followingIds.filter(
      id => !realOtherUserIds.has(id) && !myBlockedIds.has(id)
    );

    let virtual = [];
    if (missingFollowingIds.length > 0) {
      const followedUsers = await User.find({ _id: { $in: missingFollowingIds } })
        .select('_id username profilePic isPrivate')
        .lean();

      virtual = followedUsers.map(u => ({
        chatId: buildChatId(userId, u._id),
        members: [u],
        otherUser: u,
        status: 'none',
        lastMessageAt: null,
        lastMessageText: '',
        unreadCounts: {},
        isVirtual: true, // ← lets the frontend show "Tap to message" / no timestamp
      }));
    }

    // Real conversations first (most recent activity), then virtual
    // following entries (alphabetical, since there's no activity to
    // sort by) appended after.
    virtual.sort((a, b) => (a.otherUser.username || '').localeCompare(b.otherUser.username || ''));

    res.status(200).json({ success: true, conversations: [...real, ...virtual] });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// GET MESSAGE REQUESTS (Instagram "Requests" tab)
// ─────────────────────────────────────────────────────────────────────────
export const getMessageRequests = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const me = await User.findById(userId).select('blockedUsers');
    const myBlockedIds = new Set((me?.blockedUsers || []).map(id => id.toString()));

    const requests = await Conversation.find({
      recipient: userId,
      status: 'pending',
    })
      .populate('initiator', 'username profilePic isPrivate')
      .sort({ lastMessageAt: -1 })
      .lean();

    const filtered = requests.filter(
      r => r.initiator && !myBlockedIds.has(r.initiator._id.toString())
    );

    res.status(200).json({ success: true, requests: filtered });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Accept a message request ────────────────────────────────────────────────
export const acceptMessageRequest = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { chatId } = req.params;

    const convo = await Conversation.findOne({ chatId, recipient: userId });
    if (!convo) return res.status(404).json({ success: false, message: "Request not found" });

    convo.status = 'accepted';
    await convo.save();

    await Message.updateMany(
      { chatId, requestStatus: 'pending' },
      { $set: { requestStatus: 'accepted', isMessageRequest: false } }
    );

    const io = getIO();
    const senderSocketId = onlineUsers.get(convo.initiator.toString());
    if (senderSocketId) {
      io.to(senderSocketId).emit('messageRequestAccepted', { chatId });
    }

    res.status(200).json({ success: true, message: "Request accepted" });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Decline a message request ───────────────────────────────────────────────
export const declineMessageRequest = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { chatId } = req.params;

    const convo = await Conversation.findOne({ chatId, recipient: userId });
    if (!convo) return res.status(404).json({ success: false, message: "Request not found" });

    convo.status = 'declined';
    await convo.save();

    await Message.updateMany(
      { chatId, requestStatus: 'pending' },
      { $set: { requestStatus: 'declined' } }
    );

    res.status(200).json({ success: true, message: "Request declined" });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// COUNTS — unread inbox messages + pending requests (for nav badges)
// ─────────────────────────────────────────────────────────────────────────
async function getUnreadCountForUser(userId) {
  const conversations = await Conversation.find({
    members: userId,
    status: { $in: ['none', 'accepted'] },
  }).lean();

  let total = 0;
  for (const c of conversations) {
    total += c.unreadCounts?.[userId.toString()] || 0;
  }
  return total;
}

async function getRequestCountForUser(userId) {
  return Conversation.countDocuments({ recipient: userId, status: 'pending' });
}

export const getInboxCounts = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const [unreadCount, requestCount] = await Promise.all([
      getUnreadCountForUser(userId),
      getRequestCountForUser(userId),
    ]);
    res.status(200).json({ success: true, unreadCount, requestCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Forward modal helper: always returns at least 10 people to forward to,
// most-recently-messaged first, backfilled with people you follow (then
// suggested public accounts) so the sheet is never sparse.
// ─────────────────────────────────────────────────────────────────────────
export const getRecentChatUsers = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const MIN_RESULTS = 10;

    const me = await User.findById(userId).select('blockedUsers following');
    const myBlockedIds = new Set((me?.blockedUsers || []).map(id => id.toString()));

    // 1) Most recent 1:1 conversations (real activity, not virtual "tap to
    //    message" rows — those aren't "recent" in any meaningful sense)
    const conversations = await Conversation.find({
      members: userId,
      status: { $in: ['none', 'accepted'] },
      clearedFor: { $ne: userId },
    })
      .populate('members', 'username profilePic isPrivate')
      .sort({ lastMessageAt: -1 })
      .limit(30)
      .lean();

    const recent = [];
    const seen = new Set();
    for (const c of conversations) {
      const other = c.members.find(m => m._id.toString() !== userId.toString());
      if (!other) continue;
      if (myBlockedIds.has(other._id.toString())) continue;
      if (seen.has(other._id.toString())) continue;
      seen.add(other._id.toString());
      recent.push({ ...other, isFollowing: (me?.following || []).some(id => id.toString() === other._id.toString()), lastMessageAt: c.lastMessageAt });
    }

    // 2) Backfill with people you follow who aren't already in the list
    if (recent.length < MIN_RESULTS) {
      const followingIds = (me?.following || []).map(id => id.toString()).filter(id => !seen.has(id) && !myBlockedIds.has(id));
      if (followingIds.length) {
        const followed = await User.find({ _id: { $in: followingIds } })
          .select('_id username profilePic isPrivate bio')
          .limit(MIN_RESULTS - recent.length)
          .lean();
        followed.forEach(u => {
          if (seen.has(u._id.toString())) return;
          seen.add(u._id.toString());
          recent.push({ ...u, isFollowing: true, lastMessageAt: null });
        });
      }
    }

    // 3) Still short? Backfill with public suggested accounts
    if (recent.length < MIN_RESULTS) {
      const exclude = [...seen, ...myBlockedIds, userId.toString()];
      const suggested = await User.find({
        _id: { $nin: exclude },
        isPrivate: false,
      })
        .select('_id username profilePic isPrivate bio')
        .limit(MIN_RESULTS - recent.length)
        .lean();
      suggested.forEach(u => {
        if (seen.has(u._id.toString())) return;
        seen.add(u._id.toString());
        recent.push({ ...u, isFollowing: false, lastMessageAt: null });
      });
    }

    res.status(200).json({ success: true, users: recent });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};




// ─────────────────────────────────────────────────────────────────────────
// Chat wallpaper (1:1) — per-user, per-chat. Previously this lived ONLY in
// the app's AsyncStorage, which is why it kept "disappearing" — there was
// never a backend copy to restore from. Stored on the Conversation doc's
// `wallpapers` map (see conversation.model.js), keyed by userId, so each
// participant can have their own wallpaper for the same chat.
// ─────────────────────────────────────────────────────────────────────────
export const getConversationWallpaper = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user._id.toString();

    const convo = await Conversation.findOne({ chatId }).select("wallpapers");
    const wallpaper = convo?.wallpapers?.get(userId) || null;

    res.status(200).json({ success: true, wallpaper });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
export const setConversationWallpaper = async (req, res) => {
  console.log("[Wallpaper] 1. entered, file:", req.file ? `${req.file.size} bytes, path: ${req.file.path}` : "no file");
  try {
    const { chatId } = req.params;
    const userId = req.user._id.toString();
    console.log("[Wallpaper] 2. chatId/userId ok:", chatId, userId);

    let convo = await Conversation.findOne({ chatId });
    console.log("[Wallpaper] 3. convo found:", !!convo);

    if (!convo) {
      const otherId = chatId.split("_").find((id) => id !== userId);
      if (!otherId) return res.status(404).json({ success: false, message: "Conversation not found" });
      convo = await getOrCreateConversation({ chatId, senderId: userId, recipientId: otherId });
      console.log("[Wallpaper] 3b. convo created:", !!convo);
    }

    const previous = convo.wallpapers?.get(userId) || null;
    console.log("[Wallpaper] 4. previous:", previous);

    let wallpaper;
    if (req.file) {
    wallpaper = { presetId: null, type: "image", value: req.file.path.replace(/^http:\/\//i, "https://") };
    } else {
      const { id, type, value, sticker, stickerOpacity, stickerSize, stickerGap, icons, iconColor, iconOpacity, iconSize, gap } = req.body;
      wallpaper = { presetId: id ?? null, type, value, sticker, stickerOpacity, stickerSize, stickerGap, icons, iconColor, iconOpacity, iconSize, gap };
    }
    console.log("[Wallpaper] 5. wallpaper object:", wallpaper);

    convo.wallpapers.set(userId, wallpaper);
    await convo.save();
    console.log("[Wallpaper] 6. saved to DB");

    if (previous?.type === "image" && previous.value && previous.value !== wallpaper.value) {
      console.log("[Wallpaper] 7. destroying old cloudinary asset:", previous.value);
      await destroyCloudinaryAsset({ url: previous.value, mediaType: "image" });
      console.log("[Wallpaper] 8. old asset destroyed");
    }

    console.log("[Wallpaper] 9. sending response");
    res.status(200).json({ success: true, wallpaper });
  } catch (error) {
    console.log("[Wallpaper] CAUGHT ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const clearConversationWallpaper = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user._id.toString();

    const convo = await Conversation.findOne({ chatId });
    if (!convo) return res.status(404).json({ success: false, message: "Conversation not found" });

    const previous = convo.wallpapers?.get(userId) || null;
    convo.wallpapers.delete(userId);
    await convo.save();

    if (previous?.type === "image" && previous.value) {
      await destroyCloudinaryAsset({ url: previous.value, mediaType: "image" });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};