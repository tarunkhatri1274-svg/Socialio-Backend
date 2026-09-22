// scripts/migrateCollaborators.js
//
// One-time migration: converts Post.collaborators from a flat array of
// ObjectIds into the new { user, status, invitedAt, respondedAt } shape.
// Pre-existing collaborators are marked "accepted" since they were added
// under the old no-approval system.
//
// Run once with: node scripts/migrateCollaborators.js
// Safe to re-run: it skips any post whose collaborators are already in
// the new shape (detected by checking the first element has a `.user` key).

import mongoose from "mongoose";
import "../src/config/env.js"; // adjust path if your env loader lives elsewhere
import Post from "../src/models/post/post.model.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected. Scanning posts with collaborators...");

  const posts = await Post.find({ collaborators: { $exists: true, $ne: [] } });
  let migrated = 0;
  let skipped = 0;

  for (const post of posts) {
    const first = post.collaborators[0];

    // Already migrated (subdocument shape) — skip.
    if (first && typeof first === "object" && first.user) {
      skipped++;
      continue;
    }

    // Old shape: array of bare ObjectIds.
    post.collaborators = post.collaborators.map((id) => ({
      user: id,
      status: "accepted",
      invitedAt: post.createdAt || new Date(),
      respondedAt: post.createdAt || new Date(),
    }));

    await post.save();
    migrated++;
  }

  console.log(`Done. Migrated ${migrated} post(s), skipped ${skipped} already-migrated post(s).`);
  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});