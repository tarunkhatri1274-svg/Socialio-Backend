import "./src/config/env.js";
import "./src/config/cloudinary.js";
import env from "./src/services/simpleENV.js";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import connectDB from "./src/db/mongodb.js";
import { initSocket } from "./src/config/sockets.js";
import Conversation from "./src/models/messages/conversation.model.js";
import UserRouter from "./src/routes/userroutes.js";
import MediaRouter from "./src/routes/mediaroutes.js";
import Storyrouter from "./src/routes/storyroutes.js";
import followListRouter from "./src/routes/followlistroutes.js";
import PrivateAccountRouter from "./src/routes/privateaccountroutes.js";
import router from "./src/routes/routes.js";
import LikeRouter from "./src/routes/likeRoutes.js";
import CommentRouter from "./src/routes/commentroutes.js";
import MessageRouter from "./src/routes/message.routes.js";
import ShareRouter from "./src/routes/shareroutes.js";
import { startMediaExpiryJob } from "./src/jobs/expire.media.js";
import { startStoryExpiryJob } from "./src/jobs/expire.story.js"; // ← added
import NotificationRouter from "./src/routes/notificationroutes.js";
import ViewRouter from "./src/routes/viewroutes.js";
import NotificationSettingsRouter from "./src/routes/notificationSettings.routes.js";
import GroupRouter from "./src/routes/grouproutes.js";
import { startNotificationExpiryJob } from "./src/jobs/expire.notification.js"; // ← added
import MemoryRouter from "./src/routes/memory.routes.js";
import MuteRouter from "./src/routes/mute.routes.js"; // ← added
const PORT=process.env.PORT
const app        = express();
const httpServer = createServer(app);

// ================= SOCKET.IO =================
// NOTE: must run before startMediaExpiryJob() / startStoryExpiryJob() /
// startNotificationExpiryJob(), since all three call getIO() internally
// to emit cleanup events.
initSocket(httpServer);

// ================= DATABASE =================
connectDB().then(() => {
  console.log("MongoDB connected");

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
app.use((req, res, next) => {
  console.log(">>>", req.method, req.originalUrl);
  next();
});
// ── TEMPORARY DEBUG — remove once the bad-JSON sender is found ──────────
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    console.log("[BadJSON]", req.method, req.originalUrl, "| body was:", JSON.stringify(err.body));
  }
  next(err);
});

// ================= MAIN API ROUTES =================
app.use("/api/auth", UserRouter);
app.use("/api/auth", followListRouter);
app.use("/api/auth", MediaRouter);
app.use("/api/auth", PrivateAccountRouter);
app.use("/api/stories", Storyrouter);
app.use("/api/auth", CommentRouter);
app.use("/api/auth", LikeRouter);
app.use("/api/messages", MessageRouter);
app.use("/api/auth", ShareRouter);
app.use("/api/auth/views", ViewRouter);
app.use("/api/auth/notifications", NotificationRouter);
app.use("/api/auth/notifications/settings", NotificationSettingsRouter);
app.use("/api/groups", GroupRouter);
app.use("/api/memories", MemoryRouter); // ← added
app.use("/api/mute", MuteRouter); // ← added
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
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
