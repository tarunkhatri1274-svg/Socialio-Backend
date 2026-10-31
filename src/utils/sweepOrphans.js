// Deletes GridFS files (uploads.files / uploads.chunks) that no document
// in the database references any more.

import mongoose from "mongoose";

const GRACE_MS = 60 * 60 * 1000; // never touch files younger than 1 hour
const ID_RE = /\/files\/([a-f0-9]{24})/gi;
let running = false;

export const sweepOrphanFiles = async ({ apply = true } = {}) => {
  if (running) return { skipped: true };
  running = true;
  try {
    const db = mongoose.connection.db;
    const bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: "uploads" });

    const referenced = new Set();
    const collections = await db.listCollections().toArray();
    for (const { name } of collections) {
      if (name.startsWith("uploads.") || name.startsWith("system.")) continue;
      for await (const doc of db.collection(name).find({})) {
        for (const m of JSON.stringify(doc).matchAll(ID_RE)) {
          referenced.add(m[1].toLowerCase());
        }
      }
    }

    const files = await db.collection("uploads.files").find({}).toArray();
    const orphans = files.filter(
      (f) =>
        Date.now() - new Date(f.uploadDate).getTime() > GRACE_MS &&
        !referenced.has(f._id.toString().toLowerCase())
    );

    let deleted = 0;
    if (apply) {
      for (const f of orphans) {
        try {
          await bucket.delete(f._id);
          deleted++;
        } catch (e) {
          console.error("[sweep] failed to delete", f._id.toString(), e.message);
        }
      }
    }
    console.log(`[sweep] files: ${files.length}, orphaned: ${orphans.length}, deleted: ${deleted}`);
    return { total: files.length, orphaned: orphans.length, deleted };
  } finally {
    running = false;
  }
};