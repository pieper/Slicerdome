// One immutable segment of a corpus: see static-index/FORMAT.md.

import { decodePostings, gunzipJson, gunzipText, offsets } from "./codec.js";

export class Segment {
  /** Fetch and parse a segment's head (doc table, term dictionary, stats). */
  static async open(store, path) {
    const head = await gunzipJson(await store.read(`${path}/head.json.gz`));
    return new Segment(store, path, head);
  }

  constructor(store, path, head) {
    this.store = store;
    this.path = path;
    this.id = path.split("/").pop();
    this.head = head;
    this.kind = head.kind;
    this.nDocs = head.n_docs;
    this.totalLen = head.total_len;

    const terms = head.terms ? head.terms.split("\n") : [];
    this.termIndex = new Map();
    for (let i = 0; i < terms.length; i++) this.termIndex.set(terms[i], i);
    this.df = Int32Array.from(head.df);
    this.postOff = offsets(head.post_size);

    this.paths = head.docs.path;
    this.lens = Int32Array.from(head.docs.len);
    this.textOff = offsets(head.docs.text_size);

    const tomb = head.tomb;
    this.tombDocs = new Set(tomb ? tomb.docs : []);
    this.tombLen = tomb ? tomb.total_len : 0;
    this.tombDf = new Map();
    if (tomb && tomb.terms) {
      tomb.terms.split("\n").forEach((t, i) => this.tombDf.set(t, tomb.df[i]));
    }
    this.vheadPromise = null;
    this.centroidsPromise = null;
  }

  /** This segment's document count for a term (0 if absent). */
  termDf(term) {
    const i = this.termIndex.get(term);
    return i === undefined ? 0 : this.df[i];
  }

  /** {docs, tfs} for a term, or null when the segment does not contain it. */
  async postings(term) {
    const i = this.termIndex.get(term);
    if (i === undefined) return null;
    const bytes = await this.store.readRange(`${this.path}/postings.bin`, this.postOff[i], this.postOff[i + 1]);
    return decodePostings(bytes, this.df[i]);
  }

  /** Raw text of a document (what read_file returns). */
  async text(doc) {
    const bytes = await this.store.readRange(`${this.path}/texts.pack`, this.textOff[doc], this.textOff[doc + 1]);
    return gunzipText(bytes);
  }

  /** Chunk table and IVF layout, or null when the segment has no vectors. */
  vhead() {
    if (!this.vheadPromise) {
      this.vheadPromise = this.store
        .read(`${this.path}/vhead.json.gz`)
        .then(gunzipJson)
        .then((vh) => {
          vh.scaleF32 = Float32Array.from(vh.scale);
          vh.docOf = Int32Array.from(vh.doc);
          vh.listStart = offsets(vh.list_size);
          return vh;
        })
        .catch(() => null);
    }
    return this.vheadPromise;
  }

  async centroids() {
    if (!this.centroidsPromise) {
      this.centroidsPromise = this.store.read(`${this.path}/centroids.i8`).then((b) => new Int8Array(b.buffer, b.byteOffset, b.byteLength));
    }
    return this.centroidsPromise;
  }

  /** int8 rows of one IVF list (row-major, vh.dim per row). */
  async listRows(vh, list) {
    const a = vh.listStart[list] * vh.dim;
    const b = vh.listStart[list + 1] * vh.dim;
    const bytes = await this.store.readRange(`${this.path}/vectors.i8`, a, b);
    return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}
