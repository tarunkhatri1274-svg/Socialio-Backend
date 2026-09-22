import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import multer from "multer";

cloudinary.config({
  cloudinary_url: process.env.CLOUDINARY_URL,
});

cloudinary.api.ping((error, result) => {
  if (error) {
    console.log("Cloudinary connection failed ❌", error.message);
  } else {
    console.log("Cloudinary connected successfully ✅", result);
  }
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    return {
      folder: "your_project_name",
      resource_type: "auto",
    };
  },
});

// ── General upload (profile pics, etc.) — unchanged. Deliberately small:
// this is for small avatar/cover images, not chat attachments.
const FILE_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB

export const upload = multer({
  storage,
  limits: { fileSize: FILE_SIZE_LIMIT },
});

// ── Story upload — ceiling set to the larger of the two (video) so multer
// doesn't reject a valid video at the transport layer. The PRECISE rule
// (image < 10MB, video < 20MB) is enforced in story.controllers.js using
// req.file.size + req.file.mimetype, AFTER upload, because multer's
// per-route fileSize limit can't vary by mimetype on its own. If a file
// exceeds the wrong-type limit, the controller deletes it from Cloudinary
// immediately and returns 400 — so nothing oversized lingers.
const STORY_MAX_BYTES = 20 * 1024 * 1024; // 20MB ceiling (video limit)

export const uploadStory = multer({
  storage,
  limits: { fileSize: STORY_MAX_BYTES },
});

// ── Post upload — same "ceiling at transport layer, precise check after
// upload" pattern as uploadStory above. Rules:
//   image post  < 10MB
//   video post  < 20MB
//   text post's attached images < 10MB (same as image rule)
// multer can't vary fileSize by mimetype within a single field config,
// so the limit here is set to the LARGER of the two (video, 20MB) and
// the controller enforces the precise per-type rule after upload,
// deleting the Cloudinary asset(s) immediately if oversized for their
// actual type (identical pattern to addStory in story.controllers.js).
// See enforcePostMediaLimits() in media.controllers.js for the precise
// check, and POST routes in mediaroutes.js for where this is wired in.
export const MAX_POST_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_POST_VIDEO_BYTES = 20 * 1024 * 1024; // 20MB
const POST_UPLOAD_CEILING = MAX_POST_VIDEO_BYTES; // 20MB — multer's hard stop

export const uploadPost = multer({
  storage,
  limits: { fileSize: POST_UPLOAD_CEILING },
});

// ── Message (DM) attachment upload — NEW. Previously this had no
// dedicated config at all: message.routes.js's POST /messages/upload
// used the generic `upload` above, whose 5MB limit is sized for tiny
// things like profile pictures, not chat attachments. Any photo from a
// modern phone, any short video, or even some voice notes routinely
// exceed 5MB, so that route was rejecting normal everyday attachments
// with a 400 ("File too large") that the frontend then masked behind a
// generic, misleading "Upload failed" alert.
//
// Same ceiling-at-transport-layer / precise-check-after-upload pattern:
// the ceiling here covers the largest allowed type (video), and the
// route handler enforces the tighter per-type rule after upload,
// deleting the Cloudinary asset immediately if it's oversized for its
// actual type — identical pattern to posts/stories above.
export const MAX_MESSAGE_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_MESSAGE_AUDIO_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_MESSAGE_VIDEO_BYTES = 25 * 1024 * 1024; // 25MB
export const MAX_MESSAGE_FILE_BYTES  = 15 * 1024 * 1024; // 15MB (documents/other)
const MESSAGE_UPLOAD_CEILING = MAX_MESSAGE_VIDEO_BYTES; // 25MB — multer's hard stop

export const uploadMessage = multer({
  storage,
  limits: { fileSize: MESSAGE_UPLOAD_CEILING },
});
// ── Chat/group wallpaper upload — NEW. A wallpaper is a single background
// photo, not a full-size attachment, so it gets its own small ceiling
// instead of reusing uploadMessage's 25MB video-sized one.
export const MAX_WALLPAPER_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB

export const uploadWallpaper = multer({
  storage,
  limits: { fileSize: MAX_WALLPAPER_IMAGE_BYTES },
});
// ← Add this middleware after any upload route
export const handleUploadError = (err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      success: false,
      message: "File too large.",
    });
  }
  next(err);
};

export default cloudinary;