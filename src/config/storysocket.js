import Story from "../models/story/story.model.js";
import User from "../models/user/user.model.js";

// ── IMPORTANT: adjust the field name below to match your actual User
// schema. This assumes a `blockedUsers` array of ObjectIds on User (set
// by whatever your `/auth/block/:authorId` endpoint writes to). If your
// schema calls it something else (e.g. `blocked`), change every
// `.select("blockedUsers")` / `.blockedUsers` reference below to match.
async function isBlockedEitherWay(userAId, userBId) {
  if (!userAId || !userBId) return false;
  if (userAId.toString() === userBId.toString()) return false;

  const [userA, userB] = await Promise.all([
    User.findById(userAId).select("blockedUsers"),
    User.findById(userBId).select("blockedUsers"),
  ]);

  const aBlockedB = (userA?.blockedUsers || []).some((id) => id.toString() === userBId.toString());
  const bBlockedA = (userB?.blockedUsers || []).some((id) => id.toString() === userAId.toString());

  return aBlockedB || bBlockedA;
}

// ── Permission rule for commenting/reacting on a story, in priority order:
//   1) Story owner can always comment on their own story.
//   2) A block in EITHER direction always wins — a blocked user can never
//      comment, even on an otherwise fully public story, and even if they
//      somehow still follow the author (or vice versa).
//   3) If the story is NOT hidden from non-followers, ANY non-blocked
//      user can comment — following, follower, or neither. This covers
//      "random"/public stories and live stories alike, since live
//      stories default to isHiddenFromNonFollowers: false unless the
//      host explicitly hides them.
//   4) Only if the story IS hidden from non-followers does a follow
//      relationship get checked at all.
async function canCommentOnStory(story, commenterId) {
  const authorId = story.author.toString();

  if (authorId === commenterId.toString()) return true;

  const blocked = await isBlockedEitherWay(authorId, commenterId);
  if (blocked) return false;

  if (!story.isHiddenFromNonFollowers) return true;

  const owner = await User.findById(authorId).select("followers");
  if (!owner) return false;
  return owner.followers.some((id) => id.toString() === commenterId.toString());
}

// Call this once per connected socket, from inside your existing
// io.on("connection", (socket) => { ... }) block:
//
//   import { registerStorySocketHandlers } from "./storySocketHandlers.js";
//   io.on("connection", (socket) => {
//     registerStorySocketHandlers(io, socket);
//     // ...your other existing handlers (messages, notifications, etc.)
//   });
//
// If you ALREADY have inline "joinStory" / "leaveStory" / "storyComment"
// handlers elsewhere in your connection callback, DELETE those three and
// let this module own them instead — having two listeners for the same
// event on the same socket will double-broadcast every comment.
export function registerStorySocketHandlers(io, socket) {
  socket.on("joinStory", ({ storyId }) => {
    if (storyId) socket.join(`story:${storyId}`);
  });

  socket.on("leaveStory", (storyId) => {
    if (storyId) socket.leave(`story:${storyId}`);
  });

  socket.on("storyComment", async ({ storyId, userId, username, text }) => {
    try {
      if (!storyId || !userId || !text?.trim()) return;

      const story = await Story.findById(storyId).select("author comments isHiddenFromNonFollowers");
      if (!story) return;

      const allowed = await canCommentOnStory(story, userId);
      if (!allowed) {
        // Silently drop — matches the existing pattern where a denied
        // socket action just doesn't broadcast, rather than emitting a
        // visible error back to the sender. If you want the sender to
        // see feedback (e.g. "You can't comment on this story"), emit a
        // targeted event back to socket.id here instead of returning.
        return;
      }

      const comment = { user: userId, text: text.trim(), createdAt: new Date() };
      story.comments.push(comment);
      if (story.comments.length > 200) story.comments = story.comments.slice(-200);
      await story.save();

      io.to(`story:${storyId}`).emit(`story:${storyId}:comment`, {
        userId,
        username,
        text: comment.text,
        createdAt: comment.createdAt,
      });
    } catch (err) {
      console.error("[storySocket] storyComment error:", err.message);
    }
  });
}

export { canCommentOnStory, isBlockedEitherWay };