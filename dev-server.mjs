#!/usr/bin/env node
// Local server for the chat page, laid out the way the bucket will be:
//
//   /                  this directory (index.html, src/, bench/)
//   /static-index/     the search client (./static-index in the Slicerdome repository,
//                      ../static-index/js in slicer-skill)
//   /bundle/           a static index bundle (--bundle DIR), if given
//   /slicerweb/        SlicerWeb, fetched from its published site on first use and kept in
//                      --cache-dir, so it is served from this origin. The chat page can only
//                      reach SlicerWeb's Python when both come from the same origin.
//
//   node dev-server.mjs [--port 8795] [--bundle ../static-bundle] [--cache-dir DIR] [--verbose]
//   open http://localhost:8795/

import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The search client and its file server: ./static-index in the Slicerdome repository, the
// static-index package next to this directory in slicer-skill.
const STATIC_INDEX = existsSync(path.join(HERE, "static-index", "tools", "serve.mjs")) ? path.join(HERE, "static-index") : path.resolve(HERE, "../static-index/js");
const { createHandler, serveFile } = await import(path.join(STATIC_INDEX, "tools", "serve.mjs"));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const port = Number(opt("--port", 8795));
const bundle = opt("--bundle");
const cacheDir = path.resolve(opt("--cache-dir", path.join(os.homedir(), ".cache", "slicerdome")));
const upstream = opt("--slicerweb", "https://lassoan.github.io/slicerweb-app/");
const verbose = args.includes("--verbose");
const REVALIDATE_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
// Files that keep their name when a new SlicerWeb build is published. Everything else (hashed
// assets, the Pyodide runtime, sample data) is fetched once and then served from the cache.
const MUTABLE = /(^|\/)(index\.html|sw\.js|index\.json|application\.json|build-info\.json)$|\.whl$/;

const mounts = { "/": HERE, "/static-index": STATIC_INDEX };
if (bundle) mounts["/bundle"] = path.resolve(bundle);
const handler = createHandler(mounts, { verbose });

const swFiles = path.join(cacheDir, "slicerweb", "files");
const swMeta = path.join(cacheDir, "slicerweb", "meta");
const checked = new Map(); // rel -> time of last revalidation in this process
const inflight = new Map(); // rel -> promise

/** Make sure the cached copy of `rel` is current (revalidating at most once a minute); returns its path. */
async function ensureCached(rel) {
  const file = path.join(swFiles, rel);
  const metaFile = path.join(swMeta, `${rel}.json`);
  if (!file.startsWith(swFiles + path.sep)) throw Object.assign(new Error("bad path"), { status: 403 });
  const last = checked.get(rel);
  if (last && Date.now() - last < REVALIDATE_MS) return file;
  if (!MUTABLE.test(rel)) {
    try {
      await stat(file);
      await stat(metaFile);
      checked.set(rel, Date.now());
      return file;
    } catch {}
  }
  if (inflight.has(rel)) return inflight.get(rel);
  const p = (async () => {
    let meta = null;
    try {
      meta = JSON.parse(await readFile(metaFile, "utf8"));
      await stat(file);
    } catch {
      meta = null;
    }
    const headers = {};
    if (meta?.etag) headers["If-None-Match"] = meta.etag;
    let resp;
    try {
      resp = await fetch(new URL(rel, upstream), { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (e) {
      if (meta) return file; // offline: serve what we have
      throw Object.assign(new Error(`upstream unreachable: ${e.message}`), { status: 502 });
    }
    if (resp.status === 304 && meta) {
      checked.set(rel, Date.now());
      return file;
    }
    if (!resp.ok) throw Object.assign(new Error(`upstream ${resp.status}`), { status: resp.status });
    await mkdir(path.dirname(file), { recursive: true });
    await mkdir(path.dirname(metaFile), { recursive: true });
    const tmp = `${file}.part-${process.pid}`;
    try {
      // The body gets its own, longer deadline: sample data can be tens of MB.
      await Promise.race([
        pipeline(Readable.fromWeb(resp.body), createWriteStream(tmp)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("download stalled")), 10 * UPSTREAM_TIMEOUT_MS)),
      ]);
    } catch (e) {
      if (meta) return file;
      throw Object.assign(new Error(`${rel}: ${e.message}`), { status: 504 });
    }
    await rename(tmp, file);
    await writeFile(metaFile, JSON.stringify({ etag: resp.headers.get("etag"), url: resp.url, fetched: new Date().toISOString() }));
    if (verbose) console.error(`fetched ${rel} (${resp.headers.get("content-length") ?? "?"} B)`);
    checked.set(rel, Date.now());
    return file;
  })().finally(() => inflight.delete(rel));
  inflight.set(rel, p);
  return p;
}

const server = http.createServer(async (req, res) => {
  if (verbose) {
    const t0 = Date.now();
    console.error(`> ${req.method} ${req.url}${req.headers.range ? ` [${req.headers.range}]` : ""}`);
    res.on("close", () => console.error(`< ${res.statusCode} ${req.url} ${Date.now() - t0} ms${res.writableFinished ? "" : " (closed early)"}`));
  }
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === "/slicerweb") {
    res.writeHead(301, { Location: `/slicerweb/${url.search}` });
    return res.end();
  }
  if (!pathname.startsWith("/slicerweb/")) return handler(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
  let rel = pathname.slice("/slicerweb/".length);
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  try {
    const file = await ensureCached(rel);
    return serveFile(req, res, file, { cacheControl: "no-cache", verbose, label: pathname });
  } catch (e) {
    if (verbose) console.error(`${e.status ?? 500} ${pathname}: ${e.message}`);
    return res.writeHead(e.status ?? 500).end(e.message);
  }
});

server.listen(port, () => {
  console.error(`chat:      http://localhost:${port}/`);
  console.error(`slicerweb: http://localhost:${port}/slicerweb/  (from ${upstream}, cached in ${cacheDir})`);
  if (bundle) console.error(`index:     http://localhost:${port}/bundle  (${path.resolve(bundle)})`);
});
