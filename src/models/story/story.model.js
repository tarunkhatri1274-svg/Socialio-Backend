import mongoose from "mongoose";

const storySchema = new mongoose.Schema(
  {
    // ================= AUTHOR =================
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ================= STORY TYPE =================
    storyType: {
      type: String,
      enum: ["text", "image", "video", "live"],
      required: true,
    },

    // ================= TEXT STORY =================
    text: {
      type: String,
      maxlength: 1000,
      default: "",
      trim: true,
    },

    // ================= MEDIA STORY =================
    media: {
      url: {
        type: String,
        default: "",
      },
      type: {
        type: String,
        enum: ["image", "video"],
      },
      publicId: {
        type: String,
        default: "",
      },
      resourceType: {
        type: String,
        enum: ["image", "video", "raw"],
        default: "image",
      },
      bytes: {
        type: Number,
        default: 0,
      },
    },

    // ================= TEXT STYLING (text-type stories) =================
    textStyle: {
      backgroundColor: { type: String, default: "#000000" },
      fontFamily: { type: String, default: "Arial" },
      textAlign: { type: String, enum: ["left", "center", "right"], default: "center" },
      color: { type: String, default: "#ffffff" },
      fontSize: { type: Number, default: 18 },
    },

    // ================= FILTER (baked into media at capture time) ========
    // Informational only — the actual pixels are already filtered
    // client-side via canvas before upload. Not used for rendering.
    filterApplied: { type: String, default: "none" },

    // ================= TEXT OVERLAYS (Instagram-style, image/video) =====
    textOverlays: [
      {
        text: { type: String, maxlength: 200 },
        x: { type: Number, default: 50 }, // % from left, 0-100
        y: { type: Number, default: 50 }, // % from top, 0-100
        color: { type: String, default: "#ffffff" },
        fontSize: { type: Number, default: 24 },
        fontFamily: { type: String, default: "Arial" },
        align: { type: String, enum: ["left", "center", "right"], default: "center" },
      },
    ],

    // ================= MENTIONS ============================================
    // username/profilePic are DENORMALIZED (copied in) at creation time in
    // addStory() — not populated on read. This avoids needing a `.populate`
    // on every getAllStories/getUserStories call just for mention chips,
    // and means the viewer always has a name to render even without an
    // extra query. If the mentioned user later changes their username/pic,
    // old stories simply keep showing the name at time of mention — same
    // tradeoff sharedPost.authorUsername already makes for chat shares.
    mentions: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        username: { type: String, default: "" },
        profilePic: { type: String, default: "" },
        x: { type: Number, default: 50 },
        y: { type: Number, default: 50 },
      },
    ],

    // ================= REPOST ("Add to Your Story") ========================
    // Set when created via "Add to Your Story" from a mention message.
    // Points at the ORIGINAL story and reuses its Cloudinary asset — this
    // doc must never destroy that asset on delete/expiry (see deleteStory
    // in story.controllers.js and jobs/expire.stories.js).
    repostOf: { type: mongoose.Schema.Types.ObjectId, ref: "Story", default: null },

// ── Attribution shown on a reposted story ("Story by @username" card,
// Instagram-style) — denormalized at repost time so the viewer always
// sees who the ORIGINAL author was, regardless of whether that story
// still exists. NOT the same as `mentions` (which is who the reposting
// user tagged in THEIR OWN story text) — this is purely "who did I get
// this from".
repostAttribution: {
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  username: { type: String, default: "" },
  profilePic: { type: String, default: "" },
},

    // ================= LIVE STORY =================
    isLive: {
      type: Boolean,
      default: false,
    },
    liveRoomId: {
      type: String,
      default: null,
    },
    liveEndedAt: {
      type: Date,
      default: null,
    },

    // ================= STORY VIEWS =================
    views: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        viewedAt: { type: Date, default: Date.now },
      },
    ],
    viewsCount: { type: Number, default: 0 },

    // ================= LIKES =================
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    likesCount: { type: Number, default: 0 },

    // ================= LIVE COMMENTS (ephemeral, socket-only mirror) ====
    comments: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        text: { type: String, maxlength: 500 },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // ================= REACTIONS =================
    reactions: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        emoji: { type: String, default: "❤️" },
      },
    ],

    // ================= VISIBILITY =================
    visibility: {
      type: String,
      enum: ["public", "followers", "private"],
      default: "followers",
    },

    allowReplies: { type: Boolean, default: true },
    allowReactions: { type: Boolean, default: true },

    // ================= EXPIRY (unchanged — still 24h) =================
    expiresAt: {
      type: Date,
      default: () => Date.now() + 24 * 60 * 60 * 1000,
    },
    isHiddenFromNonFollowers: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// TTL auto-delete (Mongo doc only) — see jobs/expire.stories.js for the
// Cloudinary side, which runs slightly ahead of this as a safety net.
storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

storySchema.index({ createdAt: -1 });
storySchema.index({ author: 1, createdAt: -1 });

export default mongoose.model("Story", storySchema);