import express from "express";
// ================= ROUTE FILES =================
import UserRouter from "./userroutes.js";
import Storyrouter from "./storyroutes.js";
import MediaRouter from "./mediaroutes.js";
import followListRouter from "./followlistroutes.js";
import privateAccountRouter from "./privateaccountroutes.js";
import LikeRouter from "./likeRoutes.js";
import CommentRouter from "./commentroutes.js";
import MessageRouter from "./message.routes.js";
import ShareRouter from "./shareroutes.js";
const router = express.Router();
// ==========================================
// AUTH ROUTES
// ==========================================
router.use("/auth", UserRouter);
// ==========================================
// STORY ROUTES
// ==========================================
router.use("/stories", Storyrouter);
// ==========================================
// MEDIA ROUTES
// ==========================================
router.use("/media", MediaRouter);
router.use("/follow", followListRouter);
router.use("/private", privateAccountRouter);
router.use("/like", LikeRouter);
router.use("/", CommentRouter);
export default router;
