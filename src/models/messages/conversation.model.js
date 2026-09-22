import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, unique: true, index: true },

    members: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }],

    initiator: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    status: {
      type: String,
      enum: ["none", "pending", "accepted", "declined"],
      default: "none",
      index: true,
    },

    lastMessageAt: { type: Date, default: Date.now },
    lastMessageText: { type: String, default: "" },

    unreadCounts: { type: Map, of: Number, default: {} },

    clearedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    // Per-user chat wallpaper: { [userId]: { presetId, type, value, sticker,
    // stickerOpacity, stickerSize, stickerGap, icons, iconColor, iconOpacity,
    // iconSize, gap } }. Each participant can set their own wallpaper for
    // the same chat. A custom photo wallpaper stores its Cloudinary URL in
    // `value` — the old asset is deleted straight from that URL when it's
    // replaced (see destroyCloudinaryAsset in message.controllers.js), so
    // no separate publicId field is needed. Replaces the old AsyncStorage-
    // only version, which is why wallpapers used to "disappear".
    wallpapers: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

export default mongoose.model("Conversation", conversationSchema);