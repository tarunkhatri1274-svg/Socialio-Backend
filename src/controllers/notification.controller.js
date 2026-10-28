import mongoose from "mongoose";
import Notification from "../models/notifications/notification.model.js";
import { getBlockedIdSets } from "../utils/blockHelper.js";

// ================= GET NOTIFICATIONS (paginated, newest first) =================
export const getNotifications = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Messages live in the Messages screen only, never on Activity
    // 🚫 Strict block: no notifications from anyone blocked either way
    const { hidden } = await getBlockedIdSets(userId);
    const baseFilter = { recipient: userId, type: { $ne: "message" }, sender: { $nin: hidden } };

    const [notifications, unreadCount, total] = await Promise.all([
      Notification.find(baseFilter)
        .populate("sender", "username profilePic")
        .populate({
          path: "memoryItem",
          select: "author group",
          populate: { path: "author", select: "_id username profilePic" },
        })
        .populate("post", "media postType text")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments({ ...baseFilter, isRead: false }),
      Notification.countDocuments(baseFilter),
    ]);

    res.status(200).json({
      success: true,
      notifications,
      unreadCount,
      page,
      hasMore: skip + notifications.length < total,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= MARK ONE AS READ =================
export const markNotificationRead = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { notificationId } = req.params;

    // A client-side placeholder id (e.g. "temp-123...") would otherwise
    // throw a CastError and come back as a 500.
    if (!mongoose.isValidObjectId(notificationId)) {
      return res.status(400).json({ success: false, message: "Invalid notification id" });
    }

    const notification = await Notification.findOneAndUpdate(
      { _id: notificationId, recipient: userId },
      { $set: { isRead: true } },
      // FIX — { new: true } is the deprecated way to ask for the
      // post-update document; Mongoose now warns to use
      // { returnDocument: "after" } instead, matching the underlying
      // MongoDB driver's own option name. Same behavior either way.
      { returnDocument: "after" }
    );

    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.status(200).json({ success: true, notification });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= MARK ALL AS READ =================
export const markAllNotificationsRead = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    await Notification.updateMany(
      { recipient: userId, isRead: false },
      { $set: { isRead: true } }
    );

    res.status(200).json({ success: true, unreadCount: 0, message: "All notifications marked as read" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= DELETE ONE =================
export const deleteNotification = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { notificationId } = req.params;

    const notification = await Notification.findOneAndDelete({
      _id: notificationId,
      recipient: userId,
    });

    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.status(200).json({ success: true, message: "Notification deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ================= UNREAD COUNT (for navbar badge) =================
export const getUnreadNotificationCount = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { hidden } = await getBlockedIdSets(userId);
    const unreadCount = await Notification.countDocuments({
      recipient: userId,
      isRead: false,
      type: { $ne: "message" },
      sender: { $nin: hidden },
    });
    res.status(200).json({ success: true, unreadCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};