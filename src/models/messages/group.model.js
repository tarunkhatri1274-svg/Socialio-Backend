import mongoose from "mongoose";

const groupMemberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["pending", "accepted", "declined"], default: "pending" },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    role: { type: String, enum: ["admin", "member"], default: "member" },
    joinedAt: { type: Date, default: null },
    leftAt: { type: Date, default: null },
  },
  { _id: false }
);

const groupSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    avatar: { type: String, default: null },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    members: [groupMemberSchema],
    lastMessageAt: { type: Date, default: Date.now },
    lastMessageText: { type: String, default: "" },
    unreadCounts: { type: Map, of: Number, default: {} },
    clearedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    // Per-user chat wallpaper, same shape/logic as Conversation.wallpapers
    // in conversation.model.js — each member can set their own wallpaper
    // for this group without affecting anyone else's view of it.
    wallpapers: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

groupSchema.methods.acceptedMemberIds = function () {
  return this.members.filter((m) => m.status === "accepted").map((m) => m.user.toString());
};

groupSchema.methods.isAcceptedMember = function (userId) {
  return this.members.some((m) => m.status === "accepted" && m.user.toString() === userId.toString());
};

groupSchema.methods.isAdmin = function (userId) {
  return this.members.some(
    (m) => m.status === "accepted" && m.role === "admin" && m.user.toString() === userId.toString()
  );
};

export default mongoose.model("Group", groupSchema);