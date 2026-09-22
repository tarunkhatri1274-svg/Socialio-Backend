import mongoose from "mongoose";
import Post from "./models/post/post.model.js";
import dotenv from "dotenv";
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URL);

  const posts = await Post.find({});
  let fixedCount = 0;

  for (const post of posts) {
    const uniqueLikes = [...new Set(post.likes.map(id => id.toString()))];
    if (uniqueLikes.length !== post.likes.length) {
      post.likes = uniqueLikes;
      await post.save();
      fixedCount++;
      console.log(`Fixed post ${post._id}: ${post.likes.length} unique likes`);
    }
  }

  console.log(`Done. Fixed ${fixedCount} posts.`);
  await mongoose.disconnect();
}

run().catch(console.error);