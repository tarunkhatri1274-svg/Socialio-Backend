import express from "express";
import { rejectCallFromRest } from "../config/sockets.js"; // adjust path
import { protect } from "../middlewares/auth.middleware.js";             // use YOUR auth middleware name

const CallRouter = express.Router();

CallRouter.post("/reject", protect, (req, res) => {
  rejectCallFromRest(req.user._id.toString(), req.body.to); // use whatever your middleware puts on req
  res.json({ success: true });
});

export default CallRouter;