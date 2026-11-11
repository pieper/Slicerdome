// Query embeddings in the browser or Node, matching the index's model.
//
// The index is built with fastembed's sentence-transformers/all-MiniLM-L6-v2
// (mean pooling, L2-normalized). Xenova/all-MiniLM-L6-v2 is the ONNX export of
// the same weights for transformers.js; "fp32" reproduces the index's vectors,
// "q8" is a ~4x smaller download with slightly perturbed query vectors.

const MODEL_MAP = {
  "sentence-transformers/all-MiniLM-L6-v2": "Xenova/all-MiniLM-L6-v2",
};

/**
 * An embedder backed by transformers.js. `importer` loads the library; the
 * default works in Node (npm package). In a browser pass, for example:
 *   () => import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1")
 */
export function transformersEmbedder({ model = "sentence-transformers/all-MiniLM-L6-v2", dtype = "fp32", importer, device } = {}) {
  const hfModel = MODEL_MAP[model] || model;
  let extractor = null;
  return {
    model,
    async embed(text) {
      if (!extractor) {
        extractor = (async () => {
          const lib = importer ? await importer() : await import("@huggingface/transformers");
          const opts = { dtype };
          if (device) opts.device = device;
          return lib.pipeline("feature-extraction", hfModel, opts);
        })();
        extractor.catch(() => { extractor = null; });
      }
      const fe = await extractor;
      const out = await fe(text, { pooling: "mean", normalize: true });
      return Float32Array.from(out.data);
    },
  };
}
