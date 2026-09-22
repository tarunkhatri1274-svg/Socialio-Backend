import express from "express";
import { getNotificationSettings, updateNotificationSettings } from "../controllers/notification.setting.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const NotificationSettingsRouter = express.Router();

NotificationSettingsRouter.get("/", protect, getNotificationSettings);
NotificationSettingsRouter.put("/", protect, updateNotificationSettings);

export default NotificationSettingsRouter;