import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {addComment,editComment,deleteComment,likeComment,
  replyComment, editReply, deleteReply, likeReply, getComments,
} from "../controllers/comment.controllers.js";
const CommentRouter = express.Router();
CommentRouter.get("/get-comment/:postId", protect, getComments);
CommentRouter.post("/comment/:postId", protect, addComment);
CommentRouter.put("/comment/:postId/:commentId", protect, editComment);
CommentRouter.delete("/comment/:postId/:commentId", protect, deleteComment);
CommentRouter.post("/comment-like/:postId/:commentId", protect, likeComment);
CommentRouter.post("/reply/:postId/:commentId", protect, replyComment);
CommentRouter.put("/reply/:postId/:commentId/:replyId", protect, editReply);
CommentRouter.delete("/reply/:postId/:commentId/:replyId", protect, deleteReply);
CommentRouter.post("/reply-like/:postId/:commentId/:replyId", protect, likeReply);
export default CommentRouter;
