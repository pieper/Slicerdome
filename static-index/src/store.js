// Where bundle bytes come from, and how they are cached.
//
// Everything under seg/ is content-addressed and never changes, so it is
// cached without expiry, keyed by the exact range read. Ranges are natural
// units of the format (one term's postings, one IVF list, one document's
// text), so a cache entry is never larger than what a query asked for.
// manifest.json is the only mutable file: it is always fetched fresh, with
// the last good copy kept for offline use.

const IS_BROWSER = typeof window !== "undefined" || typeof WorkerGlobalScope !== "undefined";

export class StoreError extends Error {}

/** Reads a bundle over HTTP(S). Needs a server (or bucket) that honours Range. */
export class HttpStore {
  constructor(baseUrl, { fetch: fetchFn } = {}) {
    this.base = String(baseUrl).replace(/\/+$/, "");
    this.fetch = fetchFn || globalThis.fetch.bind(globalThis);
    this.rangeUnsupported = false;
    this.requests = 0;
    this.bytes = 0;
  }

  url(path) {
    return `${this.base}/${path}`;
  }

  async read(path, { fresh = false } = {}) {
    const init = fresh && IS_BROWSER ? { cache: "no-cache" } : {};
    const res = await this.fetch(this.url(path), init);
    if (!res.ok) throw new StoreError(`GET ${path}: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    this.requests++;
    this.bytes += buf.byteLength;
    return buf;
  }

  async readRange(path, start, end) {
    if (end <= start) return new Uint8Array(0);
    const res = await this.fetch(this.url(path), {
      headers: { Range: `bytes=${start}-${end - 1}` },
    });
    if (res.status !== 206 && res.status !== 200) {
      throw new StoreError(`GET ${path} [${start}, ${end}): HTTP ${res.status}`);
    }
    let buf = new Uint8Array(await res.arrayBuffer());
    this.requests++;
    this.bytes += buf.byteLength;
    if (res.status === 200) {
      // The server sent the whole file. Correct, just wasteful: say so once.
      if (!this.rangeUnsupported) {
        this.rangeUnsupported = true;
        console.warn(`slicer-skill-static-search: ${this.base} ignores Range requests`);
      }
      buf = buf.subarray(start, end);
    }
    if (buf.byteLength !== end - start) {
      throw new StoreError(`GET ${path} [${start}, ${end}): got ${buf.byteLength} bytes`);
    }
    return buf;
  }
}

/** Reads a bundle from a local directory (Node only). */
export class FileStore {
  constructor(root) {
    this.root = String(root).replace(/\/+$/, "");
    this.requests = 0;
    this.bytes = 0;
  }

  async #fs() {
    return import("node:fs/promises");
  }

  async read(path) {
    const fs = await this.#fs();
    const buf = new Uint8Array(await fs.readFile(`${this.root}/${path}`));
    this.requests++;
    this.bytes += buf.byteLength;
    return buf;
  }

  async readRange(path, start, end) {
    const fs = await this.#fs();
    const fh = await fs.open(`${this.root}/${path}`, "r");
    try {
      const buf = new Uint8Array(end - start);
      const { bytesRead } = await fh.read(buf, 0, end - start, start);
      if (bytesRead !== end - start) throw new StoreError(`short read of ${path}`);
      this.requests++;
      this.bytes += bytesRead;
      return buf;
    } finally {
      await fh.close();
    }
  }
}

/** In-memory LRU bounded by total bytes. */
class MemoryLru {
  constructor(limitBytes) {
    this.limit = limitBytes;
    this.size = 0;
    this.map = new Map();
  }

  get(key) {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key, value) {
    if (this.map.has(key)) this.size -= this.map.get(key).byteLength;
    this.map.set(key, value);
    this.size += value.byteLength;
    for (const [k, v] of this.map) {
      if (this.size <= this.limit) break;
      this.map.delete(k);
      this.size -= v.byteLength;
    }
  }
}

/** Persistent cache in IndexedDB (browsers). */
export class IdbBackend {
  constructor(dbName = "slicer-skill-static-index") {
    this.dbName = dbName;
    this.dbPromise = null;
  }

  #db() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore("bytes");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  async #tx(mode, fn) {
    const db = await this.#db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("bytes", mode);
      const req = fn(tx.objectStore("bytes"));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  get(key) {
    return this.#tx("readonly", (s) => s.get(key));
  }

  put(key, value) {
    return this.#tx("readwrite", (s) => s.put(value, key));
  }

  delete(key) {
    return this.#tx("readwrite", (s) => s.delete(key));
  }

  keys() {
    return this.#tx("readonly", (s) => s.getAllKeys());
  }
}

/** Persistent cache in a directory (Node). */
export class FsBackend {
  constructor(dir) {
    this.dir = dir;
    this.ready = null;
  }

  async #fs() {
    const fs = await import("node:fs/promises");
    if (!this.ready) this.ready = fs.mkdir(this.dir, { recursive: true });
    await this.ready;
    return fs;
  }

  #file(key) {
    return `${this.dir}/${encodeURIComponent(key)}`;
  }

  async get(key) {
    const fs = await this.#fs();
    try {
      return new Uint8Array(await fs.readFile(this.#file(key)));
    } catch {
      return undefined;
    }
  }

  async put(key, value) {
    const fs = await this.#fs();
    const tmp = `${this.#file(key)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, value);
    await fs.rename(tmp, this.#file(key));
  }

  async delete(key) {
    const fs = await this.#fs();
    await fs.rm(this.#file(key), { force: true });
  }

  async keys() {
    const fs = await this.#fs();
    return (await fs.readdir(this.dir))
      .filter((f) => !f.endsWith(".tmp"))
      .map((f) => decodeURIComponent(f));
  }
}

const IMMUTABLE = /^seg\//;
const MANIFEST_KEY = "manifest.json";

/**
 * Caches an inner store. Immutable files (under seg/) are kept in memory and,
 * when `persist` is given, in a persistent backend; concurrent reads of the
 * same range share one request.
 */
export class CachedStore {
  constructor(inner, { persist = null, memoryLimit = 128 * 2 ** 20 } = {}) {
    this.inner = inner;
    this.persist = persist;
    this.memory = new MemoryLru(memoryLimit);
    this.inflight = new Map();
    this.stats = { memoryHits: 0, persistHits: 0, fetches: 0, fetchedBytes: 0 };
  }

  async read(path, opts = {}) {
    if (path === MANIFEST_KEY) return this.#readManifest(opts);
    if (!IMMUTABLE.test(path)) return this.inner.read(path, opts);
    return this.#get(path, () => this.inner.read(path));
  }

  async readRange(path, start, end) {
    if (!IMMUTABLE.test(path)) return this.inner.readRange(path, start, end);
    return this.#get(`${path}@${start}-${end}`, () => this.inner.readRange(path, start, end));
  }

  async #readManifest(opts) {
    try {
      const bytes = await this.inner.read(MANIFEST_KEY, { fresh: true, ...opts });
      if (this.persist) await this.persist.put(MANIFEST_KEY, bytes).catch(() => {});
      return bytes;
    } catch (err) {
      const cached = this.persist ? await this.persist.get(MANIFEST_KEY).catch(() => undefined) : undefined;
      if (cached) return cached; // offline: last good manifest
      throw err;
    }
  }

  async #get(key, load) {
    const hit = this.memory.get(key);
    if (hit) {
      this.stats.memoryHits++;
      return hit;
    }
    let p = this.inflight.get(key);
    if (!p) {
      p = (async () => {
        if (this.persist) {
          const stored = await this.persist.get(key).catch(() => undefined);
          if (stored) {
            this.stats.persistHits++;
            this.memory.set(key, stored);
            return stored;
          }
        }
        const data = await load();
        this.stats.fetches++;
        this.stats.fetchedBytes += data.byteLength;
        this.memory.set(key, data);
        if (this.persist) await this.persist.put(key, data).catch(() => {});
        return data;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  /** Drop persisted entries that belong to none of the given segment paths. */
  async gc(keepSegmentPaths) {
    if (!this.persist) return 0;
    const keep = [...keepSegmentPaths].map((p) => `${p}/`);
    let removed = 0;
    for (const key of await this.persist.keys()) {
      if (key === MANIFEST_KEY || keep.some((k) => key.startsWith(k))) continue;
      await this.persist.delete(key);
      removed++;
    }
    return removed;
  }
}

/** A store for `location`: an http(s) URL, or (in Node) a directory. */
export function openStore(location, { fetch } = {}) {
  if (typeof location !== "string") return location; // already a store
  if (/^https?:\/\//.test(location) || IS_BROWSER) {
    const base = IS_BROWSER && !/^https?:\/\//.test(location)
      ? new URL(location, globalThis.location.href).href
      : location;
    return new HttpStore(base, { fetch });
  }
  return new FileStore(location);
}

/** The default persistent backend for this environment (or null). */
export function defaultPersist({ cacheDir } = {}) {
  if (typeof indexedDB !== "undefined") return new IdbBackend();
  if (cacheDir) return new FsBackend(cacheDir);
  return null;
}
