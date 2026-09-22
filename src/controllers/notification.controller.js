import Notification from "../models/notifications/notification.model.js";

// ================= GET NOTIFICATIONS (paginated, newest first) =================
export const getNotifications = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [notifications, unreadCount, total] = await Promise.all([
      Notification.find({ recipient: userId })
        .populate("sender", "username profilePic")
        // ← NEW — memoryItem's own `author` is who actually owns the
        // memory (may differ from `sender` for memory_reply /
        // memory_like_comment, where the sender liked/replied to a
        // comment left by someone other than the memory's owner). The
        // frontend needs this author id to know whose profile to open
        // the MemoryViewer on.
        .populate({
          path: "memoryItem",
          select: "author group",
          populate: { path: "author", select: "_id username profilePic" },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments({ recipient: userId, isRead: false }),
      Notification.countDocuments({ recipient: userId }),
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

    const notification = await Notification.findOneAndUpdate(
      { _id: notificationId, recipient: userId },
      { $set: { isRead: true } },
      { new: true }
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

    res.status(200).json({ success: true, message: "All notifications marked as read" });
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
    const unreadCount = await Notification.countDocuments({ recipient: userId, isRead: false });
    res.status(200).json({ success: true, unreadCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};