import mongoose from "mongoose";

const notificationSettingsSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    message: { type: Boolean, default: true },
    post: { type: Boolean, default: true },
    reel: { type: Boolean, default: true },
    story: { type: Boolean, default: true },
    text: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model("NotificationSettings", notificationSettingsSchema);