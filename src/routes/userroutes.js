import express from "express";
import {sendOtp, verifyOtp, registerUser,
  loginUser,forgotPassword, resetPassword, getUserProfile,
   updateProfile, deleteAccount,changePassword,searchUsers,
   getUserById,getPostsByUserId,unfollowUser,followUser,
  blockUser,unblockUser,getBlockedUsers,getPublicReels,resendOtp,
  googleLogin,googleSignup,logoutUser,getPostById,refreshAccessToken,
  // NEW — recent searches
  getRecentSearches, addRecentSearch, removeRecentSearch, clearRecentSearches
} from "../controllers/usercontroller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { upload } from "../config/cloudinary.js";

const UserRouter = express.Router();
// ================= AUTH ROUTES =================
// Send OTP for email verification
UserRouter.post("/send-otp", sendOtp);
// Verify OTP
UserRouter.post("/verify-otp", verifyOtp);
// Register user after OTP verification
UserRouter.post("/register", registerUser);
// Login user
UserRouter.post("/login", loginUser);
// Refresh an expired access token
UserRouter.post("/refresh-token", refreshAccessToken);
// ================= PASSWORD ROUTES =================
// Forgot password -> send OTP
UserRouter.post("/forgot-password", forgotPassword);
// Reset password after OTP verification
UserRouter.post("/reset-password", resetPassword);
// Change password when logged in
UserRouter.put("/change-password", protect, changePassword);
// ================= PROFILE ROUTES =================
// Get logged in user profile
UserRouter.get("/profile", protect, getUserProfile);
// Update profile
UserRouter.put( "/update-profile",protect,upload.fields([ { name: "profilePic", maxCount: 1 }, { name: "coverPic", maxCount: 1 }]), updateProfile);
// Delete account
UserRouter.delete("/delete-account", protect, deleteAccount);
//Search users by username
UserRouter.get("/search", protect, searchUsers);

// ================= RECENT SEARCHES (NEW) =================
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
//get blocked users
UserRouter.get("/blocked-users", protect, getBlockedUsers);
//get public reels
UserRouter.get("/public-reels", protect, getPublicReels);
// Resend OTP for email verification
UserRouter.post("/resend-otp", resendOtp);
// Google OAuth login
UserRouter.post("/google-login", googleLogin);
// Google OAuth signup
UserRouter.post("/google-signup", googleSignup);
//logout user
UserRouter.post("/logout", protect, logoutUser);

export default UserRouter;