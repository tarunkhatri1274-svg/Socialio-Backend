// ─────────────────────────────────────────────────────────────────────────────
// routes.js — the ONE place where every router is registered.
//
//   main.js mounts this file like so:
//       app.use("/",    publicRouter);   // public files, no /api prefix
//       app.use("/api", apiRouter);      // everything else
//
// The final URLs are exactly the same as before (e.g. /api/auth/..., /api/groups/...,
// /files/...), so the frontend / app needs NO changes.
//
// ⚠ ORDER MATTERS. Express tries routers top to bottom, so keep the order below
//   (it is the same order main.js used). Several routers share the "/auth" prefix.
//   To add a feature: import its router, then add one `apiRouter.use(...)` line in
//   the matching section.
// ─────────────────────────────────────────────────────────────────────────────
import express from "express";

// ── Route modules ────────────────────────────────────────────────────────────
// Accounts & social graph
import UserRoutes from "./userroutes.js";
import FollowListRoutes from "./followlistroutes.js";
import PrivateAccountRoutes from "./privateaccountroutes.js";
// Posts & engagement
import MediaRoutes from "./mediaroutes.js";
import CommentRoutes from "./commentroutes.js";
import LikeRoutes from "./likeRoutes.js";
import ShareRoutes from "./shareroutes.js";
import ViewRoutes from "./viewroutes.js";
// Stories & memories
import StoryRoutes from "./storyroutes.js";
import MemoryRoutes from "./memory.routes.js";
// Messaging, groups & calls
import MessageRoutes from "./message.routes.js";
import GroupRoutes from "./grouproutes.js";
import CallRoutes from "./call.routes.js";
// Notifications & settings
import NotificationRoutes from "./notificationroutes.js";
import NotificationSettingsRoutes from "./notificationSettings.routes.js";
import MuteRoutes from "./mute.routes.js";
// Public files
import FileRoutes from "./file.routes.js";

// ═════════════════════════════════════════════════════════════════════════════
// API ROUTES  →  mounted at /api
// ═════════════════════════════════════════════════════════════════════════════
const apiRouter = express.Router();

// ── Accounts, follows, posts, private accounts (/api/auth/...) ──
apiRouter.use("/auth", UserRoutes);
apiRouter.use("/auth", FollowListRoutes);
apiRouter.use("/auth", MediaRoutes);
apiRouter.use("/auth", PrivateAccountRoutes);

// ── Stories (/api/stories/...) ──
apiRouter.use("/stories", StoryRoutes);

// ── Comments & likes (/api/auth/...) ──
apiRouter.use("/auth", CommentRoutes);
apiRouter.use("/auth", LikeRoutes);

// ── Messages (/api/messages/...) ──
apiRouter.use("/messages", MessageRoutes);

// ── Shares, views, notifications (/api/auth/...) ──
apiRouter.use("/auth", ShareRoutes);
apiRouter.use("/auth/views", ViewRoutes);
apiRouter.use("/auth/notifications", NotificationRoutes);
apiRouter.use("/auth/notifications/settings", NotificationSettingsRoutes); // keep AFTER /auth/notifications

// ── Groups, memories, mute, calls ──
apiRouter.use("/groups", GroupRoutes);
apiRouter.use("/memories", MemoryRoutes);
apiRouter.use("/mute", MuteRoutes);
apiRouter.use("/calls", CallRoutes);

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES  →  mounted at "/"  (no /api prefix, no auth)
// ═════════════════════════════════════════════════════════════════════════════
export const publicRouter = express.Router();
publicRouter.use("/files", FileRoutes); // GET /files/:id  (images / videos / documents)

export default apiRouter;