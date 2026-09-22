import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import { getFollowers, getFollowing, getMutualFollowers } from "../controllers/followlist.controllers.js";

const followListRouter = express.Router();

followListRouter.get("/followers/:userId",        protect, getFollowers);
followListRouter.get("/following/:userId",        protect, getFollowing);
followListRouter.get("/mutuals/:userId",          protect, getMutualFollowers);

export default followListRouter;