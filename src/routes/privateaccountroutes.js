// routes/privateaccountroutes.js

import express from "express";

import {
  togglePrivateAccount,
  sendFollowRequest,
  acceptFollowRequest,
  rejectFollowRequest,
  removeFollower,
  cancelFollowRequest,
  unfollowUser,               // ← new export added
} from "../controllers/private.account.js";

import { protect } from "../middlewares/auth.middleware.js";

const privateAccountRouter = express.Router();

// ── Toggle private / public ──────────────────────────────────────────────────
privateAccountRouter.patch("/private/toggle", protect, togglePrivateAccount);

// ── Follow requests ──────────────────────────────────────────────────────────
// FIX: specific routes MUST come before the dynamic /follow/:id route,
//      otherwise Express matches "accept" and "reject" as the :id param.
privateAccountRouter.post("/follow/accept/:id",  protect, acceptFollowRequest);
privateAccountRouter.post("/follow/reject/:id",  protect, rejectFollowRequest);
privateAccountRouter.post("/follow/:id",          protect, sendFollowRequest);

// ── Unfollow / remove / cancel ───────────────────────────────────────────────
privateAccountRouter.delete("/unfollow/:id",       protect, unfollowUser);
privateAccountRouter.delete("/remove-follower/:id",protect, removeFollower);
privateAccountRouter.delete("/cancel-follow/:id",  protect, cancelFollowRequest);

export default privateAccountRouter;