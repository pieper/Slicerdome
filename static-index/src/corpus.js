// Search over one corpus: the segments listed for it in the manifest.
//
// Results have the same shape and ranking as the local Python MCP server
// (slicer-skill-search-mcp.py): BM25 scores match bm25s ("lucene" variant),
// snippets follow the same rules, and hybrid mode uses the same Reciprocal
// Rank Fusion. Files are identified by `path` and linked with `url` instead of
// a local `abs_path`.

import { Segment } from "./segment.js";
import { bestSnippet, pySplitlines, readLines, tokenize } from "./text.js";

export const DEFAULT_NPROBE = 64;
const KEY_BASE = 2 ** 32; // (segment, doc) -> one number

export class Corpus {
  static async open(store, manifest, name) {
    const info = manifest.corpora[name];
    if (!info) throw new Error(`unknown corpus ${name}`);
    const segments = await Promise.all(info.segments.map((p) => Segment.open(store, p)));
    return new Corpus(name, info, manifest, segments);
  }

  constructor(name, info, manifest, segments) {
    this.name = name;
    this.info = info;
    this.segments = segments;
    const bm25 = manifest.bm25 || { k1: 1.5, b: 0.75 };
    this.k1 = bm25.k1;
    this.b = bm25.b;
    // Tombstones in later segments remove documents from the base (segment 0).
    this.dead = segments.map(() => new Set());
    for (const s of segments.slice(1)) for (const d of s.tombDocs) this.dead[0].add(d);
    let n = 0;
    let total = 0;
    for (const s of segments) {
      n += s.nDocs - s.tombDocs.size;
      total += s.totalLen - s.tombLen;
    }
    this.nDocs = n;
    this.avgdl = n ? total / n : 0;
    this.pathIndex = null;
  }

  /** Corpus-wide document frequency, net of tombstones. */
  df(term) {
    let n = 0;
    for (const s of this.segments) n += s.termDf(term) - (s.tombDf.get(term) || 0);
    return n;
  }

  url(path, line = 1) {
    const spec = this.info.url;
    if (!spec) return null;
    if (spec.regex) {
      const m = new RegExp(spec.regex).exec(path);
      return m ? spec.template.replace("{1}", m[1]) : null;
    }
    return spec.template.replace("{path}", encodeURI(path)).replace("{line}", String(line || 1));
  }

  // ── lexical ──────────────────────────────────────────────────────────────

  /** Map from (segment, doc) key to BM25 score, accumulated in float32 like bm25s. */
  async bm25Scores(query) {
    const tokens = tokenize(query);
    const unique = [...new Set(tokens)].filter((t) => this.df(t) > 0);
    const postings = new Map();
    await Promise.all(
      unique.flatMap((t) =>
        this.segments.map(async (s, si) => postings.set(`${si}\0${t}`, await s.postings(t))),
      ),
    );
    const { k1, b } = this;
    const N = this.nDocs;
    const avgdl = this.avgdl;
    const scores = new Map();
    for (const t of tokens) { // duplicates count twice, as in bm25s
      const df = this.df(t);
      if (df <= 0) continue;
      const idf = Math.fround(Math.log(1 + (N - df + 0.5) / (df + 0.5)));
      for (let si = 0; si < this.segments.length; si++) {
        const p = postings.get(`${si}\0${t}`);
        if (!p) continue;
        const dead = this.dead[si];
        const lens = this.segments[si].lens;
        for (let i = 0; i < p.docs.length; i++) {
          const doc = p.docs[i];
          if (dead.has(doc)) continue;
          const tf = p.tfs[i];
          const tfc = tf / (k1 * ((1 - b) + (b * lens[doc]) / avgdl) + tf);
          const key = si * KEY_BASE + doc;
          scores.set(key, Math.fround((scores.get(key) || 0) + Math.fround(idf * tfc)));
        }
      }
    }
    return scores;
  }

  async searchLexical(query, topK = 10, { snippetLines = 5, snippets = true } = {}) {
    const scores = await this.bm25Scores(query);
    const ranked = [...scores].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, topK);
    const qset = new Set(tokenize(query));
    return Promise.all(
      ranked.map(async ([key, score]) => {
        const si = Math.floor(key / KEY_BASE);
        const doc = key % KEY_BASE;
        const s = this.segments[si];
        const hit = { path: s.paths[doc], score, line: 0, snippet: "", seg: si, doc, source: "lexical" };
        if (snippets) await this.#lexicalSnippet(hit, qset, snippetLines);
        return hit;
      }),
    );
  }

  async #lexicalSnippet(hit, qset, snippetLines = 5) {
    const text = await this.segments[hit.seg].text(hit.doc);
    [hit.line, hit.snippet] = bestSnippet(text, qset, snippetLines);
  }

  // ── vectors ──────────────────────────────────────────────────────────────

  /** True if any segment carries vectors. */
  async hasVectors() {
    const vhs = await Promise.all(this.segments.map((s) => s.vhead()));
    return vhs.some(Boolean);
  }

  /**
   * IVF search over int8 vectors with a unit query vector (Float32Array).
   * nprobe = Infinity scans every list (exact over the int8 vectors).
   */
  async searchVector(qvec, topK = 10, { nprobe = DEFAULT_NPROBE, fileDedup = true, snippets = true } = {}) {
    const cands = [];
    await Promise.all(
      this.segments.map(async (s, si) => {
        const vh = await s.vhead();
        if (!vh) return;
        const dim = vh.dim;
        const qs = new Float32Array(dim);
        for (let j = 0; j < dim; j++) qs[j] = Math.fround(qvec[j] * vh.scaleF32[j]);
        let lists;
        if (vh.nlist > 1 && nprobe < vh.nlist) {
          const cents = await s.centroids();
          const cs = new Float64Array(vh.nlist);
          for (let l = 0; l < vh.nlist; l++) {
            let acc = 0;
            const o = l * dim;
            for (let j = 0; j < dim; j++) acc += cents[o + j] * qs[j];
            cs[l] = acc;
          }
          lists = Array.from(cs.keys()).sort((x, y) => cs[y] - cs[x] || x - y).slice(0, nprobe);
        } else {
          lists = Array.from({ length: vh.nlist }, (_, l) => l);
        }
        const dead = this.dead[si];
        await Promise.all(
          lists.map(async (l) => {
            const start = vh.listStart[l];
            const n = vh.listStart[l + 1] - start;
            if (!n) return;
            const rows = await s.listRows(vh, l);
            for (let r = 0; r < n; r++) {
              const c = start + r;
              if (dead.has(vh.docOf[c])) continue;
              let acc = 0;
              const o = r * dim;
              for (let j = 0; j < dim; j++) acc += rows[o + j] * qs[j];
              cands.push([Math.fround(acc), si, c]);
            }
          }),
        );
      }),
    );
    cands.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
    const oversample = fileDedup ? topK * 5 : topK;
    const hits = [];
    const seen = new Set();
    for (const [score, si, c] of cands.slice(0, oversample)) {
      const s = this.segments[si];
      const vh = await s.vhead();
      const doc = vh.docOf[c];
      const path = s.paths[doc];
      if (fileDedup && seen.has(path)) continue;
      seen.add(path);
      hits.push({ path, score, line: vh.l0[c], lineEnd: vh.l1[c], snippet: "", seg: si, doc, source: "vector" });
      if (hits.length >= topK) break;
    }
    if (snippets) await Promise.all(hits.map((h) => this.#vectorSnippet(h)));
    return hits;
  }

  async #vectorSnippet(hit) {
    hit.snippet = readLines(await this.segments[hit.seg].text(hit.doc), hit.line, hit.lineEnd);
  }

  // ── hybrid ───────────────────────────────────────────────────────────────

  /** Reciprocal Rank Fusion, same rules as vector_lib.rrf_fuse. */
  static rrf(lists, weights, k = 60, topK = 10) {
    const fused = new Map();
    const best = new Map();
    lists.forEach((hits, li) => {
      hits.forEach((hit, i) => {
        const rank = i + 1;
        fused.set(hit.path, (fused.get(hit.path) || 0) + weights[li] / (k + rank));
        const prev = best.get(hit.path);
        if (!prev || rank < prev.rank) best.set(hit.path, { rank, hit });
      });
    });
    return [...fused]
      .sort((x, y) => y[1] - x[1])
      .slice(0, topK)
      .map(([path, score]) => ({ ...best.get(path).hit, score }));
  }

  async searchHybrid(query, qvec, topK = 10, { lexicalWeight = 1, vectorWeight = 1, nprobe } = {}) {
    const pool = Math.max(topK * 3, 30);
    const [lex, vec] = await Promise.all([
      this.searchLexical(query, pool, { snippets: false }),
      this.searchVector(qvec, pool, { nprobe, snippets: false }),
    ]);
    const fused = Corpus.rrf([lex, vec], [lexicalWeight, vectorWeight], 60, topK);
    // Snippets only for what is returned, from the signal that ranked it best.
    const qset = new Set(tokenize(query));
    await Promise.all(
      fused.map((h) => (h.source === "lexical" ? this.#lexicalSnippet(h, qset) : this.#vectorSnippet(h))),
    );
    return fused;
  }

  // ── files ────────────────────────────────────────────────────────────────

  /** Where the live copy of `path` is: the newest segment that has it and has not tombstoned it. */
  locate(path) {
    if (!this.pathIndex) {
      this.pathIndex = new Map();
      this.segments.forEach((s, si) => {
        s.paths.forEach((p, doc) => {
          if (!this.dead[si].has(doc)) this.pathIndex.set(p, [si, doc]);
        });
      });
    }
    return this.pathIndex.get(path) || null;
  }

  /** Lines [offset, offset + limit) of a file (1-based), like a Read tool. */
  async readFile(path, { offset = 1, limit = 400 } = {}) {
    const where = this.locate(path);
    if (!where) return null;
    const [si, doc] = where;
    const lines = pySplitlines(await this.segments[si].text(doc));
    const start = Math.max(1, offset);
    const end = Math.min(lines.length, start + limit - 1);
    return {
      corpus: this.name,
      path,
      url: this.url(path, start),
      total_lines: lines.length,
      start_line: start,
      end_line: end,
      text: lines.slice(start - 1, end).join("\n"),
    };
  }

  /** Paths in the corpus matching a substring or glob-ish pattern (for discovery). */
  listPaths(pattern = "", limit = 200) {
    this.locate("");
    const re = pattern.includes("*")
      ? new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`)
      : null;
    const out = [];
    for (const p of this.pathIndex.keys()) {
      if (re ? re.test(p) : p.includes(pattern)) {
        out.push(p);
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}
