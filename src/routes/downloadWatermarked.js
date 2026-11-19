// routes/downloadWatermarked.js
// GET /auth/download-watermarked?type=image|video&url=<media url>
//   image -> JPEG with the static Socialio badge (S circle + 7 orbiting circles)
//   video -> MP4 with the animated Socialio logo looping in the bottom-left corner
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DownloadRouter = express.Router();

const MARK_IMAGE = path.join(__dirname, "..", "assets", "mark-image.png");
const FRAMES_DIR = path.join(__dirname, "..", "assets", "logo-frames");
const FRAMES_PATTERN = path.join(FRAMES_DIR, "%03d.png");
const FPS = 30; // must match scripts/buildWatermarkAssets.js

// Size and position, as a fraction of the media's SHORTER side
const IMAGE_BADGE_RATIO = 0.14; // photos: badge size
const VIDEO_LOGO_RATIO = 0.42;  // videos: whole logo width (badge + wordmark)
const MARGIN_RATIO = 0.04;      // gap from the left and bottom edges

const MAX_BYTES = 300 * 1024 * 1024;

// Only fetch media from YOUR server. Comma separated host names, e.g.
//   WATERMARK_ALLOWED_HOSTS=api.socialio.com
const ALLOWED_HOSTS = (process.env.WATERMARK_ALLOWED_HOSTS || "")
  .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const ok = u.protocol === "https:" || (process.env.NODE_ENV !== "production" && u.protocol === "http:");
  if (!ok || !ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) return null;
  return u;
}

async function fetchToFile(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Source returned ${res.status}`);
  if (Number(res.headers.get("content-length") || 0) > MAX_BYTES) throw new Error("File too large");
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  if (fs.statSync(dest).size > MAX_BYTES) throw new Error("File too large");
}

async function watermarkImage(input, output) {
  const base = sharp(input, { failOn: "none" }).rotate(); // apply EXIF rotation
  const { info } = await base.clone().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const short = Math.min(width, height);

  const size = Math.max(48, Math.round(short * IMAGE_BADGE_RATIO));
  const badge = await sharp(MARK_IMAGE).resize({ width: size, height: size }).png().toBuffer();
  const margin = Math.round(short * MARGIN_RATIO);

  await base
    .composite([{ input: badge, left: margin, top: Math.max(0, height - size - margin) }])
    .jpeg({ quality: 92 })
    .toFile(output);
}

const probe = (file) =>
  new Promise((resolve, reject) =>
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return reject(err);
      const v = data.streams.find((st) => st.codec_type === "video");
      if (!v) return reject(new Error("No video stream"));
      resolve({ width: v.width, height: v.height });
    })
  );

async function watermarkVideo(input, output) {
  const { width, height } = await probe(input);
  const short = Math.min(width, height); // rotation-proof: min() is the same either way

  const first = await sharp(path.join(FRAMES_DIR, "000.png")).metadata();
  const logoW = Math.max(120, Math.round((short * VIDEO_LOGO_RATIO) / 2) * 2);
  const logoH = Math.round((logoW * first.height) / first.width / 2) * 2;
  const margin = Math.round(short * MARGIN_RATIO);

  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .input(FRAMES_PATTERN)
      // the PNG sequence is the animated logo; -loop 1 repeats it for the whole video
      .inputOptions(["-framerate", String(FPS), "-loop", "1"])
      .complexFilter(
        [
          `[1:v]scale=${logoW}:${logoH}[wm]`,
          `[0:v][wm]overlay=x=${margin}:y=H-h-${margin}:shortest=1[v]`,
        ],
        "v"
      )
      .outputOptions([
        "-map", "0:a?", // keep the original audio
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "copy", "-movflags", "+faststart",
      ])
      .on("end", resolve)
      .on("error", reject)
      .save(output);
  });
}

DownloadRouter.get("/download-watermarked", async (req, res) => {
  const u = checkUrl(req.query.url);
  const isVideo = req.query.type === "video";
  if (!u) return res.status(400).json({ error: "Invalid media url" });

  const id = crypto.randomBytes(8).toString("hex");
  const tmpIn = path.join(os.tmpdir(), `wm_in_${id}`);
  const tmpOut = path.join(os.tmpdir(), `wm_out_${id}.${isVideo ? "mp4" : "jpg"}`);
  const cleanup = () => { fs.unlink(tmpIn, () => {}); fs.unlink(tmpOut, () => {}); };

  try {
    await fetchToFile(u.href, tmpIn);
    if (isVideo) await watermarkVideo(tmpIn, tmpOut);
    else await watermarkImage(tmpIn, tmpOut);

    res.setHeader("Content-Type", isVideo ? "video/mp4" : "image/jpeg");
    res.setHeader("Content-Length", fs.statSync(tmpOut).size);
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(tmpOut).on("close", cleanup).pipe(res);
  } catch (err) {
    console.log("[watermark] failed:", err.message);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: "Could not process media" });
  }
});

export default DownloadRouter;