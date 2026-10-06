import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
  createGroup,
  inviteToGroup,
  getGroupRequests,
  acceptGroupInvite,
  declineGroupInvite,
  exitGroup,
  removeGroupMember,
  renameGroup,
  getMyGroups,
  getGroupDetails,
  sendGroupMessage,
  getGroupMessages,
  editGroupMessage,
  toggleLikeGroupMessage,
  forwardMessageToGroup,
  deleteGroupMessage,
  getGroupWallpaper,
  setGroupWallpaper,
  clearGroupWallpaper,
  createGroupPoll,
  voteGroupPoll,
} from "../controllers/group.controller.js";
import { uploadWallpaper, handleUploadError } from "../config/cloudinary.js";

const GroupRouter = express.Router();

GroupRouter.post("/create", protect, createGroup);
GroupRouter.get("/mine", protect, getMyGroups);
GroupRouter.get("/requests", protect, getGroupRequests);

GroupRouter.get("/:chatId", protect, getGroupDetails);

GroupRouter.post("/:chatId/invite", protect, inviteToGroup);
GroupRouter.post("/:chatId/add-members", protect, inviteToGroup);
GroupRouter.post("/:chatId/accept", protect, acceptGroupInvite);
GroupRouter.post("/:chatId/decline", protect, declineGroupInvite);
GroupRouter.post("/:chatId/exit", protect, exitGroup);
GroupRouter.post("/:chatId/remove-member", protect, removeGroupMember);
GroupRouter.patch("/:chatId/rename", protect, renameGroup);

GroupRouter.get("/:chatId/messages", protect, getGroupMessages);
GroupRouter.post("/messages/send", protect, sendGroupMessage);
GroupRouter.put("/messages/:messageId", protect, editGroupMessage);
GroupRouter.patch("/messages/like/:messageId", protect, toggleLikeGroupMessage);
GroupRouter.delete("/messages/:messageId", protect, deleteGroupMessage);
GroupRouter.post("/:chatId/messages/forward", protect, forwardMessageToGroup);

// ── Polls
GroupRouter.post("/messages/poll", protect, createGroupPoll);
GroupRouter.post("/messages/poll/:messageId/vote", protect, voteGroupPoll);

// ── Group wallpaper (per-user, per-group) — same contract as the 1:1
// version in message.routes.js.
GroupRouter.get("/:chatId/wallpaper", protect, getGroupWallpaper);
GroupRouter.put("/:chatId/wallpaper", protect, uploadWallpaper.single("photo"), handleUploadError, setGroupWallpaper);
GroupRouter.delete("/:chatId/wallpaper", protect, clearGroupWallpaper);

export default GroupRouter;