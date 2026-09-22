import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      unique: true,
      sparse: true,  // ✅ allows multiple null values
      trim: true,
      minlength: 3,
      maxlength: 20,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      minlength: 6,  // ✅ removed required
    },

    googleId: {
      type: String,
      default: null,
    },

    age: {
      type: Number,
      min: 18,
    },

    gender: {
      type: String,
      enum: ["male", "female", "other"],
    },

    profilePic: {
      type: String,
      default: "",
    },

    bio: {
      type: String,
      maxlength: 200,
      default: "",
    },

    coverPic: {
      type: String,
      default: "",
    },

    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    following: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    posts: [{ type: mongoose.Schema.Types.ObjectId, ref: "Post" }],
    savedPosts: [{ type: mongoose.Schema.Types.ObjectId, ref: "Post" }],

    otp: String,
    otpExpires: Date,
    otpLastSentAt: Date,

    isOtpVerified: {
      type: Boolean,
      default: false,
    },

    // ✅ NEW: scoped specifically to the forgot-password flow, so a stale
    // signup-time OTP verification can never be reused to reset a password.
    resetOtpVerified: {
      type: Boolean,
      default: false,
    },
    resetOtpVerifiedExpires: {
      type: Date,
      default: null,
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    // ⚠️ Not referenced anywhere in the current controllers — looks like a
    // leftover from an earlier token-based reset approach. Left in place
    // since removing a field is a breaking change; confirm nothing else in
    // your codebase (routes, older client code) still relies on it before
    // deleting.
    resetPasswordToken: String,
    resetPasswordExpires: Date,

    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },

    isPrivate: {
      type: Boolean,
      default: false,
    },

    followRequests: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
// models/user/user.model.js — add this field to userSchema

    // ── Per-user mute settings (Instagram-style). You still follow them,
    // but choose which of their activity you're notified about / shown.
    mutedUsers: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        muteStory: { type: Boolean, default: false },
        mutePost: { type: Boolean, default: false },
        muteMessage: { type: Boolean, default: false },
      },
    ],
    blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);