import "./src/config/env.js";

import "./src/config/firebaseAdmin.js";
import "./src/services/simpleENV.js";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import connectDB from "./src/db/mongodb.js";
import { initSocket, cleanupStaleLiveStories } from "./src/config/sockets.js";
import "./src/models/messages/conversation.model.js"; // registers the Conversation model
import apiRouter, { publicRouter } from "./src/routes/routes.js"; // ← every router lives in routes.js
import { startMediaExpiryJob } from "./src/jobs/expire.media.js";
import { startStoryExpiryJob } from "./src/jobs/expire.story.js";
import { startNotificationExpiryJob } from "./src/jobs/expire.notification.js";
const PORT=process.env.PORT
const app        = express();
app.set("trust proxy", 1);
const httpServer = createServer(app);

// ================= SOCKET.IO =================
// NOTE: must run before startMediaExpiryJob() / startStoryExpiryJob() /
// startNotificationExpiryJob(), since all three call getIO() internally
// to emit cleanup events.
initSocket(httpServer);

// ================= DATABASE =================
connectDB().then(async () => {
  console.log("MongoDB connected");

  // ── A fresh process has no live rooms, so any live Story doc still in
  // the DB is a leftover from before this restart — remove it.
  await cleanupStaleLiveStories();

  // ── Start the hourly cleanup job: media expiry (2d) + tombstone purge (1d) ──
  startMediaExpiryJob();

  // ── Start the story auto-expiry job (24h cleanup, Cloudinary-first) ───
  startStoryExpiryJob();

  // ── Start the hourly notification/activity purge job (7d) ─────────────
  startNotificationExpiryJob();
});

// ================= MIDDLEWARE =================
const allowedOrigins = [
  process.env.FRONTEND_URL
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.includes(origin) ||
        /\.ngrok-free\.(dev|app)$/.test(new URL(origin).hostname)
      ) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= ROUTES =================
// All routers are registered in src/routes/routes.js (same URLs as before).
app.use("/", publicRouter);  // /files/...  (public, no auth, no /api prefix)
app.use("/api", apiRouter);  // /api/auth, /api/stories, /api/messages, /api/groups, ...

// ================= TEST ROUTE =================
app.get("/", (req, res) => {
  res.send("Backend working");
});

// ================= ERROR HANDLER =================
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: err.message });
});

// ================= SERVER =================
httpServer.listen(PORT,"0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});