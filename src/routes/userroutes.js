import express from "express";
import rateLimit from "express-rate-limit";
import {sendOtp, verifyOtp, registerUser,
  loginUser,forgotPassword, resetPassword, getUserProfile,
   updateProfile, deleteAccount,changePassword,searchUsers,
   getUserById,getPostsByUserId,unfollowUser,followUser,
  blockUser,unblockUser,getBlockedUsers,getPublicReels,resendOtp,
  googleLogin,googleSignup,logoutUser,getPostById,refreshAccessToken,
  updateDeviceToken,
  getRecentSearches, addRecentSearch, removeRecentSearch, clearRecentSearches
} from "../controllers/usercontroller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { upload } from "../config/gridfs.js";

const UserRouter = express.Router();

// Limits repeated attempts on sensitive endpoints (per IP, 20 per 15 min)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again later." },
});

// ================= AUTH ROUTES =================
// Send OTP for email verification
UserRouter.post("/send-otp", authLimiter, sendOtp);
// Verify OTP
UserRouter.post("/verify-otp", authLimiter, verifyOtp);
// Register user after OTP verification
UserRouter.post("/register", authLimiter, registerUser);
// Login user
UserRouter.post("/login", authLimiter, loginUser);
// Refresh an expired access token
UserRouter.post("/refresh-token", refreshAccessToken);
// ================= PASSWORD ROUTES =================
// Forgot password -> send OTP
UserRouter.post("/forgot-password", authLimiter, forgotPassword);
// Reset password after OTP verification
UserRouter.post("/reset-password", authLimiter, resetPassword);
// Change password when logged in
UserRouter.put("/change-password", protect, authLimiter, changePassword);
// ================= PROFILE ROUTES =================
// Get logged in user profile
UserRouter.get("/profile", protect, getUserProfile);
// Update profile
UserRouter.put("/update-profile", protect, upload.fields([{ name: "profilePic", maxCount: 1 }, { name: "coverPic", maxCount: 1 }]), updateProfile);
// Delete account
UserRouter.delete("/delete-account", protect, authLimiter, deleteAccount);
// Search users by username
UserRouter.get("/search", protect, searchUsers);

// ================= RECENT SEARCHES =================
// Get my recent searches (most recent first)
UserRouter.get("/recent-searches", protect, getRecentSearches);
// Clear all my recent searches
UserRouter.delete("/recent-searches", protect, clearRecentSearches);
// Add a user to my recent searches (moves to top if already there)
UserRouter.post("/recent-searches/:id", protect, addRecentSearch);
// Remove one user from my recent searches (the X button)
UserRouter.delete("/recent-searches/:id", protect, removeRecentSearch);

// Get user by ID (for profile viewing)
UserRouter.get("/user/:userId", protect, getUserById);
// Get posts by user ID
UserRouter.get("/get-posts/:userId", protect, getPostsByUserId);
// Get post by ID
UserRouter.get("/get-post/:postId", protect, getPostById);
// Block user
UserRouter.post("/block/:id", protect, blockUser);
// Unblock user
UserRouter.delete("/unblock/:id", protect, unblockUser);
// Get blocked users
UserRouter.get("/blocked-users", protect, getBlockedUsers);
// Get public reels
UserRouter.get("/public-reels", protect, getPublicReels);
// Resend OTP for email verification
UserRouter.post("/resend-otp", authLimiter, resendOtp);
// Google OAuth login
UserRouter.post("/google-login", authLimiter, googleLogin);
// Google OAuth signup
UserRouter.post("/google-signup", authLimiter, googleSignup);
// Logout user
UserRouter.post("/logout", protect, logoutUser);

// Save / clear this device's FCM push token
UserRouter.put("/device-token", protect, updateDeviceToken);

export default UserRouter;