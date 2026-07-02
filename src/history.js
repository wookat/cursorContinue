"use strict";

// ---------------------------------------------------------------------------
// history — read JSONL history files (global or per-session) as parsed
// record arrays. Uses a tail-read heuristic for large files to avoid
// loading the entire file into memory.
// ---------------------------------------------------------------------------

const fs = require("fs");

function readHistory(filePath, limit = 100) {
  try {
    // For large history files, read only the tail instead of the whole file.
    // Each JSONL line is ~200-500 bytes; limit*1024 covers the last N lines
    // with comfortable margin. Falls back to full read if the heuristic is
    // too small (e.g. lines with large image contexts).
    const stat = fs.statSync(filePath);
    const tailBytes = limit * 1024;
    if (stat.size > tailBytes) {
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(tailBytes);
        const bytes = fs.readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
        const text = buf.toString("utf8", 0, bytes);
        // Drop the partial first line (it starts mid-record).
        const firstNewline = text.indexOf("\n");
        const lines = (firstNewline >= 0 ? text.slice(firstNewline + 1) : text).split(/\r?\n/).filter(Boolean).slice(-limit);
        return lines.map((line) => {
          try { return JSON.parse(line); } catch { return { type: "raw", text: line }; }
        });
      } finally {
        fs.closeSync(fd);
      }
    }
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "raw", text: line };
      }
    });
  } catch {
    return [];
  }
}

module.exports = {
  readHistory,
};
