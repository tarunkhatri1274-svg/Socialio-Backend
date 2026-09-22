import express from 'express';

import { protect } from '../middlewares/auth.middleware.js';
import {
  createShare,
  createStoryShare,
  getShareableUsers,
} from "../controllers/share.controller.js";
const ShareRouter = express.Router();

// GET  /api/auth/share/users?q=  — get users to share with
ShareRouter.get('/share/users', protect, getShareableUsers);

// POST /api/auth/share           — share a post + send DMs
ShareRouter.post('/share', protect, createShare);
ShareRouter.post('/share/story', protect, createStoryShare);

export default ShareRouter;

// ─────────────────────────────────────────────────────────────────────────────
// HOW TO MOUNT IN main.js / app.js:
//
//   import ShareRouter from './routes/shareroutes.js';
//   app.use('/api/auth', ShareRouter);   // ← GET  /api/auth/share/users
//   app.use('/api/share', ShareRouter);  // ← POST /api/share
//
// OR simpler — mount once under /api/auth and change POST to /api/auth/share:
//   app.use('/api/auth', ShareRouter);
//   // then in ShareSheet.jsx change handleSend URL to: `${API}/auth/share`
// ─────────────────────────────────────────────────────────────────────────────