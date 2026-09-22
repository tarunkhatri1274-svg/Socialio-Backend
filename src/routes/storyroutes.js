import express from "express";
import {
  addStory,
  getAllStories,
  getUserStories,
  viewStory,
  likeStory,
  reactToStory,
  deleteStory,
  startLiveStory,
  endLiveStory,
  commentOnStory,
  getStoryViewers,
  getStoryLikeState,
  HideFromNonFollowers,
  getStoryComments,
  repostStoryToMyStory,
} from "../controllers/story.controllers.js";
import { protect } from "../middlewares/auth.middleware.js";
import { uploadStory, handleUploadError } from "../config/cloudinary.js";

const Storyrouter = express.Router();

const handleStoryUpload = (req, res, next) => {
  uploadStory.single("story")(req, res, (err) => {
    if (err) return handleUploadError(err, req, res, next);
    next();
  });
};

Storyrouter.post("/add-story", protect, handleStoryUpload, addStory);

Storyrouter.post("/live/start", protect, startLiveStory);
Storyrouter.delete("/live/:storyId/end", protect, endLiveStory);

Storyrouter.get("/get-stories", protect, getAllStories);
Storyrouter.get("/get-user-stories/:userId", protect, getUserStories);

Storyrouter.put("/view-story/:storyId", protect, viewStory);
Storyrouter.put("/like-story/:storyId", protect, likeStory);
Storyrouter.post("/comment/:storyId", protect, commentOnStory);
Storyrouter.put("/react-story/:storyId", protect, reactToStory);
Storyrouter.get("/viewers/:storyId", protect, getStoryViewers);
Storyrouter.get("/like-state/:storyId", protect, getStoryLikeState);
Storyrouter.delete("/delete-story/:storyId", protect, deleteStory);
Storyrouter.patch("/hide-from-non-followers/:storyId", protect, HideFromNonFollowers);
Storyrouter.get("/comments/:storyId", protect, getStoryComments);

// ================= ADD TO YOUR STORY (repost original media) =============
Storyrouter.post("/repost/:storyId", protect, repostStoryToMyStory);

export default Storyrouter;