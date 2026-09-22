import 'dotenv/config'; // loads MONGODB_URL from your .env file
import mongoose from 'mongoose';
import connectDB from './src/db/mongodb.js'; // ← adjust this path if mongodb.js lives elsewhere
import Message from './src/models/messages/message.model.js'; // ← fixed: was "modelsmessages"
import Post from './src/models/post/post.model.js';

async function backfillSharedPostAuthorId() {
  const broken = await Message.find({
    'sharedPost.postId': { $exists: true },
    'sharedPost.authorId': { $in: [null, undefined] },
  });

  console.log(`Found ${broken.length} messages missing sharedPost.authorId`);

  let fixed = 0;
  let skipped = 0;

  for (const msg of broken) {
    const post = await Post.findById(msg.sharedPost.postId).select('author');
    if (!post) {
      skipped++;
      continue; // post itself was deleted — leave as-is
    }
    msg.sharedPost.authorId = post.author;
    await msg.save();
    fixed++;
  }

  console.log(`Backfill complete: ${fixed} fixed, ${skipped} skipped (post deleted)`);
}

async function run() {
  await connectDB();
  await backfillSharedPostAuthorId();
  await mongoose.disconnect();
  console.log('Disconnected. Done.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Backfill script failed:', err);
  process.exit(1);
});