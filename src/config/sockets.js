import { Server } from "socket.io";
import Story from "../models/story/story.model.js";
import User from "../models/user/user.model.js";
import { isBlockedEitherWay } from "../utils/blockCheck.js";

let io;
export const onlineUsers = new Map();
const liveRooms = new Map();

// ── STORY ACCESS RULE ───────────────────────────────────────────────────
const canAccessStory = async (story, viewerId) => {
  if (!story || !viewerId) return false;
  const authorId = story.author.toString();
  if (authorId === viewerId.toString()) return true;

  const blocked = await isBlockedEitherWay(authorId, viewerId);
  if (blocked) return false;

  if (!story.isHiddenFromNonFollowers) return true;

  const owner = await User.findById(authorId).select("followers");
  if (!owner) return false;
  return owner.followers.some((id) => id.toString() === viewerId.toString());
};

// ── PER-ROOM EVENT QUEUE ─────────────────────────────────────────────────
// joinLive/leaveLive each do async DB lookups (Story/User) before emitting
// to the room. Because joinLive awaits *two* lookups (access check + user
// info) while leaveLive only awaits *one*, they can resolve out of order —
// e.g. a leaveLive fired a moment after a joinLive can finish first and
// emit "viewerLeft" before the earlier "viewerJoined" ever goes out, even
// though the join genuinely happened first. This queue forces every
// joinLive/leaveLive for a given room to run strictly one-at-a-time, in
// the order the socket events were received, so the emitted order always
// matches reality.
const roomQueues = new Map();
const enqueueRoomTask = (roomId, task) => {
  const prev = roomQueues.get(roomId) || Promise.resolve();
  const next = prev.then(task, task); // run task even if the previous one errored
  roomQueues.set(roomId, next);
  return next;
};

// ── VIEWER PRESENCE (de-duplicated join/leave) ────────────────────────────
// A viewer can trigger join/leave far more often than they actually
// "arrive"/"depart" — multiple tabs, a flaky connection reconnecting, or
// (in dev) React StrictMode's mount→unmount→remount. Naively re-broadcasting
// every raw event produces spam like "left / left / joined / joined ...".
//
// Fix: track a reference count per viewer per room (room.activeViewers,
// set up in startLive), and only emit a real "viewerJoined"/"viewerLeft"
// on a genuine 0→1 / 1→0 transition. A "leave" that drops the count to 0
// is held for a short grace window before it's actually announced — if a
// rejoin lands within that window it just cancels the pending leave and
// nothing is emitted, since the viewer never really left.
const LEAVE_GRACE_MS = 500;

const lookupViewerInfo = async (viewerId) => {
  try {
    const viewerUser = await User.findById(viewerId).select("username profilePic");
    if (viewerUser) return { username: viewerUser.username, profilePic: viewerUser.profilePic || "" };
  } catch (e) {
    console.error("viewer lookup error:", e.message);
  }
  return { username: "Someone", profilePic: "" };
};

const presenceJoin = async (room, roomId, viewerId) => {
  const entry = room.activeViewers.get(viewerId) || { count: 0, leaveTimer: null };

  if (entry.leaveTimer) {
    // Rejoined within the grace window of a pending leave — cancel it.
    // The viewer never really left, so no event goes out at all.
    clearTimeout(entry.leaveTimer);
    entry.leaveTimer = null;
    entry.count += 1;
    room.activeViewers.set(viewerId, entry);
    return;
  }

  entry.count += 1;
  room.activeViewers.set(viewerId, entry);
  if (entry.count !== 1) return; // already counted as present (another tab) — no duplicate event

  const viewerInfo = await lookupViewerInfo(viewerId);
  io.to(roomId).emit("viewerJoined", { viewerId, ...viewerInfo });
};

const presenceLeave = (room, roomId, viewerId) => {
  const entry = room.activeViewers.get(viewerId);
  if (!entry || entry.count <= 0) return; // no matching join on record — ignore stray/duplicate leave

  entry.count -= 1;
  if (entry.count > 0) {
    room.activeViewers.set(viewerId, entry); // another tab/session still open
    return;
  }

  entry.leaveTimer = setTimeout(async () => {
    room.activeViewers.delete(viewerId);
    const viewerInfo = await lookupViewerInfo(viewerId);
    io.to(roomId).emit("viewerLeft", { viewerId, ...viewerInfo });
  }, LEAVE_GRACE_MS);
  room.activeViewers.set(viewerId, entry);
};

export const initSocket = (httpServer) => {
const allowedOrigins = [
process.env.FRONTEND_URL
];

io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (
          allowedOrigins.includes(origin) ||
          /\.ngrok-free\.(dev|app)$/.test(new URL(origin).hostname)
        ) {
          return callback(null, true);
        }
        return callback(new Error("Not allowed by CORS"));
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    // ── REGISTER ───────────────────────────────────────────────────────────
    socket.on("register", (userId) => {
      if (userId) {
        socket.userId = userId.toString();
        socket.join(`user:${userId}`);
        onlineUsers.set(userId.toString(), socket.id);
        io.emit("onlineUsers", Array.from(onlineUsers.keys()));
      }
    });

    // ── ROOM JOINS ─────────────────────────────────────────────────────────
    socket.on("joinPost",      (postId)  => socket.join(`post:${postId}`));
    socket.on("leavePost",     (postId)  => socket.leave(`post:${postId}`));
    socket.on("joinUserRoom",  (userId)  => socket.join(`user:${userId}`));
    socket.on("leaveUserRoom", (userId)  => socket.leave(`user:${userId}`));

    // ── MEMORY ITEM ROOM — likes/comments/replies on a memory item are
    // all done over REST (see memory.controllers.js), exactly like posts.
    // Joining this room just lets this client RECEIVE those live
    // `memoryItem:{id}:...` broadcasts; no access check is done on join
    // itself (same convention as joinPost above) since every REST action
    // that actually reads/writes data re-checks access server-side.
    socket.on("joinMemoryItem",  (itemId) => socket.join(`memoryItem:${itemId}`));
    socket.on("leaveMemoryItem", (itemId) => socket.leave(`memoryItem:${itemId}`));

    // ── LIVE: GET FOLLOWERS LIST ───────────────────────────────────────────
    socket.on("getFollowers", async ({ userId, viewerId }) => {
      try {
        const user = await User.findById(userId)
          .select("followers isPrivate")
          .populate("followers", "_id username profilePic");

        if (!user) return socket.emit("followersList", { userId, followers: [], error: "not_found" });

        if (user.isPrivate && userId !== viewerId) {
          const isFollower = (user.followers || []).some(
            (f) => (f._id ?? f).toString() === viewerId
          );
          if (!isFollower) {
            return socket.emit("followersList", { userId, followers: [], restricted: true });
          }
        }

        socket.emit("followersList", { userId, followers: user.followers });
      } catch (e) {
        console.error("getFollowers socket error:", e.message);
        socket.emit("followersList", { userId, followers: [] });
      }
    });

    // ── LIVE: GET FOLLOWING LIST ───────────────────────────────────────────
    socket.on("getFollowing", async ({ userId, viewerId }) => {
      try {
        const user = await User.findById(userId)
          .select("following followers isPrivate")
          .populate("following", "_id username profilePic");

        if (!user) return socket.emit("followingList", { userId, following: [], error: "not_found" });

        if (user.isPrivate && userId !== viewerId) {
          const isFollower = (user.followers || []).some(
            (f) => (f._id ?? f).toString() === viewerId
          );
          if (!isFollower) {
            return socket.emit("followingList", { userId, following: [], restricted: true });
          }
        }

        socket.emit("followingList", { userId, following: user.following });
      } catch (e) {
        console.error("getFollowing socket error:", e.message);
        socket.emit("followingList", { userId, following: [] });
      }
    });

    // ── LIVE: GET FOLLOW REQUESTS (owner only) ─────────────────────────────
    socket.on("getFollowRequests", async ({ userId, viewerId }) => {
      try {
        if (userId !== viewerId) {
          return socket.emit("followRequestsList", { requests: [], restricted: true });
        }
        const user = await User.findById(userId)
          .select("followRequests")
          .populate("followRequests", "_id username profilePic");

        if (!user) return socket.emit("followRequestsList", { requests: [] });
        socket.emit("followRequestsList", { requests: user.followRequests });
      } catch (e) {
        console.error("getFollowRequests socket error:", e.message);
        socket.emit("followRequestsList", { requests: [] });
      }
    });

    // ── JOIN STORY ROOM ────────────────────────────────────────────────────
    socket.on("joinStory", async ({ storyId, viewerId }) => {
      try {
        const story = await Story.findById(storyId).select("author isHiddenFromNonFollowers");
        if (!story) return socket.emit("storyAccessDenied", { storyId, reason: "not_found" });
        const allowed = await canAccessStory(story, viewerId);
        if (!allowed) return socket.emit("storyAccessDenied", { storyId, reason: "not_following" });
        socket.join(`story:${storyId}`);
      } catch (e) {
        console.error("joinStory error:", e.message);
      }
    });

    socket.on("leaveStory", (storyId) => socket.leave(`story:${storyId}`));

    // ── STORY COMMENT ──────────────────────────────────────────────────────
    socket.on("storyComment", async ({ storyId, userId, username, text }) => {
      if (!storyId || !userId || !text?.trim()) return;
      try {
        const story = await Story.findById(storyId).select("author comments isHiddenFromNonFollowers");
        if (!story) return;
        const allowed = await canAccessStory(story, userId);
        if (!allowed) return;
        const comment = { user: userId, text: text.trim(), createdAt: new Date() };
        story.comments.push(comment);
        if (story.comments.length > 200) story.comments = story.comments.slice(-200);
        await story.save();
        io.to(`story:${storyId}`).emit(`story:${storyId}:comment`, {
          userId, username, text: comment.text, createdAt: comment.createdAt,
        });
      } catch (e) {
        console.error("storyComment error:", e.message);
      }
    });

    // ── FOLLOW EVENTS ──────────────────────────────────────────────────────
    socket.on("followUser", ({ fromUserId, toUserId }) => {
      io.to(`user:${toUserId}`).emit("userFollowed", { fromUserId, toUserId });
      const targetSocketId = onlineUsers.get(toUserId?.toString());
      if (targetSocketId) io.to(targetSocketId).emit("newFollower", { fromUserId });
    });

    socket.on("unfollowUser", ({ toUserId }) => {
      const fromUserId = [...onlineUsers.entries()].find(([, sid]) => sid === socket.id)?.[0];
      io.to(`user:${toUserId}`).emit("userUnfollowed", { fromUserId, toUserId });
    });

    socket.on("followRequest", ({ fromUserId, toUserId }) => {
      const targetSocketId = onlineUsers.get(toUserId?.toString());
      if (targetSocketId) io.to(targetSocketId).emit("newFollowRequest", { fromUserId });
    });

    socket.on("followAccepted", ({ fromUserId, toUserId }) => {
      const requesterSocketId = onlineUsers.get(fromUserId?.toString());
      if (requesterSocketId) io.to(requesterSocketId).emit("followAccepted", { from: fromUserId, toUserId });
      io.to(`user:${toUserId}`).emit("userFollowed", { fromUserId, toUserId });
    });

    socket.on("followRejected", ({ fromUserId, toUserId }) => {
      const requesterSocketId = onlineUsers.get(fromUserId?.toString());
      if (requesterSocketId) io.to(requesterSocketId).emit("followRejected", { to: fromUserId });
    });

    socket.on("privacyToggled", ({ userId, isPrivate }) => {
      io.emit("privacyChanged", { userId, isPrivate });
    });

    socket.on("postCreated", ({ post, authorId }) => {
      io.to(`user:${authorId}`).emit("newPost", { post });
    });

    socket.on("postRemoved", ({ postId, authorId }) => {
      io.to(`user:${authorId}`).emit("postDeleted", { postId });
    });

    // ── CHAT ───────────────────────────────────────────────────────────────
    socket.on("sendMessage", ({ to, from, text, conversationId }) => {
      const recipientSocketId = onlineUsers.get(to?.toString());
      if (recipientSocketId)
        io.to(recipientSocketId).emit("receiveMessage", { from, text, conversationId, createdAt: new Date() });
    });

    socket.on("typing", ({ to, from }) => {
      const recipientSocketId = onlineUsers.get(to?.toString());
      if (recipientSocketId) io.to(recipientSocketId).emit("typing", { from });
    });

    socket.on("stopTyping", ({ to, from }) => {
      const recipientSocketId = onlineUsers.get(to?.toString());
      if (recipientSocketId) io.to(recipientSocketId).emit("stopTyping", { from });
    });

    socket.on("sendNotification", ({ to, type, from, postId }) => {
      const recipientSocketId = onlineUsers.get(to?.toString());
      if (recipientSocketId)
        io.to(recipientSocketId).emit("receiveNotification", { type, from, postId, createdAt: new Date() });
    });

    // ── LIVE STREAMING ─────────────────────────────────────────────────────
    socket.on("startLive", async ({ roomId, hostId, username, storyId }) => {
      liveRooms.set(roomId, {
        hostId, username, socketId: socket.id, storyId,
        // viewerId -> { count, leaveTimer }. See presenceJoin/presenceLeave
        // at module scope above — that's what actually de-duplicates
        // join/leave spam.
        activeViewers: new Map(),
      });
      socket.join(roomId);
      socket.join(`story:${storyId}`);
      try {
        const host = await User.findById(hostId).select("followers");
        const followerIds = (host?.followers || []).map((id) => id.toString());
        followerIds.forEach((fid) => {
          const sid = onlineUsers.get(fid);
          if (sid) io.to(sid).emit("someoneLive", { roomId, hostId, username, storyId });
        });
      } catch (e) {
        console.error("startLive notify error:", e.message);
      }
    });

    // ── JOIN LIVE ──────────────────────────────────────────────────────────
    // Queued per-room (enqueueRoomTask) so a join/leave pair for the same
    // room can never process out of order relative to one another.
    socket.on("joinLive", ({ roomId, viewerId }) => enqueueRoomTask(roomId, async () => {
      const room = liveRooms.get(roomId);
      if (!room) return socket.emit("liveAccessDenied", { roomId, reason: "ended" });

      let allowed;
      if (room.storyId) {
        const story = await Story.findById(room.storyId).select("author isHiddenFromNonFollowers");
        allowed = story
          ? await canAccessStory(story, viewerId)
          : !(await isBlockedEitherWay(room.hostId, viewerId));
      } else {
        allowed = !(await isBlockedEitherWay(room.hostId, viewerId));
      }

      if (!allowed) return socket.emit("liveAccessDenied", { roomId, reason: "not_following" });

      socket.join(roomId);
      socket.join(`story:${room.storyId}`);

      // Remember this on the socket so a raw disconnect (tab closed,
      // network drop) can still be treated as a leave even though the
      // client never got to emit leaveLive.
      socket.data.liveRoomsJoined = socket.data.liveRoomsJoined || new Map();
      socket.data.liveRoomsJoined.set(roomId, viewerId);

      await presenceJoin(room, roomId, viewerId);
    }));

    // ── LEAVE LIVE ─────────────────────────────────────────────────────────
    socket.on("leaveLive", ({ roomId, viewerId }) => enqueueRoomTask(roomId, async () => {
      socket.leave(roomId);
      const room = liveRooms.get(roomId);
      if (!room) return;
      socket.leave(`story:${room.storyId}`);
      socket.data.liveRoomsJoined?.delete(roomId);
      presenceLeave(room, roomId, viewerId);
    }));

    socket.on("endLive", ({ roomId }) => {
      const room = liveRooms.get(roomId);
      if (room?.activeViewers) {
        for (const entry of room.activeViewers.values()) {
          if (entry.leaveTimer) clearTimeout(entry.leaveTimer);
        }
      }
      io.to(roomId).emit("liveEnded", { roomId, storyId: room?.storyId });
      liveRooms.delete(roomId);
      roomQueues.delete(roomId);
      socket.leave(roomId);
    });

    socket.on("getLiveRooms", () => {
      socket.emit("liveRooms",
        Array.from(liveRooms.entries()).map(([roomId, data]) => ({
          roomId, hostId: data.hostId, username: data.username,
        }))
      );
    });

    // ── WEBRTC (1:1 calls only — group calling has been removed) ───────────
    socket.on("liveOffer", ({ to, offer }) => {
      const recipientSocketId = onlineUsers.get(to?.toString());
      if (recipientSocketId) io.to(recipientSocketId).emit("liveOffer", { from: socket.userId, offer });
    });

    socket.on("callOffer", ({ to, offer, type }) => {
      const recipientSocketId = onlineUsers.get(to?.toString());
      const fromUserId = [...onlineUsers.entries()].find(([, sid]) => sid === socket.id)?.[0];
      if (recipientSocketId) io.to(recipientSocketId).emit("callOffer", { from: fromUserId, offer, type });
    });

    socket.on("liveAnswer", ({ to, answer }) => {
      const recipientSocketId = onlineUsers.get(to?.toString());
      const fromUserId = [...onlineUsers.entries()].find(([, sid]) => sid === socket.id)?.[0];
      if (recipientSocketId) {
        io.to(recipientSocketId).emit("liveAnswer", { from: fromUserId, answer });
      }
    });

    socket.on("callRejected",  ({ to }) => { const s = onlineUsers.get(to?.toString()); if (s) io.to(s).emit("callRejected"); });
    socket.on("callEnded",     ({ to }) => { const s = onlineUsers.get(to?.toString()); if (s) io.to(s).emit("callEnded"); });
    socket.on("callCancelled", ({ to }) => { const s = onlineUsers.get(to?.toString()); if (s) io.to(s).emit("callCancelled"); });
    socket.on("callBusy",      ({ to }) => { const s = onlineUsers.get(to?.toString()); if (s) io.to(s).emit("callBusy"); });
    socket.on("liveCancelled", ({ to }) => { const s = onlineUsers.get(to?.toString()); if (s) io.to(s).emit("liveCancelled"); });
    socket.on("callConnected", ({ to }) => { const s = onlineUsers.get(to?.toString()); if (s) io.to(s).emit("callConnected"); });
    socket.on("iceCandidate", ({ to, candidate }) => {
      const recipientSocketId = onlineUsers.get(to?.toString());
      const fromUserId = [...onlineUsers.entries()].find(([, sid]) => sid === socket.id)?.[0];
      if (recipientSocketId) io.to(recipientSocketId).emit("iceCandidate", { from: fromUserId, candidate });
    });

    // ── NEW STORY ──────────────────────────────────────────────────────────
    socket.on("newStory", ({ authorId, storyId }) => {
      io.emit("storyAdded", { authorId, storyId });
    });

    // ── DISCONNECT ─────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      for (const [userId, socketId] of onlineUsers.entries()) {
        if (socketId === socket.id) {
          onlineUsers.delete(userId);
          io.emit("onlineUsers", Array.from(onlineUsers.keys()));
          break;
        }
      }

      // If this socket was watching any live(s) and the tab just closed /
      // connection dropped without a clean leaveLive, run it through the
      // same de-duplicated presence logic so the audience still gets a
      // correct (and single) "left the live" — instead of nothing, or a
      // stray duplicate if they reconnect and rejoin moments later.
      if (socket.data.liveRoomsJoined) {
        for (const [roomId, viewerId] of socket.data.liveRoomsJoined.entries()) {
          const room = liveRooms.get(roomId);
          if (room) presenceLeave(room, roomId, viewerId);
        }
        socket.data.liveRoomsJoined.clear();
      }

      for (const [roomId, room] of liveRooms.entries()) {
        if (room.socketId === socket.id) {
          if (room.activeViewers) {
            for (const entry of room.activeViewers.values()) {
              if (entry.leaveTimer) clearTimeout(entry.leaveTimer);
            }
          }
          io.to(roomId).emit("liveEnded", { roomId, storyId: room.storyId });
          liveRooms.delete(roomId);
          roomQueues.delete(roomId);
          break;
        }
      }
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized yet");
  return io;
};