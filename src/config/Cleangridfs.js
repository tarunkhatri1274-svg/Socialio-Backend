// Dev-only: wipes EVERY uploaded file from the GridFS "uploads" bucket.
// Replaces the old cleancloudinary.js.
//
//   node cleangridfs.js --yes
//
// Without --yes it only reports how many files it would delete.

import mongoose from "mongoose";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "../../.env") });

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL);
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: "uploads",
  });

  const count = await mongoose.connection.db
    .collection("uploads.files")
    .countDocuments();
  console.log(`Found ${count} stored file(s).`);

  if (!process.argv.includes("--yes")) {
    console.log("Dry run. Re-run with --yes to delete them all.");
  } else {
    await bucket.drop();
    console.log("🎉 All uploaded files deleted.");
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("❌ Full error:", err);
  process.exit(1);
});