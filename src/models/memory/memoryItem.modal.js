import mongoose from "mongoose";

// ================= REPLY SCHEMA (identical shape to Post's) =================
const memoryReplySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, maxlength: 500 },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    isEdited: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ================= COMMENT SCHEMA (identical shape to Post's) ===============
const memoryCommentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, maxlength: 1000 },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    replies: [memoryReplySchema],
    isEdited: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ================= MEMORY ITEM =================
// One image/video inside a MemoryGroup ("highlight"). A group can hold
// many of these — this is the equivalent of a single Story slide, except
// permanent. Comments/likes/replies work exactly like Post's, enforced
// with the same edit/delete-by-owner-only rules.
const memoryItemSchema = new mongoose.Schema(
  {
    group: { type: mongoose.Schema.Types.ObjectId, ref: "MemoryGroup", required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    media: {
      url: { type: String, required: true },
      type: { type: String, enum: ["image", "video"], required: true },
    },

    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    views: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    comments: [memoryCommentSchema],

    // Set once at creation time for THIS item specifically.
    disableComments: { type: Boolean, default: false },

    // Same convention as Post/Story — only followers can see this
    // specific item when true, on top of the normal private-account gate.
    isHiddenFromNonFollowers: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model("MemoryItem", memoryItemSchema);