import express from "express";
import {
  createMemoryGroup,
  addMemoryItem,
  getUserMemoryGroups,
  getGroupItems,
  deleteMemoryItem,
  toggleHideItem,
  toggleDisableComments, // ← NEW
  viewMemoryItem,
  getMemoryLikeState,
  toggleMemoryLike,
  getMemoryLikers,
  getMemoryViewers, // ← NEW
  getMemoryComments,
  addMemoryComment,
  editMemoryComment,
  deleteMemoryComment,
  likeMemoryComment,
  replyMemoryComment,
  editMemoryReply,
  deleteMemoryReply,
  likeMemoryReply,
} from "../controllers/memory.controllers.js";
import { protect } from "../middlewares/auth.middleware.js";
import { uploadPost, handleUploadError } from "../config/cloudinary.js";

const MemoryRouter = express.Router();

// ── GROUPS ("Highlights") ────────────────────────────────────────────────
MemoryRouter.post(
  "/groups",
  protect,
  uploadPost.array("media", 10),
  handleUploadError,
  createMemoryGroup
);

MemoryRouter.post(
  "/groups/:groupId/items",
  protect,
  uploadPost.array("media", 10),
  handleUploadError,
  addMemoryItem
);

MemoryRouter.get("/groups/user/:userId", protect, getUserMemoryGroups);
MemoryRouter.get("/groups/:groupId/items", protect, getGroupItems);

// ── ITEMS ────────────────────────────────────────────────────────────────
MemoryRouter.delete("/items/:itemId", protect, deleteMemoryItem);
MemoryRouter.patch("/items/:itemId/hide", protect, toggleHideItem);
// ← NEW — lets the owner turn comments back on for an item that's stuck
// disabled (see toggleDisableComments in memory.controllers.js — this is
// the fix for the "created memory always has comments off" bug).
MemoryRouter.patch("/items/:itemId/toggle-comments", protect, toggleDisableComments);
MemoryRouter.put("/items/:itemId/view", protect, viewMemoryItem);

// ── LIKES ────────────────────────────────────────────────────────────────
MemoryRouter.get("/items/:itemId/like-state", protect, getMemoryLikeState);
MemoryRouter.put("/items/:itemId/like", protect, toggleMemoryLike);
MemoryRouter.get("/items/:itemId/likers", protect, getMemoryLikers); // ?q=search

// ── VIEWERS — NEW (owner-only, mirrors /likers) ──────────────────────────
MemoryRouter.get("/items/:itemId/viewers", protect, getMemoryViewers); // ?q=search

// ── COMMENTS / REPLIES (full CRUD, mirrors your post comment routes) ────
MemoryRouter.get("/items/:itemId/comments", protect, getMemoryComments);
MemoryRouter.post("/items/:itemId/comments", protect, addMemoryComment);
MemoryRouter.put("/items/:itemId/comments/:commentId", protect, editMemoryComment);
MemoryRouter.delete("/items/:itemId/comments/:commentId", protect, deleteMemoryComment);
MemoryRouter.put("/items/:itemId/comments/:commentId/like", protect, likeMemoryComment);

MemoryRouter.post("/items/:itemId/comments/:commentId/replies", protect, replyMemoryComment);
MemoryRouter.put("/items/:itemId/comments/:commentId/replies/:replyId", protect, editMemoryReply);
MemoryRouter.delete("/items/:itemId/comments/:commentId/replies/:replyId", protect, deleteMemoryReply);
MemoryRouter.put("/items/:itemId/comments/:commentId/replies/:replyId/like", protect, likeMemoryReply);

export default MemoryRouter;

// Mounted at: app.use("/api/memories", MemoryRouter);