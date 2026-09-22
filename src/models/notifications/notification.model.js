import mongoose from "mongoose";

// ─────────────────────────────────────────────────────────────────────────
// Notification types covered:
//   follow            → "started following you"
//   follow_request    → "sent you a follow request"
//   follow_accepted   → "accepted your follow request"
//   like_post         → "liked your post"
//   comment           → "commented on your post"
//   reply             → "replied to your comment"
//   like_comment      → "liked your comment"
//   like_reply        → "liked your reply"
//   message           → "sent you a message"
//   collab_request    → "invited you to collaborate" / "added you as a collaborator"
//   story_view        → "viewed your story"  (optional, off by default)
//   story_like        → "liked your story"
//   memory_like       → "liked your memory"
//   memory_comment    → "commented on your memory"
//   memory_reply      → "replied to your comment on a memory"
//   memory_like_comment → "liked your comment on a memory"
// ─────────────────────────────────────────────────────────────────────────

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
type: {
  type: String,
  enum: [
    "follow",
    "follow_request",
    "follow_accepted",
    "like_post",
    "comment",
    "reply",
    "like_comment",
    // ← NEW — liking a reply previously called createNotification() with
    // no matching enum entry at all, so Notification.create() would have
    // thrown a validation error (silently swallowed by createNotification's
    // try/catch) every time. See comment.controllers.js's likeReply.
    "like_reply",
    "message",
    "collab_request",
    "story_view",
    "story_like",
    "new_post",
    "story_live",
    // ← NEW — without these four, Notification.create() throws a Mongoose
    // enum-validation error for every memory like/comment/reply/comment-like,
    // which createNotification() swallows silently (returns null). That is
    // why memory notifications never showed up at all before this fix.
    "memory_like",
    "memory_comment",
    "memory_reply",
    "memory_like_comment",
    // ← NEW — liking a memory reply previously called createNotification()
    // with no matching enum entry, same gap as like_reply. See
    // memory.controllers.js's likeMemoryReply.
    "memory_like_reply",
  ],
  required: true,
},
    message: {
      type: String,
      required: true,
      // mongoose's built-in `required` only rejects null/undefined — an
      // empty string "" still passes as "present". A custom validator
      // catches that case too, so a notification can never silently save
      // with no human-readable text (which is what produced the
      // "Someone sent you a notification" fallback on the frontend).
      validate: {
        validator: (v) => typeof v === "string" && v.trim().length > 0,
        message: "Notification message cannot be empty",
      },
    },

    // Generic reference fields — only the relevant ones get filled per type
    post: { type: mongoose.Schema.Types.ObjectId, ref: "Post" },
    // ← lets server AND client gate "Reel" / "Text" notification mute
    // categories correctly, since like_post/comment fire identically
    // regardless of whether the underlying post is an image, video
    // (reel), or text post. Populated at notification-creation time from
    // the post's own postType — see notification.helper.js.
    postType: { type: String, enum: ["text", "image", "video", "carousel"], default: null },
    comment: { type: mongoose.Schema.Types.ObjectId }, // subdoc id, not a separate collection
    reply: { type: mongoose.Schema.Types.ObjectId },
    story: { type: mongoose.Schema.Types.ObjectId, ref: "Story" },
    chatId: { type: String },

    // ← NEW — the highlight group + the specific item inside it that the
    // memory_* notification is about. Both are needed to deep-link: the
    // group tells MemoryViewer which "highlight" to open, the item tells
    // it which slide to land on. See notification.helper.js /
    // memory.controllers.js for where these get populated, and
    // ActivityPage.jsx / Profilepage.jsx / UserProfileView.jsx for where
    // they get consumed to actually open the viewer.
    memoryGroup: { type: mongoose.Schema.Types.ObjectId, ref: "MemoryGroup" },
    memoryItem:  { type: mongoose.Schema.Types.ObjectId, ref: "MemoryItem" },

    // ← NEW — the owner of the content this notification refers to
    // (memory item / story author). Usually equal to `recipient` (only
    // owners get memory_like/memory_comment/story_like notifications),
    // EXCEPT memory_like_comment/memory_reply, where `recipient` is the
    // comment's author, not necessarily the memory's owner. Needed so
    // the frontend knows whose profile to open MemoryViewer/StoryViewer
    // against without guessing from `sender` (which is the ACTOR —
    // liker/commenter/viewer — not the owner). See notification.helper.js
    // and memory.controllers.js / story.controllers.js for where this
    // gets populated.
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    link: { type: String }, // optional frontend route, e.g. `/post/${postId}`

    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Newest first, per recipient — this is the access pattern for the inbox
notificationSchema.index({ recipient: 1, createdAt: -1 });

export default mongoose.model("Notification", notificationSchema);