import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "../../.env") });

const url = new URL(process.env.CLOUDINARY_URL);
cloudinary.config({
  cloud_name: url.hostname,
  api_key: url.username,
  api_secret: url.password,
});

// ← Delete in chunks of 100 max
const deleteInChunks = async (ids, resourceType) => {
  const chunkSize = 100; // ← Cloudinary max is 100
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    await cloudinary.api.delete_resources(chunk, { resource_type: resourceType });
    console.log(`✅ Deleted ${chunk.length} ${resourceType} files`);
  }
};

const deleteAll = async () => {
  try {
    for (const resourceType of ["image", "video", "raw"]) {
      console.log(`\nProcessing ${resourceType}s...`);
      let nextCursor = null;

      do {
        const result = await cloudinary.api.resources({
          resource_type: resourceType,
          max_results: 500,
          next_cursor: nextCursor,
        });

        if (result.resources.length > 0) {
          const ids = result.resources.map(r => r.public_id);
          await deleteInChunks(ids, resourceType); // ← chunks of 100
        } else {
          console.log(`No ${resourceType}s found`);
        }

        nextCursor = result.next_cursor;
      } while (nextCursor);
    }

    console.log("\n🎉 All done!");
  } catch (err) {
    console.error("❌ Full error:", err);
  }
};

deleteAll();