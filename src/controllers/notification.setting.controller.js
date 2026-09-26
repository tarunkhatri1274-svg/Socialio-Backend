import NotificationSettings from "../models/notificationsettings/notification.settings.js";

export const getNotificationSettings = async (req, res) => {
  try {
    const userId = req.user._id;
    let settings = await NotificationSettings.findOne({ user: userId });
    if (!settings) {
      settings = await NotificationSettings.create({ user: userId });
    }
    res.status(200).json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateNotificationSettings = async (req, res) => {
  try {
    const userId = req.user._id;
    const allowedKeys = ["message", "post", "reel", "story", "text"];

    const update = {};
    if (req.body.key) {
      if (!allowedKeys.includes(req.body.key)) {
        return res.status(400).json({ success: false, message: "Invalid setting key" });
      }
      update[req.body.key] = !!req.body.value;
    } else {
      allowedKeys.forEach((k) => {
        if (typeof req.body[k] === "boolean") update[k] = req.body[k];
      });
    }

    const settings = await NotificationSettings.findOneAndUpdate(
      { user: userId },
      { $set: update },
      // FIX — same deprecation as notification.controller.js's
      // markNotificationRead: { new: true } → { returnDocument: "after" }.
      // upsert: true is unrelated and unchanged.
      { returnDocument: "after", upsert: true }
    );

    res.status(200).json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};