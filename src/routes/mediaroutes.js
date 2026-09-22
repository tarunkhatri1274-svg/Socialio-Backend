import express from "express";

import {
  AddMediaPost, TextPost, getPosts, AddTextPost, deletePost,
  getUserPosts, getFeed, HideFromNonFollowers, toggleNotInterested,
  removeTag, removeCollaborator, addTag, addCollaborator
  ,getPostById, respondToCollaborator, uploadPostMedia,
} from "../controllers/media.controllers.js";

import { protect } from "../middlewares/auth.middleware.js";
import { upload, uploadPost, handleUploadError } from "../config/cloudinary.js";

const MediaRouter = express.Router();

// ==========================================
// UPLOAD SINGLE POST MEDIA FILE (returns a Cloudinary URL; used by
// CreateImagePost / CreateTextPost / VideoPostFormat BEFORE they POST
// the actual post as JSON). Uses uploadPost, not uploadMessage — see
// uploadPostMedia in media.controllers.js for why this route exists
// separately from /messages/upload.
// ==========================================
MediaRouter.post("/upload-media", protect, uploadPost.single("file"), handleUploadError, uploadPostMedia);

// ==========================================
// ADD TEXT POST
// ==========================================
MediaRouter.post("/add-text-post", protect, uploadPost.array("media", 10), handleUploadError, AddTextPost);

// ==========================================
// ADD IMAGE POST
// ==========================================
MediaRouter.post("/add-image-post", protect, uploadPost.array("media", 10), handleUploadError, AddMediaPost);

// ==========================================
// ADD VIDEO POST
// ==========================================
MediaRouter.post("/add-video-post", protect, uploadPost.array("media", 10), handleUploadError, AddMediaPost);

// ==========================================
// ADD MEDIA POST
// ==========================================
MediaRouter.post("/add-media-post", protect, uploadPost.array("media", 10), handleUploadError, AddMediaPost);

// ==========================================
// TEXT POST
// ==========================================
MediaRouter.post("/text-post", protect, uploadPost.array("media", 10), handleUploadError, TextPost);

// ==========================================
// GET ALL POSTS
// ==========================================
MediaRouter.get("/get-all-posts", protect, getPosts);

// ==========================================
// DELETE POST
// ==========================================
MediaRouter.delete("/delete-post/:postId", protect, deletePost);

// ==========================================
// GET USER POSTS
// ==========================================
MediaRouter.get("/get-posts/:userId", protect, getUserPosts);

// ==========================================
// GET FEED
// ==========================================
MediaRouter.get("/feed", protect, getFeed);

// ==========================================
// HIDE FROM NON FOLLOWERS
// ==========================================
MediaRouter.patch("/hide-from-non-followers/:postId", protect, HideFromNonFollowers);

// ==========================================
// NOT INTERESTED
// ==========================================
MediaRouter.patch("/not-interested/:postId", protect, toggleNotInterested);

// ==========================================
// REMOVE TAG
// ==========================================
MediaRouter.patch("/remove-tag/:postId", protect, removeTag);

// ==========================================
// ADD TAG
// ==========================================
MediaRouter.patch("/add-tag/:postId", protect, addTag);

// ==========================================
// REMOVE COLLABORATOR
// ==========================================
MediaRouter.patch("/remove-collaborator/:postId", protect, removeCollaborator);

// ==========================================
// ADD COLLABORATOR (sends a pending invite)
// ==========================================
MediaRouter.patch("/add-collaborator/:postId", protect, addCollaborator);

// ==========================================
// RESPOND TO COLLABORATOR INVITE (accept/decline)
// ==========================================
MediaRouter.patch("/collaborator-respond/:postId", protect, respondToCollaborator);
// ==========================================
// GET POST BY ID
// ==========================================
MediaRouter.get("/get-post/:postId", protect, getPostById);
export default MediaRouter;