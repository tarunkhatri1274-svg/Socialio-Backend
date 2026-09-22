// routes/auth.routes.js (or wherever follow routes live) — add:
import { toggleMute, getMutedMap } from "../controllers/mute.controller.js";
import {protect} from "../middlewares/auth.middleware.js";
import express from "express";
const MuteRouter = express.Router();
MuteRouter.patch("/:id", protect, toggleMute);
MuteRouter.get("/", protect, getMutedMap);
export default MuteRouter;