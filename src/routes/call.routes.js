import express from "express";
import { rejectCallFromRest } from "../config/sockets.js";
import { protect } from "../middleware/auth.js";

const CallRouter = express.Router();

CallRouter.post("/reject", protect, (req, res) => {
  rejectCallFromRest(req.user._id.toString(), req.body.to);
  res.json({ success: true });
});

export default CallRouter;