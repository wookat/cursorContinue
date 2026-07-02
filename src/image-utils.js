"use strict";

// ---------------------------------------------------------------------------
// image-utils — image paste/preview/cleanup helpers: readImageThumb produces
// a data URL for panel preview, savePastedImage decodes a pasted data URL to
// disk, and cleanupImages prunes old files beyond the configured limit.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const { makeId } = require("./fs-utils.js");
const { ensureRuntime } = require("./paths.js");
const { readSettings } = require("./settings.js");

function cleanupImages(imagesDir, limit) {
  if (!limit || limit <= 0) return;
  try {
    if (!fs.existsSync(imagesDir)) return;
    const files = fs.readdirSync(imagesDir)
      .map((name) => {
        const filePath = path.join(imagesDir, name);
        try {
          const stat = fs.statSync(filePath);
          return stat.isFile() ? { filePath, mtimeMs: stat.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const item of files.slice(limit)) fs.rmSync(item.filePath, { force: true });
  } catch {
    // Best effort.
  }
}

const THUMB_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
};
const THUMB_MAX_BYTES = 3 * 1024 * 1024;

// F-7: produce a data URL so the panel can preview an attached image. Capped by
// size (pasted images are already downscaled in the webview); larger picked
// files just fall back to the filename chip. CSP allows img-src data:.
function readImageThumb(filePath) {
  try {
    const mime = THUMB_MIME[path.extname(String(filePath)).toLowerCase()];
    if (!mime) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > THUMB_MAX_BYTES) return null;
    return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
  } catch {
    return null;
  }
}

function savePastedImage(context, dataUrl) {
  const paths = ensureRuntime(context);
  const settings = readSettings(paths);
  const match = String(dataUrl || "").match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) throw new Error("收到的图片不是 data URL 格式。");
  // Cap decoded image size so a huge accidental/malicious paste can't exhaust
  // host memory/disk (base64 decodes to ~3/4 of its length).
  const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
  if (Math.floor(match[2].length * 0.75) > MAX_IMAGE_BYTES) {
    throw new Error(`粘贴的图片过大，上限 ${MAX_IMAGE_BYTES / 1048576}MB。`);
  }
  const ext = match[1].toLowerCase().replace("jpeg", "jpg").replace("+xml", "");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`粘贴的图片过大（${Math.round(buffer.length / 1048576)}MB），上限 ${MAX_IMAGE_BYTES / 1048576}MB。`);
  }
  const filePath = path.join(paths.images, `${makeId("paste")}.${ext}`);
  fs.mkdirSync(paths.images, { recursive: true });
  fs.writeFileSync(filePath, buffer);
  cleanupImages(paths.images, settings.imageLimit);
  return filePath;
}

module.exports = {
  cleanupImages,
  readImageThumb,
  savePastedImage,
};
