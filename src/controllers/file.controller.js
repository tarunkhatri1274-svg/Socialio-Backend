// controllers/file.controller.js
// Streams a GridFS file back to the client, with HTTP Range support so
// <Video> players can seek and iOS/Android can start playback quickly.

import mongoose from "mongoose";
import { getBucket } from "../config/gridfs.js";

export const streamFile = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ success: false, message: "File not found" });
    }

    const fileId = new mongoose.Types.ObjectId(id);
    const [file] = await getBucket().find({ _id: fileId }).limit(1).toArray();
    if (!file) {
      return res.status(404).json({ success: false, message: "File not found" });
    }

    const total = file.length;
    let start = 0;
    let end = total - 1;

    const range = req.headers.range;
    if (range && total > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === "" && m[2] === "")) {
        res.set("Content-Range", `bytes */${total}`);
        return res.status(416).end();
      }
      if (m[1] === "") {
        // suffix range: last N bytes
        start = Math.max(total - parseInt(m[2], 10), 0);
      } else {
        start = parseInt(m[1], 10);
        if (m[2] !== "") end = Math.min(parseInt(m[2], 10), total - 1);
      }
      if (start > end || start >= total) {
        res.set("Content-Range", `bytes */${total}`);
        return res.status(416).end();
      }
      res.status(206);
      res.set("Content-Range", `bytes ${start}-${end}/${total}`);
    }

    res.set({
      "Content-Type": file.contentType || "application/octet-stream",
      "Content-Length": String(total === 0 ? 0 : end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });

    // ?download=<name> forces a "Save as" download instead of inline display
    if (req.query.download) {
      let name = String(req.query.download).replace(/[^\w.\- ]/g, "_").slice(0, 100) || "download";
      const ext = (file.filename || "").match(/\.[A-Za-z0-9]{1,8}$/)?.[0] || "";
      if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
      res.set("Content-Disposition", `attachment; filename="${name}"`);
    }

    if (total === 0) return res.end();

    // GridFS `end` is exclusive
    const stream = getBucket().openDownloadStream(fileId, { start, end: end + 1 });
    stream.on("error", (err) => {
      console.error("GridFS stream error:", err.message);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    console.error("streamFile error:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
};