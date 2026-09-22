import express from "express";
import  Post  from "../models/post/post.model.js";
import { addView, getViews } from "../controllers/view.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
const ViewRouter = express.Router();
// ================= ADD VIEW =================
ViewRouter.post("/posts/:postId/views", protect, addView);
// ================= GET VIEWS =================
ViewRouter.get("/posts/:postId/views", protect, getViews);
export default ViewRouter;