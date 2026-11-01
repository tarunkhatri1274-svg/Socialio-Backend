// utils/blockHelper.js
// Single source of truth for "strict" (two-way) blocking, Instagram-style.
// If A blocks B, then A and B become invisible to each other everywhere.

import User from "../models/user/user.model.js";

/**
 * All ids that should be hidden from `viewerId`:
 *  - iBlocked  : users the viewer blocked
 *  - blockedMe : users who blocked the viewer
 *  - hidden    : union of both (use this for search / feeds / lists)
 */
export const getBlockedIdSets = async (viewerId) => {
  const viewer = String(viewerId);
  const [me, blockers] = await Promise.all([
    User.findById(viewer).select("blockedUsers").lean(),
    User.find({ blockedUsers: viewer }).select("_id").lean(),
  ]);
  const iBlocked  = (me?.blockedUsers ?? []).map(String);
  const blockedMe = blockers.map((u) => String(u._id));
  return { iBlocked, blockedMe, hidden: [...new Set([...iBlocked, ...blockedMe])] };
};

/** true if either user has blocked the other */
export const isBlockedEitherWay = async (a, b) => {
  if (!a || !b) return false;
  const found = await User.exists({
    $or: [
      { _id: String(a), blockedUsers: String(b) },
      { _id: String(b), blockedUsers: String(a) },
    ],
  });
  return !!found;
};

/** true if `targetId` has blocked `viewerId` */
export const hasBlockedMe = async (targetId, viewerId) =>
  !!(await User.exists({ _id: String(targetId), blockedUsers: String(viewerId) }));

/** true if the post's author and the viewer have blocked each other (viewer is never blocked from own post) */
export const isPostBlockedFor = async (post, viewerId) => {
  const authorId = post?.author?._id ?? post?.author;
  if (!authorId || String(authorId) === String(viewerId)) return false;
  return isBlockedEitherWay(viewerId, authorId);
};

/**
 * Live list updates (followersList / followingList) are sent to a whole socket room.
 * This sends each viewer in the room THEIR OWN filtered copy, so people blocked in
 * either direction never reappear. Event name and payload shape are unchanged.
 */
export const emitListPerViewer = async (io, room, event, listKey, payload) => {
  try {
    const sockets = await io.in(room).fetchSockets();
    await Promise.all(
      sockets.map(async (s) => {
        const viewerId = s.data?.userId || s.userId;
        let list = payload[listKey] || [];
        if (viewerId) {
          const { hidden } = await getBlockedIdSets(viewerId);
          list = hidden.includes(String(payload.userId))
            ? []
            : list.filter((u) => !hidden.includes(String(u._id ?? u)));
        }
        io.to(s.id).emit(event, { ...payload, [listKey]: list });
      })
    );
  } catch (e) {
    console.error("emitListPerViewer failed:", e.message);
    io.to(room).emit(event, payload); // fall back to the original behaviour
  }
};