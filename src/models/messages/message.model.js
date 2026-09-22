import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    chatId: {
      type: String,
      required: true,
      index: true,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },

    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      default: null,
      index: true,
    },

    text: {
      type: String,
      default: "",
    },

    media: {
      url: { type: String },
      mediaType: {
        type: String,
        enum: ["image", "video", "audio", "file"],
      },
      fileName: { type: String },
      fileSize: { type: Number },
    },

    mediaExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    mediaExpired: {
      type: Boolean,
      default: false,
    },

    sharedPost: {
      postId: { type: mongoose.Schema.Types.ObjectId, ref: "Post", default: null },
      authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      caption: { type: String, default: "" },
      mediaUrl: { type: String, default: null },
      mediaType: { type: String, enum: ["image", "video", null], default: null },
      authorUsername: { type: String, default: "" },
      authorProfilePic: { type: String, default: null },

      kind: { type: String, enum: ["post", "story"], default: "post" },
      storyId: { type: mongoose.Schema.Types.ObjectId, ref: "Story", default: null },
    },

    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },

    isForwarded: {
      type: Boolean,
      default: false,
    },

    originalMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },

    isSystem: {
      type: Boolean,
      default: false,
    },

    isEphemeral: {
      type: Boolean,
      default: false,
    },

    // ── True only for "X mentioned you in their story" messages, created
    // automatically by addStory() when the author tags someone. Real
    // inbox content (carries a sharedPost.kind="story" preview + an "Add
    // to Your Story" action on the frontend), but auto-expires 3 days
    // after the story was posted — same window as media attachments —
    // regardless of the story's own 24h expiry. See jobs/expire.media.js
    // purgeOldMentionMessages().
    isMentionMessage: {
      type: Boolean,
      default: false,
    },

    mentionExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    seenBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    deletedForEveryone: {
      type: Boolean,
      default: false,
    },

    isEdited: {
      type: Boolean,
      default: false,
    },

    isMessageRequest: {
      type: Boolean,
      default: false,
    },

    requestStatus: {
      type: String,
      enum: ["none", "pending", "accepted", "declined"],
      default: "none",
    },
  },
  { timestamps: true }
);

export default mongoose.model("Message", messageSchema);