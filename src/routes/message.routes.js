import express from "express";
import {
  createMessage,
  getMessages,
  forwardMessage,
  editMessage,
  deleteMessage,
  toggleLikeMessage,
  clearChat,
  searchAllUsers,
  getInbox,
  getMessageRequests,
  acceptMessageRequest,
  declineMessageRequest,
  getInboxCounts,
  uploadMessageMedia,
  getRecentChatUsers,
  getConversationWallpaper,
  setConversationWallpaper,
  clearConversationWallpaper,
} from "../controllers/message.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { uploadMessage, uploadWallpaper, handleUploadError } from "../config/cloudinary.js";

const MessageRouter = express.Router();

MessageRouter.get("/chat/:userId1/:userId2", protect, (req, res) => {
  const { userId1, userId2 } = req.params;
  const chatId = [userId1, userId2].sort().join("_");
  res.json({ chatId });
});

MessageRouter.get("/inbox", protect, getInbox);
MessageRouter.get("/requests", protect, getMessageRequests);
MessageRouter.post("/requests/:chatId/accept", protect, acceptMessageRequest);
MessageRouter.post("/requests/:chatId/decline", protect, declineMessageRequest);
MessageRouter.get("/counts", protect, getInboxCounts);

MessageRouter.get("/search-users", protect, searchAllUsers);

MessageRouter.post("/", protect, createMessage);

MessageRouter.get("/chat/:chatId", protect, getMessages);

MessageRouter.post("/forward/:messageId", protect, forwardMessage);

MessageRouter.post("/upload", protect, uploadMessage.single("file"), handleUploadError, uploadMessageMedia);

MessageRouter.put("/:messageId", protect, editMessage);

MessageRouter.delete("/:messageId", protect, deleteMessage);

MessageRouter.patch("/like/:messageId", protect, toggleLikeMessage);

MessageRouter.delete("/chat/:chatId/clear", protect, clearChat);

MessageRouter.get("/recent-users", protect, getRecentChatUsers);

// ── Chat wallpaper (per-user, per-chat) ─────────────────────────────────
// PUT with a multipart "photo" field sets a custom image wallpaper; PUT
// with a JSON body ({ id, type, value, ... }) sets a preset one. Either
// way, any previous custom photo wallpaper is deleted from Cloudinary
// automatically (see setConversationWallpaper).
MessageRouter.get("/:chatId/wallpaper", protect, getConversationWallpaper);
MessageRouter.put("/:chatId/wallpaper", protect, uploadWallpaper.single("photo"), handleUploadError, setConversationWallpaper);
MessageRouter.delete("/:chatId/wallpaper", protect, clearConversationWallpaper);

export default MessageRouter;