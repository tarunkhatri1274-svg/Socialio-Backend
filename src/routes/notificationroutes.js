import express from "express";
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  getUnreadNotificationCount,
} from "../controllers/notification.controller.js";
import {protect} from "../middlewares/auth.middleware.js"; // ← adjust path/name to match your existing auth middleware

const NotificationRouter = express.Router();

NotificationRouter.get("/", protect, getNotifications);
NotificationRouter.get("/unread-count", protect, getUnreadNotificationCount);
NotificationRouter.patch("/:notificationId/read", protect, markNotificationRead);
NotificationRouter.patch("/read-all", protect, markAllNotificationsRead);
NotificationRouter.delete("/:notificationId", protect, deleteNotification);

export default NotificationRouter;