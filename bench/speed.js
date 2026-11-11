// Speed of a local model on this machine: load time, prefill and decode rates at agent-sized
// prompts, and whether a follow-up turn reuses the KV cache (it should only prefill the new part).
import { createEngine, modelRecord } from "../src/local-llm.js";

const params = new URLSearchParams(location.search);
const model = params.get("model") || "Qwen3.5-4B-q4f16_1-MLC";
const sizes = (params.get("sizes") || "1000,4000,8000").split(",").map(Number);
const out = document.getElementById("out");
const B = (window.__bench = { model, status: "loading", results: [] });
const show = () => (out.textContent = JSON.stringify(B, null, 1));

// Filler that looks like what an agent reads: code and forum-like prose from this repo.
const sources = ["corpus.js", "store.js", "bundle.js", "segment.js", "text.js", "codec.js", "mcp-tools.js"].map((f) => `../static-index/src/${f}`);
let filler = "";
for (const s of sources) {
  const r = await fetch(new URL(`../${s}`, import.meta.url));
  if (!r.ok) throw new Error(`could not load ${s}: ${r.status}`);
  filler += `\n\n# ${s}\n${await r.text()}`;
}
const fillerOf = (tokens) => filler.slice(0, Math.round(tokens * 3.3));

function stats(r) {
  const u = r.usage || {};
  const x = u.extra || {};
  return {
    prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, finish: r.choices?.[0]?.finish_reason,
    ttft_s: +(x.time_to_first_token_s ?? 0).toFixed(2), prefill_tok_s: Math.round(x.prefill_tokens_per_s ?? 0),
    decode_tok_s: +(x.decode_tokens_per_s ?? 0).toFixed(1), e2e_s: +(x.e2e_latency_s ?? 0).toFixed(2),
  };
}

try {
  const adapter = await navigator.gpu.requestAdapter();
  B.gpu = adapter?.info?.architecture;
  B.record = await modelRecord(model).then((m) => m && { vram_required_MB: m.vram_required_MB, low_resource: m.low_resource_required });
  const t0 = performance.now();
  const engine = await createEngine(model, { contextWindow: 16384, onProgress: (p) => { B.progress = p.text; show(); } });
  B.load_s = +((performance.now() - t0) / 1000).toFixed(1);
  B.status = "running";
  show();
  const chat = (messages, extra = {}) => engine.chat.completions.create({
    messages, temperature: 0, max_tokens: 64, extra_body: { enable_thinking: false }, ...extra,
  });
  await chat([{ role: "user", content: "Say hi." }], { max_tokens: 8 }); // warm up the shaders

  for (const n of sizes) {
    await engine.resetChat();
    const r = await chat([{ role: "system", content: "You are a helpful assistant." },
      { role: "user", content: `${fillerOf(n)}\n\nSummarize the text above in one sentence.` }]);
    B.results.push({ test: `prefill ~${n}`, ...stats(r) });
    show();
  }

  await engine.resetChat();
  const d = await chat([{ role: "user", content: "Write a long Python tutorial about numpy arrays." }], { max_tokens: 256, ignore_eos: true });
  B.results.push({ test: "decode 256", ...stats(d) });
  show();

  // Follow-up turn: same conversation plus a short message. With KV reuse only the new
  // message is prefilled, so the time to first token should be well under the first turn's.
  await engine.resetChat();
  const base = [{ role: "system", content: "You are a helpful assistant." },
    { role: "user", content: `${fillerOf(4000)}\n\nWhich functions in the code above fetch byte ranges?` }];
  const first = await chat(base, { max_tokens: 400 });
  const reply = first.choices[0].message.content;
  B.turn1_reply_start = JSON.stringify(reply.slice(0, 60));
  const second = await chat([...base, { role: "assistant", content: reply }, { role: "user", content: "Name one of them again." }], { max_tokens: 400 });
  B.results.push({ test: "turn 1 (~4000)", ...stats(first) }, { test: "turn 2 (reuse)", ...stats(second) });
  B.status = "done";
} catch (e) {
  B.status = "error";
  B.error = String(e?.stack || e);
}
show();
