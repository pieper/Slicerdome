// A model running in this browser over WebGPU, through WebLLM (https://github.com/mlc-ai/web-llm).
// Weights download from Hugging Face on first use and stay in the browser's Cache Storage.

export const WEBLLM_URL = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.87/+esm";

/**
 * Models offered in the page, best first. `ctx` is the context window the engine is created
 * with. See README.md for how they did on the evaluation tasks: the 9B is the only one that
 * handles more than one-step requests; it needs about 6.5 GB of GPU memory (16 GB machines).
 */
export const LOCAL_MODELS = [
  { id: "Qwen3.5-9B-q4f16_1-MLC", label: "Qwen3.5 9B (best; 16 GB memory, 5.0 GB download)", ctx: 16384, downloadGB: 5.04 },
  { id: "Qwen3.5-4B-q4f16_1-MLC", label: "Qwen3.5 4B (simple requests only; 2.4 GB)", ctx: 16384, downloadGB: 2.37 },
  { id: "Qwen3.5-2B-q4f16_1-MLC", label: "Qwen3.5 2B (small machines; very limited; 1.1 GB)", ctx: 16384, downloadGB: 1.06 },
];

/** How much more this page may store in the browser, in GB (null if the browser does not say). */
export async function storageRoomGB() {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return (quota - usage) / 1e9;
  } catch {
    return null;
  }
}

/** Whether any of the model's weights are already in the browser's cache. */
async function partlyCached(modelId) {
  try {
    const keys = await (await caches.open("webllm/model")).keys();
    return keys.some((r) => r.url.includes(modelId));
  } catch {
    return false;
  }
}

/**
 * The browser keeps the weights in Cache Storage, and lets a page use only part of the free disk
 * space. Fail early with a plain explanation instead of after a partial download.
 */
export async function checkRoom(model) {
  if (!model?.downloadGB || (await partlyCached(model.id))) return;
  const room = await storageRoomGB();
  if (room != null && room < model.downloadGB) {
    throw new Error(
      `${model.label.split(" (")[0]} needs ${model.downloadGB.toFixed(1)} GB of browser storage, but the browser lets this ` +
        `page store only ${room.toFixed(1)} GB more. Free some disk space and reload, or pick a smaller model.`,
    );
  }
}

async function explainStorageError(e, model) {
  const msg = String(e?.message ?? e);
  if (!/quota/i.test(msg)) return e;
  const room = await storageRoomGB();
  return new Error(
    `The browser stopped storing the model's weights (${msg}). ` +
      (room != null ? `It now lets this page store ${room.toFixed(1)} GB more` : "It is out of room for this page") +
      (model?.downloadGB ? `; the model needs ${model.downloadGB.toFixed(1)} GB in all. ` : ". ") +
      "The browser only uses part of the disk's free space, so this happens when the disk is nearly full. " +
      "Free some disk space, reload the page and press Load model again: the parts already downloaded are kept.",
  );
}

let webllm;
export async function loadWebLLM() {
  webllm ??= await import(WEBLLM_URL);
  return webllm;
}

export function hasWebGPU() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

/**
 * Create an engine for `modelId` in a Web Worker. `onProgress({progress, text})` reports the
 * download and shader compilation.
 */
export async function createEngine(modelId, { contextWindow, onProgress } = {}) {
  const w = await loadWebLLM();
  const known = LOCAL_MODELS.find((m) => m.id === modelId);
  await checkRoom(known);
  const worker = new Worker(new URL("./llm-worker.js", import.meta.url), { type: "module" });
  try {
    const engine = await w.CreateWebWorkerMLCEngine(
      worker,
      modelId,
      { initProgressCallback: onProgress, appConfig: w.prebuiltAppConfig },
      { context_window_size: contextWindow ?? known?.ctx ?? 8192 },
    );
    engine.worker = worker;
    return engine;
  } catch (e) {
    worker.terminate();
    throw await explainStorageError(e, known);
  }
}

/** What the prebuilt config says the model needs, in MB of GPU memory at its default context. */
export async function modelRecord(modelId) {
  const w = await loadWebLLM();
  return w.prebuiltAppConfig.model_list.find((m) => m.model_id === modelId);
}
