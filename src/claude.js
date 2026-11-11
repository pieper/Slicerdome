// Claude through Anthropic's Messages API, called from this page with the user's own API key
// (Anthropic allows direct browser calls when the client opts in with dangerouslyAllowBrowser).
//
// Same interface as the providers in providers.js:
//   provider.complete({messages, tools, instructions, onDelta, signal})
//     -> {text, thinking, calls:[{id, name, args, invalid?}], problems, raw, finish, usage, cost, timings}
// `raw` is the reply's content blocks (thinking with its signature, text, tool_use). They are
// sent back unchanged on the next step: Claude needs its earlier thinking intact, and an
// unchanged prefix is what makes prompt caching work.

export const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";

/** Prices in US$ per million tokens (cache write = 5-minute cache, 1.25 x input). */
export const CLAUDE_MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", price: { in: 2, out: 10, read: 0.2, write: 2.5 } },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (cheapest)", price: { in: 0.1, out: 0.5, read: 0.01, write: 0.125, longAbove: 100_000, longFactor: 5 } },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable)", price: { in: 4, out: 20, read: 0.2, write: 5 } },
];

/** What a reply cost, from its usage, in US$ (an estimate from list prices). */
export function costOf(model, u) {
  const p = CLAUDE_MODELS.find((m) => m.id === model)?.price;
  if (!p || !u) return null;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const input = u.input_tokens ?? 0;
  const f = p.longAbove && input + read + write > p.longAbove ? p.longFactor : 1;
  return (f * (input * p.in + write * p.write + read * p.read + (u.output_tokens ?? 0) * p.out)) / 1e6;
}

/** Check tool input against the tool's JSON Schema (types, enums, required); returns a problem or null. */
export function checkArgs(tool, input) {
  if (!tool) return null; // the agent answers unknown tools itself
  if (!input || typeof input !== "object" || Array.isArray(input)) return "The arguments are not a JSON object.";
  const schema = tool.parameters ?? {};
  for (const k of schema.required ?? []) if (input[k] === undefined) return `The required argument "${k}" is missing.`;
  for (const [k, v] of Object.entries(input)) {
    const p = schema.properties?.[k];
    if (!p) continue;
    const ok = { string: typeof v === "string", integer: Number.isInteger(v), number: typeof v === "number", boolean: typeof v === "boolean", array: Array.isArray(v) }[p.type] ?? true;
    if (!ok) return `The argument "${k}" should be of type ${p.type}.`;
    if (p.enum && !p.enum.includes(v)) return `The argument "${k}" must be one of: ${p.enum.join(", ")}.`;
  }
  return null;
}

/**
 * The agent's transcript as Messages API turns. Every tool_use gets a tool_result in the next
 * user turn (a call that never ran, because the user pressed Stop, gets an error result), tool
 * results come first in that turn, and consecutive user content is merged into one turn.
 */
export function toRequestMessages(messages) {
  const out = [];
  const pending = new Set();
  const pushUser = (blocks) => {
    const last = out[out.length - 1];
    if (last?.role === "user") last.content.push(...blocks);
    else out.push({ role: "user", content: blocks });
  };
  const closePending = () => {
    if (!pending.size) return;
    pushUser([...pending].map((id) => ({ type: "tool_result", tool_use_id: id, is_error: true, content: "Not run: the user stopped the request before this call ran." })));
    pending.clear();
  };
  for (const m of messages) {
    if (m.role === "tool") {
      pending.delete(m.callId);
      pushUser([{ type: "tool_result", tool_use_id: m.callId, content: m.content, ...(m.content.startsWith("[error]") ? { is_error: true } : {}) }]);
      continue;
    }
    closePending();
    if (m.role === "user") pushUser([{ type: "text", text: m.content }]);
    else if (m.role === "assistant") {
      const blocks = Array.isArray(m.raw) ? m.raw : m.content ? [{ type: "text", text: m.content }] : [];
      if (!blocks.length) continue;
      out.push({ role: "assistant", content: blocks });
      for (const b of blocks) if (b.type === "tool_use") pending.add(b.id);
    }
  }
  closePending();
  return out;
}

export class ClaudeProvider {
  /** conf: the page's settings object for Claude, {apiKey, effort, baseUrl?}; read at each call. */
  constructor(model, conf) {
    this.model = model;
    this.conf = conf;
    this.label = CLAUDE_MODELS.find((m) => m.id === model)?.label.replace(/ \(.*\)$/, "") ?? model;
    this.local = false;
    this.spent = 0; // US$ in this page session
    this.notice = "Your messages, the code the model writes and the tool results (search hits, Python output) go to Anthropic (api.anthropic.com), billed to your API key.";
  }

  async client() {
    if (!this.conf.apiKey) throw new Error("Add your Anthropic API key in Settings (the Claude section) first.");
    const key = `${this.conf.apiKey}|${this.conf.baseUrl ?? ""}`;
    if (this._client && this._key === key) return this._client;
    const { default: Anthropic } = await import(SDK_URL);
    this.Anthropic = Anthropic;
    this._client = new Anthropic({ apiKey: this.conf.apiKey, dangerouslyAllowBrowser: true, ...(this.conf.baseUrl ? { baseURL: this.conf.baseUrl } : {}) });
    this._key = key;
    return this._client;
  }

  /** Check the key by listing models; returns the ids it can use. */
  async testKey() {
    const client = await this.client();
    const ids = [];
    try {
      for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
    } catch (e) {
      throw this.explain(e);
    }
    return ids;
  }

  explain(e) {
    const A = this.Anthropic;
    if (!A || !(e instanceof A.APIError)) return e;
    if (e instanceof A.AuthenticationError) return new Error("Anthropic did not accept the API key. Check it in Settings.");
    if (e instanceof A.PermissionDeniedError) return new Error(`This API key may not use ${this.model}: ${e.message}`);
    if (e instanceof A.RateLimitError) return new Error(`Anthropic's rate limit for this key was reached; wait a minute and try again. (${e.message})`);
    return new Error(`Claude API error${e.status ? ` ${e.status}` : ""}: ${e.message}`);
  }

  async complete({ messages, tools, instructions, onDelta, signal }) {
    const client = await this.client();
    const body = {
      model: this.model,
      max_tokens: 16000,
      // The instructions and tools never change within a chat: one cache breakpoint after them,
      // plus automatic caching of the growing conversation.
      system: [{ type: "text", text: instructions, cache_control: { type: "ephemeral" } }],
      cache_control: { type: "ephemeral" },
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, eager_input_streaming: true })),
      thinking: { type: "adaptive", display: "summarized" },
      messages: toRequestMessages(messages),
    };
    if (this.conf.effort) body.output_config = { effort: this.conf.effort };

    const t0 = performance.now();
    let firstToken = null;
    let message;
    let thinking = "";
    for (let attempt = 0; ; attempt++) {
      let text = "";
      thinking = "";
      try {
        const stream = client.messages.stream(body, { signal });
        for await (const ev of stream) {
          if (ev.type !== "content_block_delta") continue;
          firstToken ??= performance.now();
          if (ev.delta.type === "text_delta") text += ev.delta.text;
          else if (ev.delta.type === "thinking_delta") thinking += ev.delta.thinking;
          else continue;
          onDelta?.(text, thinking);
        }
        message = await stream.finalMessage();
        break;
      } catch (e) {
        // With eager input streaming a tool input that is not valid JSON at all fails here;
        // ask again (at most twice). API errors and Stop are passed on.
        if (signal?.aborted || e instanceof this.Anthropic.APIError || attempt >= 2) throw this.explain(e);
        console.warn("Claude: tool input could not be parsed, asking again", e);
      }
    }

    const blocks = message.content;
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    thinking = blocks.filter((b) => b.type === "thinking").map((b) => b.thinking).join("\n").trim() || thinking;
    let calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
    if (message.stop_reason === "refusal") {
      calls = []; // never run the tools of a refused turn
    } else if (message.stop_reason === "max_tokens") {
      for (const c of calls) c.invalid = "This call was cut off at the reply length limit and was not run. Write it again, shorter.";
    } else {
      for (const c of calls) {
        const problem = checkArgs(tools.find((t) => t.name === c.name), c.args);
        if (problem) c.invalid = `${problem} It was not run. Received: ${JSON.stringify({ INVALID_JSON: JSON.stringify(c.args) })}`;
      }
    }
    const cost = costOf(this.model, message.usage);
    if (cost) this.spent += cost;
    return {
      text: text || (message.stop_reason === "refusal" ? "Claude declined to continue with this request." : ""),
      thinking,
      calls,
      problems: [],
      raw: blocks,
      finish: message.stop_reason,
      usage: message.usage,
      cost,
      timings: { seconds: (performance.now() - t0) / 1000, ttft: firstToken ? (firstToken - t0) / 1000 : null },
    };
  }
}
