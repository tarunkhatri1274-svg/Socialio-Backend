// backfillsharedpostauthor.js  (place directly in backend/, next to main.js)
//
// One-time backfill for Message documents whose sharedPost.postId exists
// but sharedPost.authorId is missing — these are post-shares sent before
// the authorId field was added to createShare() in share.controller.js.
// Without authorId, SharedPostBubble has no way to know which user's
// posts to fetch when the share is tapped, so it warns instead of
// opening anything (see "Cannot open shared post: missing authorId or
// postId" in the browser console).
//
// This does NOT touch story-shares (sharedPost.kind === 'story') — those
// already had authorId from the start, since createStoryShare always
// included it.
//
// Usage (run from inside the backend/ folder):
//   node backfillsharedpostauthor.js
//
// Safe to run multiple times — messages that already have authorId are
// skipped, and posts that no longer exist (deleted since the share was
// sent) are reported but left alone rather than guessed at.

import "./src/config/env.js";
import connectDB from "./src/db/mongodb.js";
import Message from "./src/models/messages/message.model.js";
import Post from "./src/models/post/post.model.js";
import mongoose from "mongoose";

async function backfillSharedPostAuthor() {
  await connectDB();
  console.log("[backfill] Connected. Scanning messages with sharedPost.postId set...");

  // Only messages that:
  //  - have a sharedPost.postId (i.e. are a post-share, not a story-share)
  //  - are missing sharedPost.authorId (the field we're backfilling)
  const candidates = await Message.find({
    "sharedPost.postId": { $exists: true, $ne: null },
    $or: [
      { "sharedPost.authorId": { $exists: false } },
      { "sharedPost.authorId": null },
    ],
  });

  console.log(`[backfill] Found ${candidates.length} message(s) missing authorId.`);

  let patched = 0;
  let skippedDeletedPost = 0;

  for (const msg of candidates) {
    const postId = msg.sharedPost?.postId;
    if (!postId) continue;

    const post = await Post.findById(postId).select("author");
    if (!post) {
      // The original post was deleted since this share was sent — there's
      // no author to backfill from. Leave it as-is; SharedPostBubble
      // already handles "post no longer available" gracefully once
      // authorId IS present, but here we have nothing to attach.
      skippedDeletedPost++;
      continue;
    }

    msg.sharedPost.authorId = post.author;
    await msg.save();
    patched++;
  }

  console.log(
    `[backfill] Done. Patched ${patched} message(s). ` +
      `Skipped ${skippedDeletedPost} (original post no longer exists).`
  );
  await mongoose.disconnect();
}

backfillSharedPostAuthor().catch((err) => {
  console.error("[backfill] Failed:", err);
  process.exit(1);
});