import express from "express";
import { addView, getViewsCount } from "../controllers/view.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
const ViewRouter = express.Router();

ViewRouter.post("/posts/:postId/views", protect, addView);
ViewRouter.get("/posts/:postId/views-count", protect, getViewsCount);

export default ViewRouter;