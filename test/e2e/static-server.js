// The smallest equivalent of a local static file server for the shell
// smoke tests, using only Node's built-in http/fs/path modules — no new
// dependency for this. It serves the repository root exactly as GitHub
// Pages would (a plain static file tree), over http://, so the page's
// `type="module"` Firebase bootstrap script loads correctly (module
// scripts loaded from a file:// origin are a well-known source of
// avoidable browser flakiness).
//
// This is test-time infrastructure only. It never writes to any file
// and has no effect on how GitHub Pages serves the production site.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = normalize(join(fileURLToPath(import.meta.url), "..", "..", ".."));
const PORT = 4173;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".gif": "image/gif",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const requestPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const filePath = normalize(join(ROOT, relativePath));

  // Refuse to serve anything outside the repository root.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(filePath)] || "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Static server for smoke tests listening on http://127.0.0.1:${PORT}`);
});
