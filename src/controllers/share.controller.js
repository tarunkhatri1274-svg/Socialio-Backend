import Post from '../models/post/post.model.js';
import Story from '../models/story/story.model.js';
import User from '../models/user/user.model.js';
import Message from '../models/messages/message.model.js';
import Conversation from '../models/messages/conversation.model.js';
import Group from '../models/messages/group.model.js';
import { getIO, onlineUsers } from '../config/sockets.js';
import { getOrCreateConversation, touchConversation } from './message.controller.js'
// ── Share a post — now accepts BOTH 1:1 recipients (toUserIds) and group
// recipients (toGroupChatIds), same shared-post payload either way.
export const createShare = async (req, res) => {
  try {
    const { postId, toUserIds = [], toGroupChatIds = [] } = req.body;
    const userId = req.user._id || req.user.id;

    if (!postId) return res.status(400).json({ success: false, message: 'Post ID is required' });

    const [post, currentUser] = await Promise.all([
      Post.findById(postId).populate('author', 'username profilePic'),
      User.findById(userId).select('username profilePic blockedUsers'),
    ]);

    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    const alreadyShared = post.shares?.some(s => s.user.toString() === userId.toString());
if (!alreadyShared) {
  post.shares.push({ user: userId });
  post.sharesCount = post.shares.length;
  await post.save();

  const io = getIO(); // you already import getIO in this file
  io.to(`post:${post._id}`).emit("postShared", {
    postId: post._id.toString(),
    totalShares: post.sharesCount,
  });
}

    const blockedIds = (currentUser.blockedUsers || []).map(id => id.toString());
    const io = getIO();
    const dmResults = [];
    const groupResults = [];

    const sharedPostPayload = {
      postId: post._id,
      authorId: post.author?._id || null,
      caption: post.caption || post.text || '',
      mediaUrl: post.media?.[0]?.url || null,
      mediaType: post.media?.[0]?.type || null,
      authorUsername: post.author?.username || '',
      authorProfilePic: post.author?.profilePic || null,
    };

    // ── 1:1 recipients (unchanged) ──────────────────────────────────────
// ── 1:1 recipients ─────────────────────────────────────────────────
    for (const recipientId of toUserIds) {
      if (blockedIds.includes(recipientId.toString())) continue;

      const recipient = await User.findById(recipientId).select('blockedUsers');
      if (!recipient) continue;
      const recipientBlockedMe = (recipient.blockedUsers || []).some(
        id => id.toString() === userId.toString()
      );
      if (recipientBlockedMe) continue;

      const chatId = [userId.toString(), recipientId.toString()].sort().join('_');

      // ← FIX: create/refresh the Conversation the same way createMessage
      // does, so this share promotes a "virtual" (never-messaged) entry
      // into a real conversation with an accurate inbox preview, and
      // correctly lands in Requests if the recipient is private and
      // doesn't follow the sender.
      const convo = await getOrCreateConversation({
        chatId,
        senderId: userId,
        recipientId,
      });

      const newMessage = new Message({
        chatId,
        user: userId,
        to: recipientId,
        text: `${currentUser.username} shared a post`,
        sharedPost: sharedPostPayload,
        isMessageRequest: convo.status === 'pending',
        requestStatus: convo.status,
      });

      const savedMessage = await newMessage.save();
      await savedMessage.populate('user', 'username profilePic');

      // ← FIX: bump lastMessageAt/lastMessageText/unreadCounts so the
      // inbox shows "shared a post" instead of "Tap to message".
      await touchConversation(convo, {
        text: '📷 Shared a post',
        forUserId: recipientId,
      });

      const recipientSocketId = onlineUsers.get(recipientId.toString());
      if (recipientSocketId) {
        const eventName = convo.status === 'pending' ? 'newMessageRequest' : 'receiveMessage';
        io.to(recipientSocketId).emit(eventName, {
          from: userId,
          conversationId: chatId,
          message: savedMessage,
          createdAt: savedMessage.createdAt,
          isRequest: convo.status === 'pending',
        });
      }

      dmResults.push({ recipientId, chatId, messageId: savedMessage._id });
    }

    // ── NEW: group recipients ────────────────────────────────────────────
    for (const groupChatId of toGroupChatIds) {
      const group = await Group.findOne({ chatId: groupChatId });
      if (!group || !group.isAcceptedMember(userId)) continue;

      const newMessage = new Message({
        chatId: groupChatId,
        group: group._id,
        user: userId,
        text: `📷 ${currentUser.username} shared a post`,
        sharedPost: sharedPostPayload,
      });

      const savedMessage = await newMessage.save();
      await savedMessage.populate('user', 'username profilePic');

      group.lastMessageAt = new Date();
      group.lastMessageText = '📷 Shared a post';
      group.members.forEach((m) => {
        if (m.status !== 'accepted' || m.user.toString() === userId.toString()) return;
        const current = group.unreadCounts.get(m.user.toString()) || 0;
        group.unreadCounts.set(m.user.toString(), current + 1);
      });
      group.clearedFor = [];
      await group.save();

      group.members.forEach((m) => {
        if (m.status !== 'accepted' || m.user.toString() === userId.toString()) return;
        const sid = onlineUsers.get(m.user.toString());
        if (sid) io.to(sid).emit('receiveGroupMessage', { chatId: groupChatId, groupId: group._id, message: savedMessage });
      });

      groupResults.push({ groupChatId, messageId: savedMessage._id });
    }

    return res.status(201).json({
      success: true,
      message: (toUserIds.length > 0 || toGroupChatIds.length > 0) ? 'Post shared successfully' : 'Share recorded',
      sharesCount: post.sharesCount,
      dmResults,
      groupResults,
    });

  } catch (error) {
    console.error('createShare error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};


export const createStoryShare = async (req, res) => {
  try {
    const { storyId, toUserIds = [] } = req.body;
    const userId = req.user._id || req.user.id;

    if (!storyId) return res.status(400).json({ success: false, message: 'Story ID is required' });
    if (!toUserIds.length) return res.status(400).json({ success: false, message: 'Select at least one recipient' });

    const [story, currentUser] = await Promise.all([
      Story.findById(storyId).populate('author', 'username profilePic followers'),
      User.findById(userId).select('username profilePic blockedUsers'),
    ]);

    if (!story) return res.status(404).json({ success: false, message: 'Story not found or expired' });

    const authorId = story.author?._id?.toString();
    const isAuthorOrFollower =
      authorId === userId.toString() ||
      (story.author?.followers || []).some((id) => id.toString() === userId.toString());

    if (!isAuthorOrFollower) {
      return res.status(403).json({ success: false, message: 'You must follow this user to share their story' });
    }

    const blockedIds = (currentUser.blockedUsers || []).map(id => id.toString());
    const io = getIO();
    const dmResults = [];
for (const recipientId of toUserIds) {
      if (blockedIds.includes(recipientId.toString())) continue;

      const recipient = await User.findById(recipientId).select('blockedUsers');
      if (!recipient) continue;
      const recipientBlockedMe = (recipient.blockedUsers || []).some(
        id => id.toString() === userId.toString()
      );
      if (recipientBlockedMe) continue;

      const chatId = [userId.toString(), recipientId.toString()].sort().join('_');

      // ← FIX: same conversation creation/touch as the post-share loop
      const convo = await getOrCreateConversation({
        chatId,
        senderId: userId,
        recipientId,
      });

      const newMessage = new Message({
        chatId,
        user: userId,
        to: recipientId,
        text: `${currentUser.username} shared a story`,
        sharedPost: {
          kind: 'story',
          storyId: story._id,
          authorId,
          caption: '',
          mediaUrl: story.media?.url || null,
          mediaType: story.media?.type || null,
          authorUsername: story.author?.username || '',
          authorProfilePic: story.author?.profilePic || null,
        },
        isMessageRequest: convo.status === 'pending',
        requestStatus: convo.status,
      });

      const savedMessage = await newMessage.save();
      await savedMessage.populate('user', 'username profilePic');

      await touchConversation(convo, {
        text: '📷 Shared a story',
        forUserId: recipientId,
      });

      const recipientSocketId = onlineUsers.get(recipientId.toString());
      if (recipientSocketId) {
        const eventName = convo.status === 'pending' ? 'newMessageRequest' : 'receiveMessage';
        io.to(recipientSocketId).emit(eventName, {
          from: userId,
          conversationId: chatId,
          message: savedMessage,
          createdAt: savedMessage.createdAt,
          isRequest: convo.status === 'pending',
        });
      }

      dmResults.push({ recipientId, chatId, messageId: savedMessage._id });
    }

    if (dmResults.length === 0) {
      return res.status(400).json({ success: false, message: 'Could not send to any selected recipient' });
    }

    return res.status(201).json({ success: true, message: 'Story shared successfully', dmResults });

  } catch (error) {
    console.error('createStoryShare error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Get users (+ groups) to share with ──────────────────────────────────
// UPDATED: now also returns a `recent` list — the people you've most
// recently messaged — shown above "Following" in ShareSheet, plus a
// `groups` list so posts can be shared straight into a group chat too.
export const getShareableUsers = async (req, res) => {
  try {
    const userId = (req.user._id || req.user.id).toString();
    const { q = '' } = req.query;
    const searchQuery = q.trim().toLowerCase();

    const currentUser = await User.findById(userId)
      .select('following blockedUsers')
      .populate('following', '_id username profilePic isPrivate');

    if (!currentUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const myBlockedIds = new Set(
      (currentUser.blockedUsers || []).map(id => id.toString())
    );

    const usersWhoBlockedMe = await User.find(
      { blockedUsers: { $elemMatch: { $eq: userId } } },
      { _id: 1 }
    ).lean();
    const blockedMeIds = new Set(usersWhoBlockedMe.map(u => u._id.toString()));

    const notBlocked = (u) => !blockedMeIds.has(u._id.toString());

    // ── Recent: most recently active 1:1 conversations ──────────────────
    let recent = [];
    if (!searchQuery) {
      const conversations = await Conversation.find({
        members: userId,
        status: { $in: ['none', 'accepted'] },
        clearedFor: { $ne: userId },
      })
        .populate('members', '_id username profilePic isPrivate')
        .sort({ lastMessageAt: -1 })
        .limit(15)
        .lean();

      const seen = new Set();
      for (const c of conversations) {
        const other = c.members.find(m => m._id.toString() !== userId);
        if (!other) continue;
        const oid = other._id.toString();
        if (myBlockedIds.has(oid) || blockedMeIds.has(oid) || seen.has(oid)) continue;
        seen.add(oid);
        recent.push({
          _id: other._id,
          username: other.username,
          profilePic: other.profilePic || null,
          isPrivate: other.isPrivate || false,
          isFollowing: (currentUser.following || []).some(f => f._id.toString() === oid),
        });
      }
    }
    const recentIds = new Set(recent.map(u => u._id.toString()));

    // ── Groups you belong to (for sharing INTO a group) ─────────────────
    let groups = [];
    if (!searchQuery) {
      const myGroups = await Group.find({
        members: { $elemMatch: { user: userId, status: 'accepted' } },
      })
        .select('chatId name avatar members')
        .sort({ lastMessageAt: -1 })
        .limit(15)
        .lean();
      groups = myGroups.map(g => ({
        chatId: g.chatId,
        name: g.name,
        avatar: g.avatar || null,
        memberCount: g.members.filter(m => m.status === 'accepted').length,
      }));
    }

    // ── Following (excluding anyone already shown in Recent) ────────────
    const followingList = (currentUser.following || []).filter(u => {
      if (!u?._id) return false;
      const uid = u._id.toString();
      if (uid === userId) return false;
      if (myBlockedIds.has(uid) || blockedMeIds.has(uid)) return false;
      if (recentIds.has(uid)) return false;
      return true;
    });

    const followingFiltered = searchQuery
      ? (currentUser.following || []).filter(u =>
          u?._id && u.username?.toLowerCase().includes(searchQuery) &&
          !myBlockedIds.has(u._id.toString()) && !blockedMeIds.has(u._id.toString())
        )
      : followingList;

    let extraUsers = [];
    if (searchQuery) {
      const followingIds = new Set((currentUser.following || []).map(u => u._id.toString()));
      const excludeIds = [userId, ...myBlockedIds, ...followingIds];

      const publicMatches = await User.find({
        _id: { $nin: excludeIds },
        username: { $regex: searchQuery, $options: 'i' },
        isPrivate: false,
      })
        .select('_id username profilePic isPrivate')
        .limit(15)
        .lean();

      extraUsers = publicMatches.filter(u => !blockedMeIds.has(u._id.toString()));
    }

    const allUsers = [
      ...followingFiltered.map(u => ({
        _id: u._id,
        username: u.username,
        profilePic: u.profilePic || null,
        isPrivate: u.isPrivate || false,
        isFollowing: true,
      })),
      ...extraUsers.map(u => ({
        _id: u._id,
        username: u.username,
        profilePic: u.profilePic || null,
        isPrivate: false,
        isFollowing: false,
      })),
    ];

    return res.status(200).json({ success: true, users: allUsers, recent, groups });

  } catch (error) {
    console.error('getShareableUsers error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};