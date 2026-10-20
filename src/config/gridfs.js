// config/gridfs.js
// MongoDB GridFS replacement for config/cloudinary.js.
// Files are stored in the "uploads" bucket of the SAME database mongoose is
// already connected to, and are served back through GET /files/:id
// (see controllers/file.controller.js + routes/file.routes.js).
//
// The multer exports below keep the exact same names and limits as the old
// Cloudinary config, and the storage engine sets `file.path` to the public
// URL, so controllers that read req.file.path / req.file.size keep working.

import mongoose from "mongoose";
import multer from "multer";

const BUCKET_NAME = "uploads";
export const FILES_PATH = "/files";

// ── Bucket (created lazily, once mongoose is connected) ─────────────────
let bucket = null;
export const getBucket = () => {
  if (!bucket) {
    if (!mongoose.connection.db) {
      throw new Error("MongoDB is not connected yet");
    }
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: BUCKET_NAME,
    });
  }
  return bucket;
};
mongoose.connection.on("disconnected", () => {
  bucket = null;
});

// ── URL helpers ─────────────────────────────────────────────────────────
// Set PUBLIC_BASE_URL on Render (e.g. https://your-app.onrender.com).
// Without it, the URL is built from the incoming request.
const publicBase = (req) => {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  }
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https")
    .toString()
    .split(",")[0];
  return `${proto}://${req.get("host")}`;
};

export const buildFileUrl = (req, id) => `${publicBase(req)}${FILES_PATH}/${id}`;

const FILE_URL_RE = /\/files\/([0-9a-fA-F]{24})(?:[/?#]|$)/;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// Accepts a full file URL OR a bare 24-char id.
export const extractFileId = (urlOrId) => {
  if (!urlOrId) return null;
  const s = String(urlOrId);
  if (OBJECT_ID_RE.test(s)) return s;
  const m = s.match(FILE_URL_RE);
  return m ? m[1] : null;
};

// ── Delete helpers (never throw — callers are cleanup paths) ────────────
export const deleteFileById = async (idOrUrl) => {
  const id = extractFileId(idOrUrl);
  if (!id) return false;
  try {
    await getBucket().delete(new mongoose.Types.ObjectId(id));
    return true;
  } catch (err) {
    if (/FileNotFound/i.test(`${err?.name} ${err?.message}`)) {
      console.warn("GridFS delete: file not found:", id);
    } else {
      console.error("GridFS delete error:", id, err.message);
    }
    return false;
  }
};

export const deleteFileByUrl = async (url) => {
  const id = extractFileId(url);
  if (!id) {
    if (url) console.warn("GridFS delete: no file id in", url);
    return false;
  }
  return deleteFileById(id);
};

// Same shape the old extractCloudinaryMeta() returned, so Story docs that
// store { publicId, resourceType, bytes } keep working. resourceType uses
// Cloudinary's vocabulary (image | video | raw; audio counted as video).
export const extractFileMeta = (file) => {
  const mt = file?.mimetype || "";
  return {
    publicId: file?.id ? String(file.id) : null,
    resourceType:
      mt.startsWith("video/") || mt.startsWith("audio/") ? "video" :
      mt.startsWith("image/") ? "image" :
      "raw",
    bytes: file?.size ?? 0,
  };
};

// ── Multer storage engine → GridFS ──────────────────────────────────────
class GridFsStorage {
  _handleFile(req, file, cb) {
    let uploadStream;
    try {
      uploadStream = getBucket().openUploadStream(
        file.originalname || "upload",
        {
          contentType: file.mimetype,
          metadata: { uploadedBy: req.user?._id || req.user?.id || null },
        }
      );
    } catch (err) {
      return cb(err);
    }

    file.stream.on("error", (err) => {
      uploadStream.destroy();
      cb(err);
    });
    uploadStream.on("error", cb);
    uploadStream.on("finish", () => {
      cb(null, {
        id: uploadStream.id,
        filename: String(uploadStream.id),
        path: buildFileUrl(req, uploadStream.id),
        size: uploadStream.length,
      });
    });

    file.stream.pipe(uploadStream);
  }

  _removeFile(req, file, cb) {
    deleteFileById(file.id).then(() => cb(null));
  }
}

const storage = new GridFsStorage();

// ── Upload configs (same names + limits as before) ──────────────────────
const FILE_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB — avatars / covers
export const upload = multer({ storage, limits: { fileSize: FILE_SIZE_LIMIT } });

const STORY_MAX_BYTES = 20 * 1024 * 1024;
export const uploadStory = multer({ storage, limits: { fileSize: STORY_MAX_BYTES } });

export const MAX_POST_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_POST_VIDEO_BYTES = 20 * 1024 * 1024;
export const uploadPost = multer({
  storage,
  limits: { fileSize: MAX_POST_VIDEO_BYTES },
});

export const MAX_MESSAGE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_FILE_BYTES = 15 * 1024 * 1024;
export const uploadMessage = multer({
  storage,
  limits: { fileSize: MAX_MESSAGE_VIDEO_BYTES },
});

export const MAX_WALLPAPER_IMAGE_BYTES = 8 * 1024 * 1024;
export const uploadWallpaper = multer({
  storage,
  limits: { fileSize: MAX_WALLPAPER_IMAGE_BYTES },
});

export const handleUploadError = (err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ success: false, message: "File too large." });
  }
  next(err);
};