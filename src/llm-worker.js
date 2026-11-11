// Runs the WebLLM engine off the main thread, so the page and SlicerWeb stay responsive while
// the model computes. The page talks to it through CreateWebWorkerMLCEngine (local-llm.js).
import { WebWorkerMLCEngineHandler } from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.87/+esm";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
