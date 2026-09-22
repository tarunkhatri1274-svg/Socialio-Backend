import express from 'express';
import { protect } from '../middlewares/auth.middleware.js';
import { toggleLike,getPostLikers } from '../controllers/like.controller.js';
const LikeRouter = express.Router();

// ==========================================
// TOGGLE LIKE
// ==========================================
LikeRouter.post('/like/:id', protect, toggleLike);
LikeRouter.get('/likers/:id', protect, getPostLikers);
export default LikeRouter;