// Model providers behind one interface:
//
//   provider.complete({messages, tools, instructions, onDelta, signal, thinking})
//     -> {text, thinking, calls:[{id, name, args}], problems:[], raw, usage, timings}
//
// `messages` is the provider-neutral transcript the agent keeps:
//   {role: "user", content}
//   {role: "assistant", content, calls:[{id, name, args}], raw}   raw = the local model's exact reply
//   {role: "tool", callId, name, content}

import { createEngine, LOCAL_MODELS } from "./local-llm.js";
import { parseReply, systemWithTools, toolResponses } from "./qwen-tools.js";

/** Cloud and self-hosted endpoints that speak the OpenAI chat completions API. */
export const REMOTE_PRESETS = {
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3.5-9b",
    keyHelp: "Create a key at openrouter.ai/settings/keys (set a credit limit on it), or use Sign in.",
  },
  jetstream2: {
    label: "Jetstream2 inference",
    baseUrl: "https://llm.jetstream-cloud.org/api",
    model: "qwen-3.8-27b",
    keyHelp: "Free with an ACCESS account: a key from llm.jetstream-cloud.org (your name → Settings → Account → API keys).",
  },
  azure: {
    label: "Azure AI Foundry",
    baseUrl: "https://YOUR-RESOURCE.services.ai.azure.com/openai/v1",
    model: "",
    authHeader: "api-key",
    keyHelp: "Endpoint and key from your Foundry project; the model is your deployment name.",
  },
  custom: {
    label: "Other OpenAI-compatible",
    baseUrl: "http://localhost:11434/v1",
    model: "",
    keyHelp: "For example Ollama, vLLM or LM Studio. Leave the key empty if none is needed.",
  },
};

let callCounter = 0;
const newCallId = () => `call_${Date.now().toString(36)}_${++callCounter}`;

// ---------------------------------------------------------------------------------------------
// A model in this browser (WebLLM + WebGPU)

export class LocalProvider {
  constructor(modelId) {
    this.modelId = modelId;
    this.label = LOCAL_MODELS.find((m) => m.id === modelId)?.label ?? modelId;
    this.local = true;
    this.engine = null;
  }

  async load(onProgress) {
    if (!this.engine) this.engine = await createEngine(this.modelId, { onProgress });
    return this.engine;
  }

  async unload() {
    if (this.engine) {
      await this.engine.unload().catch(() => {});
      this.engine.worker?.terminate();
      this.engine = null;
    }
  }

  /** The transcript as WebLLM chat messages; assistant turns are passed back exactly as generated, so WebLLM can reuse its KV cache. */
  toChat(messages, tools, instructions) {
    const out = [{ role: "system", content: systemWithTools(tools, instructions) }];
    let pending = [];
    const flush = () => {
      if (pending.length) out.push({ role: "user", content: toolResponses(pending) });
      pending = [];
    };
    for (const m of messages) {
      if (m.role === "tool") {
        pending.push(m.content);
        continue;
      }
      flush();
      if (m.role === "user") out.push({ role: "user", content: m.content });
      else if (m.role === "assistant") out.push({ role: "assistant", content: m.raw ?? m.content ?? "" });
    }
    flush();
    return out;
  }

  async complete({ messages, tools, instructions, onDelta, signal, thinking = false, temperature, maxTokens = 2048 }) {
    const engine = await this.load();
    const t0 = performance.now();
    const stream = await engine.chat.completions.create({
      messages: this.toChat(messages, tools, instructions),
      stream: true,
      stream_options: { include_usage: true },
      temperature: temperature ?? 0.2,
      top_p: 0.9,
      max_tokens: maxTokens,
      extra_body: { enable_thinking: thinking },
    });
    let raw = "";
    let usage = null;
    let finish = null;
    let firstToken = null;
    const onAbort = () => engine.interruptGenerate();
    signal?.addEventListener("abort", onAbort);
    try {
      for await (const chunk of stream) {
        const d = chunk.choices?.[0]?.delta?.content;
        if (d) {
          firstToken ??= performance.now();
          raw += d;
          onDelta?.(raw);
        }
        if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    const parsed = parseReply(raw, tools);
    return {
      ...parsed,
      calls: parsed.calls.map((c) => ({ id: newCallId(), ...c })),
      raw,
      finish,
      usage,
      timings: {
        seconds: (performance.now() - t0) / 1000,
        ttft: firstToken ? (firstToken - t0) / 1000 : null,
        prefill_tok_s: usage?.extra?.prefill_tokens_per_s,
        decode_tok_s: usage?.extra?.decode_tokens_per_s,
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Any OpenAI-compatible endpoint (OpenRouter, Jetstream2, Azure AI Foundry, Ollama, vLLM, …)

/** Chrome's Local Network Access: a request from an https page to this computer says so (other browsers ignore it). */
const loopback = (url) => (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url ?? "") ? { targetAddressSpace: "loopback" } : {});

export class RemoteProvider {
  /** cfg: {id, label, baseUrl, apiKey, model, authHeader, effort} */
  constructor(cfg) {
    this.cfg = cfg;
    this.label = `${cfg.label}: ${cfg.model}`;
    this.local = false;
    this.openRouter = /openrouter\.ai/.test(cfg.baseUrl ?? "");
  }

  toChat(messages, tools, instructions) {
    // On OpenRouter the instructions and the latest message carry cache breakpoints: providers
    // that cache only up to explicit breakpoints (Anthropic, Alibaba) then cache the instructions
    // and the conversation so far, as the Claude provider does; the others cache on their own.
    const system = this.openRouter ? [{ type: "text", text: instructions, cache_control: { type: "ephemeral" } }] : instructions;
    const out = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") out.push({ role: "user", content: m.content });
      else if (m.role === "assistant") {
        const msg = { role: "assistant", content: m.content || null };
        if (m.calls?.length) {
          msg.tool_calls = m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }));
        }
        // Reasoning models continue their reasoning after a tool result when it is sent back.
        if (this.openRouter && m.reasoningDetails?.length) msg.reasoning_details = m.reasoningDetails;
        else if (this.openRouter && m.thinking) msg.reasoning = m.thinking;
        out.push(msg);
      } else if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.callId, content: m.content });
    }
    const last = out[out.length - 1];
    if (this.openRouter && out.length > 1 && typeof last.content === "string" && last.content) {
      last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
    }
    return out;
  }

  headers() {
    const h = { "Content-Type": "application/json" };
    const { apiKey, authHeader, baseUrl } = this.cfg;
    if (apiKey) {
      if (authHeader === "api-key") h["api-key"] = apiKey;
      else h.Authorization = `Bearer ${apiKey}`;
    }
    if (/openrouter\.ai/.test(baseUrl)) h["X-Title"] = "Slicerdome";
    return h;
  }

  async complete({ messages, tools, instructions, onDelta, signal, temperature, maxTokens = 4096 }) {
    const { baseUrl, model } = this.cfg;
    if (!baseUrl || !model) throw new Error(`Set the base URL and model for ${this.cfg.label} in Settings.`);
    const body = {
      model,
      messages: this.toChat(messages, tools, instructions),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
    };
    if (this.openRouter) {
      // Each model's recommended sampling settings and reasoning effort apply unless set here, and
      // reasoning counts against max_tokens, so allow as much output as the Claude provider does.
      if (temperature != null) body.temperature = temperature;
      body.max_tokens = Math.max(maxTokens, 16000);
      if (this.cfg.effort) body.reasoning = { effort: this.cfg.effort };
      else if (/^anthropic\//.test(model)) body.reasoning = { enabled: true }; // as the Claude provider (adaptive thinking)
      if (/^anthropic\//.test(model)) body.cache_control = { type: "ephemeral" }; // also cache the growing conversation
    } else {
      body.temperature = temperature ?? 0.2;
    }
    const t0 = performance.now();
    const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, { ...loopback(baseUrl),
      method: "POST", headers: this.headers(), body: JSON.stringify(body), signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`${this.cfg.label} answered ${resp.status}: ${detail.slice(0, 500)}`);
    }
    let text = "";
    let thinking = "";
    let usage = null;
    let finish = null;
    let firstToken = null;
    let served = null; // OpenRouter: which provider ran the model
    const partial = []; // by index: {id, name, arguments}
    const details = []; // OpenRouter reasoning_details, merged by index
    const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(`${this.cfg.label}: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
        if (chunk.usage) usage = chunk.usage;
        if (chunk.provider) served = chunk.provider;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const d = choice.delta ?? {};
        const r = d.reasoning ?? d.reasoning_content;
        if (r) thinking += r;
        for (const rd of d.reasoning_details ?? []) {
          // Streamed pieces of one detail share its index: join their text, keep the latest of the rest.
          const i = rd.index ?? details.length;
          const cur = details[i];
          if (!cur) details[i] = { ...rd };
          else for (const [k, v] of Object.entries(rd)) cur[k] = ["text", "summary", "data"].includes(k) && typeof v === "string" ? (cur[k] ?? "") + v : v ?? cur[k];
        }
        if (d.content) {
          firstToken ??= performance.now();
          text += d.content;
        }
        for (const tc of d.tool_calls ?? []) {
          firstToken ??= performance.now();
          const p = (partial[tc.index ?? 0] ??= { id: "", name: "", arguments: "" });
          if (tc.id) p.id = tc.id;
          if (tc.function?.name) p.name += tc.function.name;
          if (tc.function?.arguments) p.arguments += tc.function.arguments;
        }
        onDelta?.(text, thinking);
      }
    }
    const calls = [];
    const problems = [];
    for (const p of partial.filter(Boolean)) {
      let args = {};
      try {
        args = p.arguments ? JSON.parse(p.arguments) : {};
      } catch {
        problems.push(`The arguments of ${p.name} are not valid JSON: ${p.arguments.slice(0, 200)}`);
        continue;
      }
      calls.push({ id: p.id || newCallId(), name: p.name, args });
    }
    return {
      text: text.trim(), thinking: thinking.trim(), calls, problems, raw: null, finish, usage, served,
      reasoningDetails: details.filter(Boolean),
      cost: typeof usage?.cost === "number" ? usage.cost : null, // OpenRouter reports what it charged, in US$
      timings: { seconds: (performance.now() - t0) / 1000, ttft: firstToken ? (firstToken - t0) / 1000 : null },
    };
  }
}

/** Fetch a provider's model list (OpenRouter and most OpenAI-compatible servers have /models). */
export async function listModels(cfg) {
  const h = new RemoteProvider(cfg).headers();
  delete h["Content-Type"];
  const r = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/models`, { headers: h, ...loopback(cfg.baseUrl) });
  if (!r.ok) throw new Error(`${r.status}`);
  const j = await r.json();
  return (j.data ?? []).map((m) => m.id).sort();
}

// ---------------------------------------------------------------------------------------------
// OpenRouter sign-in (OAuth PKCE): the user approves in OpenRouter's page and comes back with a
// code that this page exchanges for a key. No client secret is involved.

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function openRouterSignIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  sessionStorage.setItem("slicerChat.pkceVerifier", verifier);
  const callback = location.origin + location.pathname;
  location.href = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`;
}

/** If this page load is the return from openRouterSignIn, exchange the code for a key. */
export async function finishOpenRouterSignIn() {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const verifier = sessionStorage.getItem("slicerChat.pkceVerifier");
  if (!code || !verifier) return null;
  sessionStorage.removeItem("slicerChat.pkceVerifier");
  url.searchParams.delete("code");
  history.replaceState(null, "", url);
  const r = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  if (!r.ok) throw new Error(`OpenRouter sign-in failed: ${r.status} ${await r.text()}`);
  return (await r.json()).key;
}
