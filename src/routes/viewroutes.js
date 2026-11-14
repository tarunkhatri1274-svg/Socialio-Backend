import express from "express";
import { addView, getViews, getViewsCount } from "../controllers/view.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
const ViewRouter = express.Router();

ViewRouter.post("/posts/:postId/views", protect, addView);
ViewRouter.get("/posts/:postId/views-count", protect, getViewsCount);
ViewRouter.get("/posts/:postId/views", protect, getViews);

export default ViewRouter;