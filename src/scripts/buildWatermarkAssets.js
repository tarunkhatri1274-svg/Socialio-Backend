// scripts/buildWatermarkAssets.js
// Pre-renders the watermark artwork ONCE, so the server never needs fonts:
//   assets/mark-image.png          -> static badge (S circle + 7 orbiting dots) for photos
//   assets/logo-frames/000..089.png -> animated badge + "Socialio" wordmark, one seamless
//                                     3-second loop, for videos
// Run:  node scripts/buildWatermarkAssets.js      (needs the Inter font installed;
//       change FONT below if you prefer another font)
import sharp from "sharp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "..", "assets");
const FRAMES = path.join(ASSETS, "logo-frames");

// ── tweak the look here ───────────────────────────────────────────────
// Matches the Socialio logo: tan circle + black outline + black "S" +
// seven small outlined circles touching the edge, orbiting around it.
const BRAND = "#E8B476";      // circle + orbiting circles fill
const OUTLINE = "#000000";    // outlines and the "S"
const WORDMARK = "#FFFFFF";   // "Socialio" text (video only)
const SHOW_WORDMARK = true;   // false = video shows only the animated badge
const FONT = "Inter, Helvetica, Arial, sans-serif";
const DOTS = 7;               // number of orbiting circles
const FPS = 30;
const SECONDS = 3;            // one full orbit per loop
// ─────────────────────────────────────────────────────────────────────

const badge = (t) => {
  const cx = 100, cy = 100;
  const R = 68;      // main circle radius
  const ORBIT = 80;  // distance of the small circles from the centre
  const r = 12;      // small circle radius
  let dots = "";
  for (let k = 0; k < DOTS; k++) {
    const a = 2 * Math.PI * (t + k / DOTS) - Math.PI / 2;
    dots += `<circle cx="${(cx + ORBIT * Math.cos(a)).toFixed(2)}" cy="${(cy + ORBIT * Math.sin(a)).toFixed(2)}" r="${r}" fill="${BRAND}" stroke="${OUTLINE}" stroke-width="3.5"/>`;
  }
  return `
    <g filter="url(#sh)">
      ${dots}
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="${BRAND}" stroke="${OUTLINE}" stroke-width="4.5"/>
      <text x="${cx}" y="${cy + 24}" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="72" fill="${OUTLINE}">S</text>
    </g>`;
};

const svg = (w, h, scale, inner) => `
  <svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}">
    <defs><filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1.5" stdDeviation="2.5" flood-color="#000" flood-opacity="0.38"/>
    </filter></defs>${inner}
  </svg>`;

const wmText = (extra) =>
  `<text x="212" y="127" font-family="${FONT}" font-weight="900" font-size="78" letter-spacing="-1.5" ${extra}>Socialio</text>`;
// black outline underneath + white fill on top, so it reads on light AND dark videos
const wordmark = `
  <g filter="url(#sh)">
    ${wmText(`fill="${OUTLINE}" stroke="${OUTLINE}" stroke-width="9" stroke-linejoin="round"`)}
    ${wmText(`fill="${WORDMARK}"`)}
  </g>`;

fs.mkdirSync(FRAMES, { recursive: true });

// static badge for photos (2x for crispness)
await sharp(Buffer.from(svg(200, 200, 2, badge(0.07)))).png().toFile(path.join(ASSETS, "mark-image.png"));

// animated frames for videos
const total = FPS * SECONDS;
for (let i = 0; i < total; i++) {
  const buf = Buffer.from(svg(SHOW_WORDMARK ? 620 : 200, 200, 1, badge(i / total) + (SHOW_WORDMARK ? wordmark : "")));
  await sharp(buf).png({ compressionLevel: 9 }).toFile(path.join(FRAMES, `${String(i).padStart(3, "0")}.png`));
}
console.log(`done: mark-image.png + ${total} frames`);