// A published bundle: manifest.json plus the segments it lists.

import { decodeText } from "./codec.js";
import { Corpus } from "./corpus.js";
import { CachedStore, defaultPersist, openStore } from "./store.js";

const SUPPORTED_FORMAT = 1;

function round(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export class Bundle {
  /**
   * Open a bundle.
   *   location   https URL (or, in Node, a directory) of the bundle root
   *   embedder   object with async embed(text) -> Float32Array, or null for lexical only
   *   persist    persistent cache backend; default IndexedDB in browsers,
   *              a directory in Node when cacheDir is given, else none
   */
  static async open(location, { fetch, persist, cacheDir, memoryLimit, embedder = null } = {}) {
    const inner = openStore(location, { fetch });
    const backend = persist === undefined ? defaultPersist({ cacheDir }) : persist;
    const store = new CachedStore(inner, { persist: backend, memoryLimit });
    const bundle = new Bundle(store, embedder);
    await bundle.refresh();
    return bundle;
  }

  constructor(store, embedder) {
    this.store = store;
    this.embedder = embedder;
    this.manifest = null;
    this.corpora = new Map();
    this.embedError = null;
  }

  /** Re-read manifest.json; corpora whose segment lists changed are reopened lazily. */
  async refresh() {
    const manifest = JSON.parse(decodeText(await this.store.read("manifest.json")));
    if (manifest.format !== SUPPORTED_FORMAT) {
      throw new Error(`bundle format ${manifest.format} is not supported (expected ${SUPPORTED_FORMAT})`);
    }
    const old = this.manifest;
    this.manifest = manifest;
    for (const name of [...this.corpora.keys()]) {
      const a = old?.corpora[name]?.segments;
      const b = manifest.corpora[name]?.segments;
      if (JSON.stringify(a) !== JSON.stringify(b)) this.corpora.delete(name);
    }
    return manifest;
  }

  get corpusNames() {
    return Object.keys(this.manifest.corpora);
  }

  corpus(name) {
    let p = this.corpora.get(name);
    if (!p) {
      p = Corpus.open(this.store, this.manifest, name);
      p.catch(() => this.corpora.delete(name));
      this.corpora.set(name, p);
    }
    return p;
  }

  /** Remove persisted cache entries for segments no longer in the manifest. */
  gc() {
    const keep = Object.values(this.manifest.corpora).flatMap((c) => c.segments);
    return this.store.gc(keep);
  }

  async #embed(query) {
    if (!this.embedder || !this.manifest.embedding) return null;
    try {
      return await this.embedder.embed(query);
    } catch (err) {
      this.embedError = String(err?.message || err);
      return null;
    }
  }

  /**
   * Search one corpus. Returns the same JSON shape as the local Python MCP
   * server: {corpus, query, mode, lexical_weight, vector_weight, results}.
   */
  async search(name, query, { topK = 10, mode = "auto", lexicalWeight = 1, vectorWeight = 1, nprobe } = {}) {
    const corpus = await this.corpus(name);
    topK = Math.max(1, Math.min(Number(topK) || 10, 50));
    if (!["auto", "lexical", "vector", "hybrid"].includes(mode)) {
      throw new Error(`mode must be one of auto, lexical, vector, hybrid; got ${mode}`);
    }
    let resolved = mode === "auto" ? "hybrid" : mode;
    let qvec = null;
    if (resolved !== "lexical") {
      qvec = (await corpus.hasVectors()) ? await this.#embed(query) : null;
      if (!qvec) resolved = mode === "auto" ? "lexical" : "lexical (vector unavailable)";
    }
    const opts = nprobe ? { nprobe } : {};
    let hits;
    if (resolved === "vector") hits = await corpus.searchVector(qvec, topK, opts);
    else if (resolved === "hybrid") {
      hits = await corpus.searchHybrid(query, qvec, topK, { lexicalWeight, vectorWeight, ...opts });
    } else hits = await corpus.searchLexical(query, topK);
    const hybrid = resolved === "hybrid";
    return {
      corpus: name,
      query,
      mode: resolved,
      lexical_weight: hybrid ? lexicalWeight : null,
      vector_weight: hybrid ? vectorWeight : null,
      results: hits.map((h) => ({
        path: h.path,
        url: corpus.url(h.path, h.line),
        score: round(h.score, 3),
        line: h.line,
        snippet: h.snippet,
      })),
    };
  }

  async readFile(name, path, opts) {
    return (await this.corpus(name)).readFile(path, opts);
  }

  async listFiles(name, pattern, limit) {
    return (await this.corpus(name)).listPaths(pattern, limit);
  }

  status() {
    const m = this.manifest;
    return {
      generated_at: m.generated_at,
      embedding: m.embedding,
      query_embedder: this.embedder ? this.embedder.model : null,
      query_embedder_error: this.embedError,
      corpora: Object.fromEntries(
        Object.entries(m.corpora).map(([name, c]) => [
          name,
          { label: c.label, n_docs: c.n_docs, repo: c.repo, commit: c.commit, segments: c.segments.map((s) => s.split("/").pop()) },
        ]),
      ),
      cache: { ...this.store.stats, memory_bytes: this.store.memory.size },
    };
  }
}
