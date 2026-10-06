import mongoose from "mongoose";

// ================= POLL SCHEMA (used by poll comments) =================
const pollOptionSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 100 },
  votes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
});

const pollSchema = new mongoose.Schema(
  {
    question: { type: String, required: true, trim: true, maxlength: 250 },
    allowMultiple: { type: Boolean, default: true },
    options: { type: [pollOptionSchema], default: [] },
  },
  { _id: false }
);

// ================= REPLY SCHEMA =================
const replySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, maxlength: 500 },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    isEdited: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ================= COMMENT SCHEMA =================
const commentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, maxlength: 1000 },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    replies: [replySchema],
    isEdited: { type: Boolean, default: false },
    // Poll comment: `text` holds the question so previews/notifications work.
    poll: { type: pollSchema, default: undefined },
    // Pinned by the POST OWNER (max 3 per post, enforced in comment controller).
    isPinned: { type: Boolean, default: false },
    pinnedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// ================= COLLABORATOR SCHEMA =================
// Upgraded from a flat ObjectId array to a status-tracked subdocument so
// a collaborator must ACCEPT before the post shows on their own profile.
// The post always remains visible on the original author's profile
// regardless of this status (see media.controllers.js / usercontroller.js).
const collaboratorSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["pending", "accepted", "declined"], default: "pending" },
    invitedAt: { type: Date, default: Date.now },
    respondedAt: { type: Date, default: null },
  },
  { _id: false }
);

// ================= POST SCHEMA =================
const postSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    collaborators: [collaboratorSchema],
    postType: { type: String, enum: ["text", "image", "video", "carousel"], required: true },
    text: { type: String, maxlength: 2000, default: "" },
    caption: { type: String, maxlength: 1000, default: "" },

    media: [
      {
        url: { type: String },
        type: { type: String, enum: ["image", "video"] },
      },
    ],

    tags: [{ type: String, lowercase: true, trim: true }],
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    comments: [commentSchema],

    // ================= SHARES =================
    shares: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        sharedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // ================= views =================
    views: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", default: [] }],
    // ================= COUNTS =================
    commentsCount: { type: Number, default: 0 },
    sharesCount: { type: Number, default: 0 },
    savesCount: { type: Number, default: 0 },

    // ================= VISIBILITY =================
    visibility: { type: String, enum: ["public", "private", "followers"], default: "public" },

    // ================= PER-POST DISPLAY / INTERACTION SETTINGS =================
    // Set once at creation time from CreateImagePost.jsx's "Advanced
    // settings" toggles. The post OWNER always sees real counts and
    // always keeps download access regardless of these flags — they only
    // restrict what OTHER viewers see/can do (enforced in the frontend
    // PostCard and, for download, should also be treated as a UX-only
    // gate since the media URL itself is still technically fetchable by
    // anyone with the link).
    hideLikeCount: { type: Boolean, default: false },
    hideCommentCount: { type: Boolean, default: false },
    disableDownload: { type: Boolean, default: false },
    // ← Fully disables commenting for everyone but the owner (distinct
    // from hideCommentCount, which just hides the number). Enforced in
    // the frontend by hiding the comment button/sheet; for real
    // enforcement (not just UI), your comment-creation controller
    // should also check this flag server-side — see the note in
    // media.controllers.js.
    disableComments: { type: Boolean, default: false },

    // ================= OPTIONAL =================
    isArchived: { type: Boolean, default: false },
    isEdited: { type: Boolean, default: false },
    notInterested: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", default: [] }],
    isHiddenFromNonFollowers: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model("Post", postSchema);