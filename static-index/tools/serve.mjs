#!/usr/bin/env node
// Development server: serves a bundle the way a bucket would (Range requests,
// CORS), plus this package's files so demo/index.html can load src/.
//
//   node tools/serve.mjs --bundle ../../static-bundle [--port 8791] [--verbose]
//   open http://localhost:8791/demo/?bundle=/bundle
//
// Python's http.server cannot be used for this: it ignores Range.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
};

export function contentType(file) {
  return TYPES[path.extname(file)] || "application/octet-stream";
}

/**
 * Send one file, honouring a single Range header. `stats` (optional) counts
 * requests and bytes; `cacheControl` is the Cache-Control header to send.
 */
export async function serveFile(req, res, file, { cacheControl = "no-cache", stats, verbose = false, label = file } = {}) {
  let st;
  try {
    st = await stat(file);
  } catch {
    return res.writeHead(404).end();
  }
  const headers = {
    "Content-Type": contentType(file),
    "Accept-Ranges": "bytes",
    ETag: `"${st.size}-${Math.floor(st.mtimeMs)}"`,
    "Cache-Control": cacheControl,
  };
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  let start = 0;
  let end = st.size - 1;
  let status = 200;
  if (m) {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
    if (stats) stats.ranges++;
  } else if (req.headers["if-none-match"] === headers.ETag) {
    return res.writeHead(304, headers).end();
  }
  headers["Content-Length"] = st.size === 0 ? 0 : end - start + 1;
  if (stats) {
    stats.requests++;
    stats.bytes += headers["Content-Length"];
  }
  if (verbose) console.error(`${status} ${label}${m ? ` [${start}-${end}]` : ""} ${headers["Content-Length"]}B`);
  res.writeHead(status, headers);
  if (req.method === "HEAD" || st.size === 0) return res.end();
  createReadStream(file, { start, end }).pipe(res);
}

/** Resolve a URL path against mounts {urlPrefix: directory}; null when no mount matches or the path escapes it. */
export function resolveMount(entries, pathname) {
  const mount = entries.find(([prefix]) => pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
  if (!mount) return null;
  const [prefix, dir] = mount;
  let rel = pathname.slice(prefix.length).replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(dir, rel);
  if (file !== path.resolve(dir) && !file.startsWith(path.resolve(dir) + path.sep)) return { forbidden: true };
  return { file, rel };
}

/**
 * A request listener serving mounts {urlPrefix: directory} with Range and
 * CORS. `stats` counts requests and bytes sent, which the tests use to see
 * what was fetched.
 */
export function createHandler(mounts, { verbose = false, stats = { requests: 0, bytes: 0, ranges: 0 } } = {}) {
  const entries = Object.entries(mounts).sort((a, b) => b[0].length - a[0].length);
  const handler = async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, ETag, Accept-Ranges");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
    const url = new URL(req.url, "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    const hit = resolveMount(entries, pathname);
    if (!hit) return res.writeHead(404).end();
    if (hit.forbidden) return res.writeHead(403).end();
    try {
      if ((await stat(hit.file)).isDirectory()) {
        res.writeHead(301, { Location: `${pathname}/` });
        return res.end();
      }
    } catch {
      return res.writeHead(404).end();
    }
    const cacheControl = hit.rel.startsWith("seg/") ? "public, max-age=31536000, immutable" : "no-cache";
    return serveFile(req, res, hit.file, { cacheControl, stats, verbose, label: pathname });
  };
  handler.stats = stats;
  return handler;
}

/** A server with mounts {urlPrefix: directory}. Returns {server, stats}. */
export function createServer(mounts, { verbose = false } = {}) {
  const handler = createHandler(mounts, { verbose });
  return { server: http.createServer(handler), stats: handler.stats };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const bundle = opt("--bundle");
  if (!bundle) {
    console.error("usage: node tools/serve.mjs --bundle DIR [--port 8791] [--verbose]");
    process.exit(2);
  }
  const port = Number(opt("--port", 8791));
  const { server } = createServer({ "/bundle": path.resolve(bundle), "/": PKG_ROOT }, { verbose: args.includes("--verbose") });
  server.listen(port, () => {
    console.error(`serving ${path.resolve(bundle)} at http://localhost:${port}/bundle`);
    console.error(`demo:   http://localhost:${port}/demo/?bundle=/bundle`);
  });
}
