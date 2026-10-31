import express from "express";
import { rejectCallFromRest } from "../config/sockets.js"; // adjust path
import { protect } from "../middlewares/auth.middleware.js";             // use YOUR auth middleware name
import admin from "firebase-admin";
import User from "../models/user/user.model.js"; // adjust path if needed


const CallRouter = express.Router();
CallRouter.get("/test-push", async (req, res) => {
  if (req.query.key !== "test123") return res.status(403).json({ error: "bad key" });
  try {
    const u = await User.findById(req.query.userId).select("username fcmToken");
    if (!u) return res.json({ step: "user", error: "user not found" });
    if (!u.fcmToken) return res.json({ step: "token", error: "this user has NO fcmToken saved", user: u.username });

    const id = await admin.messaging().send({
      token: u.fcmToken,
      data: { type: "incoming_call", from: "test", callType: "audio", callerName: "Test Call", callerPic: "" },
      android: { priority: "high", ttl: 45000 },
    });
    res.json({ step: "sent", messageId: id, user: u.username });
  } catch (e) {
    res.json({ step: "firebase", code: e.code, error: e.message });
  }
});
CallRouter.post("/reject", protect, (req, res) => {
  rejectCallFromRest(req.user._id.toString(), req.body.to); // use whatever your middleware puts on req
  res.json({ success: true });
});

export default CallRouter;