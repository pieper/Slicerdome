// The chat page: wires the providers, the tools, the agent loop and SlicerWeb together.
//
// URL parameters: index=<static index URL> (default ./bundle), slicerweb=<SlicerWeb URL on this
// origin> (default ./slicerweb/), provider=local:<model id> | remote:<preset id> | claude:<model id>.

import { Agent, INSTRUCTIONS } from "./agent.js";
import { CLAUDE_MODELS, ClaudeProvider } from "./claude.js";
import { hasWebGPU, LOCAL_MODELS } from "./local-llm.js";
import { HELP } from "./help.js";
import { openModelPicker } from "./models.js";
import { finishOpenRouterSignIn, listModels, LocalProvider, openRouterSignIn, RemoteProvider, REMOTE_PRESETS } from "./providers.js";
import { SlicerBridge } from "./slicer.js";
import { makeRetriever, makeTools } from "./tools.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const INDEX_URL = new URL(params.get("index") || "./bundle", location.href).href;
const SLICERWEB_URL = params.get("slicerweb") || "./slicerweb/?layout=FourUp";
const STORE = "slicerChat.settings";

// ---------------------------------------------------------------------------------------------
// Settings (localStorage, per browser)

function loadSettings() {
  let s = {};
  try {
    s = JSON.parse(localStorage.getItem(STORE) || "{}");
  } catch {}
  s.remote ??= {};
  for (const [id, p] of Object.entries(REMOTE_PRESETS)) {
    const saved = s.remote[id] ?? {};
    s.remote[id] = { apiKey: "", authHeader: p.authHeader ?? "bearer", ...saved, baseUrl: saved.baseUrl || p.baseUrl, model: saved.model || p.model };
  }
  s.claude = { apiKey: "", effort: "", ...s.claude };
  s.costLimit ??= 0.5; // US$ per request, for providers that report cost (Claude)
  s.thinking ??= false;
  s.assist ??= "local"; // automatic example retrieval and loop breaking: "local" models, "all" or "none"
  s.maxSteps ??= 12;
  s.provider ??= s.claude.apiKey ? `claude:${CLAUDE_MODELS[0].id}` : `local:${LOCAL_MODELS[0].id}`;
  return s;
}
function saveSettings() {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch {}
}
const settings = loadSettings();

// ---------------------------------------------------------------------------------------------
// Status line, rendering

const setStatus = (text) => ($("status").textContent = text);

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** Enough Markdown for model answers: fenced code, inline code, bold, paragraphs. */
function renderMarkdown(text) {
  const parts = text.split(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)(?:```|$)/);
  let html = "";
  parts.forEach((part, i) => {
    if (i % 2) {
      html += `<pre><code>${escapeHtml(part.replace(/\n$/, ""))}</code></pre>`;
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      let h = escapeHtml(para.trim());
      h = h.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
      html += `<p>${h}</p>`;
    }
  });
  return html;
}

function addEl(cls, html) {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.innerHTML = html;
  $("log").append(el);
  $("log").scrollTop = $("log").scrollHeight;
  return el;
}

function toolHtml(call, result, seconds) {
  const ok = !/^\[error\]|^There is no tool|^This exact call failed/.test(result);
  const args = call.name === "run_python"
    ? `<pre><code>${escapeHtml(call.args.code ?? "")}</code></pre>`
    : `<pre><code>${escapeHtml(JSON.stringify(call.args, null, 1))}</code></pre>`;
  const brief = call.name === "run_python" ? "" : ` <code>${escapeHtml(String(call.args.query ?? call.args.path ?? "").slice(0, 60))}</code>`;
  return `<details class="tool"><summary><span class="${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"}</span> ${call.name}${brief} · ${seconds.toFixed(1)} s</summary>
    <div class="label">arguments</div>${args}<div class="label">result</div><pre><code>${escapeHtml(result)}</code></pre></details>`;
}

// ---------------------------------------------------------------------------------------------
// Providers

const providers = new Map(); // value -> provider (local engines are kept loaded)

function providerOptions() {
  const sel = $("provider");
  sel.innerHTML = "";
  const claude = document.createElement("optgroup");
  claude.label = "Claude (your Anthropic API key)";
  for (const m of CLAUDE_MODELS) claude.append(new Option(settings.claude.apiKey ? m.label : `${m.label} (add key in Settings)`, `claude:${m.id}`));
  sel.append(claude);
  const local = document.createElement("optgroup");
  local.label = hasWebGPU() ? "In this browser (private)" : "In this browser (needs WebGPU)";
  for (const m of LOCAL_MODELS) local.append(new Option(m.label, `local:${m.id}`));
  sel.append(local);
  const remote = document.createElement("optgroup");
  remote.label = "Remote (sends your messages)";
  for (const [id, p] of Object.entries(REMOTE_PRESETS)) {
    const cfg = settings.remote[id];
    const ready = cfg.baseUrl && cfg.model && !/YOUR-RESOURCE/.test(cfg.baseUrl);
    const opt = new Option(ready ? `${p.label}: ${cfg.model}` : `${p.label} (set up in Settings)`, `remote:${id}`);
    remote.append(opt);
  }
  sel.append(remote);
  sel.value = settings.provider;
  if (!sel.value) sel.value = `local:${LOCAL_MODELS[0].id}`;
}

function currentProvider() {
  const value = $("provider").value;
  if (!providers.has(value)) {
    const [kind, id] = value.split(/:(.*)/s);
    if (kind === "local") providers.set(value, new LocalProvider(id));
    else if (kind === "claude") providers.set(value, new ClaudeProvider(id, settings.claude));
    else providers.set(value, new RemoteProvider({ id, label: REMOTE_PRESETS[id].label, ...settings.remote[id] }));
  }
  return providers.get(value);
}

function updateProviderUi() {
  const p = currentProvider();
  $("load").style.display = p.local ? "" : "none";
  $("load").disabled = !!p.engine;
  const notice = $("notice");
  if (p.local) {
    notice.style.display = "none";
  } else {
    notice.style.display = "block";
    notice.textContent = p.notice ?? `Your messages, the code the model writes and the tool results (search hits, Python output) go to ${REMOTE_PRESETS[p.cfg.id].label} (${p.cfg.baseUrl}).`;
  }
  const spent = p.spent ? ` · about $${p.spent.toFixed(p.spent < 0.1 ? 4 : 2)} spent in this page` : "";
  setStatus(p.local ? (p.engine ? `${p.label} ready` : `${p.label}: not loaded yet`) : `${p.label}${spent}`);
}

let loading = null;
async function ensureLoaded(p) {
  if (!p.local || p.engine) return;
  if (!hasWebGPU()) throw new Error("This browser has no WebGPU, so local models cannot run. Use Chrome, Edge or Safari 26, or pick a remote provider.");
  for (const [value, other] of providers) {
    if (other !== p && other.local && other.engine) {
      setStatus(`Unloading ${other.label}…`);
      await other.unload();
    }
  }
  $("load").disabled = true;
  loading ??= p.load((r) => setStatus(`${p.label}: ${r.text}`)).finally(() => (loading = null));
  await loading;
  updateProviderUi();
}

// ---------------------------------------------------------------------------------------------
// Search index, SlicerWeb, tools

const slicer = new SlicerBridge($("slicer"));
$("slicer").src = SLICERWEB_URL;
$("slicer").addEventListener("load", () => slicer.reset());

let bundle = null;
const bundleReady = (async () => {
  try {
    const { Bundle, transformersEmbedder } = await import("../static-index/src/index.js");
    bundle = await Bundle.open(INDEX_URL, {
      embedder: transformersEmbedder({
        dtype: "q8",
        importer: () => import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1"),
      }),
    });
  } catch (e) {
    console.warn("search index unavailable", e);
    addEl("error", `The search index at ${escapeHtml(INDEX_URL)} could not be opened (${escapeHtml(String(e.message ?? e))}); the model can still run Python.`);
  }
})();

// ---------------------------------------------------------------------------------------------
// The conversation

let agent = null;
let running = null; // {controller, promise}

function newAgent() {
  const provider = currentProvider();
  agent = new Agent({
    provider,
    tools: makeTools({ bundle, slicer, maxChars: provider.local ? 2000 : 3500 }),
    instructions: INSTRUCTIONS,
    maxSteps: settings.maxSteps,
    thinking: settings.thinking,
    retrieve: makeRetriever(bundle),
    scene: () => slicer.sceneSummary(),
    assist: settings.assist === "all" || (settings.assist === "local" && provider.local),
    costLimit: settings.costLimit || null,
    onEvent,
  });
}

// ---------------------------------------------------------------------------------------------
// Spending: per request, per chat and for this browser tab (kept across reloads of the tab)

const SPEND_KEY = "slicerChat.spend";
const spend = (() => {
  try {
    const s = JSON.parse(sessionStorage.getItem(SPEND_KEY) || "null");
    if (s && typeof s.session === "number") return { ...s, request: 0, requestUnknown: false };
  } catch {}
  return { session: 0, chat: 0, byModel: {}, unknown: false, request: 0, requestUnknown: false };
})();
const money = (x) => `$${x < 1 ? x.toFixed(4) : x.toFixed(2)}`;

function showSpend() {
  const el = $("spend");
  el.textContent = `${money(spend.session)} this session${spend.unknown ? "+" : ""}`;
  const lines = Object.entries(spend.byModel).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m}: ${money(c)}`);
  el.title = [`This chat: ${money(spend.chat)}`, ...lines,
    "Since this tab was opened. Claude costs are estimated from list prices; OpenRouter reports what it charged.",
    ...(spend.unknown ? ["+ some replies came from a provider that does not report cost."] : [])].join("\n");
  try {
    sessionStorage.setItem(SPEND_KEY, JSON.stringify({ session: spend.session, chat: spend.chat, byModel: spend.byModel, unknown: spend.unknown }));
  } catch {}
}

function addSpend(reply, provider) {
  if (reply.cost == null) {
    if (!provider.local) spend.unknown = spend.requestUnknown = true;
    return;
  }
  spend.request += reply.cost;
  spend.chat += reply.cost;
  spend.session += reply.cost;
  spend.byModel[provider.label] = (spend.byModel[provider.label] ?? 0) + reply.cost;
  showSpend();
}

let live = null; // the element showing the reply being generated
const LOG_EVENTS = params.has("log"); // ?log=1: every agent event to the console (bench/eval.mjs reads it)
function onEvent(ev) {
  if (LOG_EVENTS && ev.type !== "delta") console.log(`[slicerChat] ${JSON.stringify(ev).slice(0, 2000)}`);
  if (ev.type === "delta") {
    live ??= addEl("assistant", "");
    const t = ev.text ?? "";
    const stillThinking = /<think>/.test(t) && !/<\/think>/.test(t);
    const visible = stillThinking ? "" : t.replace(/^\s*(<think>)?[\s\S]*?<\/think>\s*/, "").replace(/<tool_call>[\s\S]*$/, "");
    const thought = ev.thinking ? `<div class="meta">thinking: ${escapeHtml(ev.thinking.slice(-300))}</div>` : "";
    live.innerHTML = renderMarkdown(visible) || thought || `<span class="meta">${t.includes("<tool_call>") ? "calling a tool…" : "thinking…"}</span>`;
    $("log").scrollTop = $("log").scrollHeight;
    return;
  }
  if (ev.type === "model") {
    const r = ev.reply;
    if (agent) addSpend(r, agent.provider);
    live ??= addEl("assistant", "");
    let html = "";
    if (r.thinking) html += `<details class="think"><summary>thoughts</summary><pre>${escapeHtml(r.thinking)}</pre></details>`;
    if (r.text) html += renderMarkdown(r.text);
    const t = r.timings ?? {};
    const bits = [`step ${ev.step}`, t.seconds != null && `${t.seconds.toFixed(1)} s`];
    const u = r.usage;
    if (u?.input_tokens != null) {
      // Claude: input = uncached + written to cache + read from cache
      const cached = u.cache_read_input_tokens ?? 0;
      bits.push(`${u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0)} in (${cached} cached) / ${u.output_tokens} out`);
    } else if (u) bits.push(`${u.prompt_tokens} in / ${u.completion_tokens} out`);
    if (r.cost != null) bits.push(`$${r.cost.toFixed(4)}`);
    if (t.decode_tok_s) bits.push(`${Math.round(t.decode_tok_s)} tok/s`);
    html += `<div class="meta">${bits.filter(Boolean).join(" · ")}</div>`;
    live.innerHTML = html;
    if (!r.text && !r.thinking) live.innerHTML = `<div class="meta">${bits.filter(Boolean).join(" · ")}</div>`;
    live = null;
    return;
  }
  if (ev.type === "tool") {
    addEl("tool-wrap", toolHtml(ev.call, ev.result, ev.seconds));
    return;
  }
  if (ev.type === "context") {
    addEl("tool-wrap", `<details class="tool"><summary>examples added for the model</summary><pre><code>${escapeHtml(ev.text)}</code></pre></details>`);
    return;
  }
  if (ev.type === "error") {
    live = null;
    addEl("error", escapeHtml(ev.message));
    return;
  }
  if (ev.type === "done" && ev.text && ev.stopped) addEl("error", escapeHtml(ev.text));
}

async function send(text) {
  text = (text ?? $("input").value).trim();
  if (!text || running) return null;
  $("input").value = "";
  const p = currentProvider();
  addEl("user", escapeHtml(text));
  const controller = new AbortController();
  $("send").disabled = true;
  $("stop").disabled = false;
  const promise = (async () => {
    try {
      await bundleReady;
      await ensureLoaded(p);
      setStatus("Waiting for Slicer…");
      await slicer.ready();
      if (!agent || agent.provider !== p) newAgent();
      agent.thinking = settings.thinking;
      agent.maxSteps = settings.maxSteps;
      agent.costLimit = settings.costLimit || null;
      setStatus(`${p.label} working…`);
      spend.request = 0;
      spend.requestUnknown = false;
      const t0 = performance.now();
      const steps0 = agent.log.filter((e) => e.type === "model").length;
      const result = await agent.send(text, { signal: controller.signal });
      const steps = agent.log.filter((e) => e.type === "model").length - steps0;
      if (!p.local) {
        const cost = spend.requestUnknown && !spend.request ? "cost not reported by this provider" : `${money(spend.request)}${spend.requestUnknown ? "+" : ""}`;
        addEl("assistant", `<div class="meta request-total">This request: ${cost}, ${steps} step${steps === 1 ? "" : "s"}, ${((performance.now() - t0) / 1000).toFixed(0)} s · this chat ${money(spend.chat)} · this session ${money(spend.session)}</div>`);
      }
      return result;
    } catch (e) {
      addEl("error", escapeHtml(String(e.message ?? e)));
      return { text: "", stopped: true, error: String(e.message ?? e) };
    } finally {
      running = null;
      live = null;
      $("send").disabled = false;
      $("stop").disabled = true;
      updateProviderUi();
    }
  })();
  running = { controller, promise };
  return promise;
}

function newChat() {
  running?.controller.abort();
  agent = null;
  spend.chat = 0;
  showSpend();
  $("log").innerHTML = "";
}

// ---------------------------------------------------------------------------------------------
// Settings dialog

function buildRemoteFields() {
  const box = $("remoteFields");
  box.innerHTML = "";
  for (const [id, p] of Object.entries(REMOTE_PRESETS)) {
    const cfg = settings.remote[id];
    const fs = document.createElement("fieldset");
    fs.innerHTML = `<legend>${escapeHtml(p.label)} <button type="button" class="help-btn" data-help="${id}" title="How to get a key">?</button></legend><div class="help-panel" data-help-panel="${id}" hidden></div><div class="help">${escapeHtml(p.keyHelp)}</div>
      <label><span>Base URL</span><input type="url" data-k="baseUrl" value="${escapeHtml(cfg.baseUrl)}"></label>
      <label><span>API key</span><input type="password" data-k="apiKey" value="${escapeHtml(cfg.apiKey)}" autocomplete="off"></label>
      <label><span>Model</span><input type="text" data-k="model" list="models-${id}" value="${escapeHtml(cfg.model)}"><datalist id="models-${id}"></datalist></label>
      <label><span>Key header</span><select data-k="authHeader"><option value="bearer">Authorization: Bearer</option><option value="api-key">api-key</option></select></label>
      <div class="buttons">${id === "openrouter" ? '<button type="button" data-signin>Sign in with OpenRouter</button>' : ""}<button type="button" data-list>Fetch model list</button></div>`;
    fs.dataset.id = id;
    fs.querySelector("[data-k=authHeader]").value = cfg.authHeader;
    fs.querySelector("[data-list]").onclick = async (ev) => {
      ev.target.textContent = "Fetching…";
      try {
        const ids = await listModels(readFieldset(fs));
        fs.querySelector("datalist").innerHTML = ids.map((m) => `<option value="${escapeHtml(m)}">`).join("");
        ev.target.textContent = `${ids.length} models`;
      } catch (e) {
        ev.target.textContent = `Failed (${e.message})`;
      }
    };
    const signin = fs.querySelector("[data-signin]");
    if (signin) signin.onclick = () => openRouterSignIn();
    box.append(fs);
  }
}

function readFieldset(fs) {
  const out = {};
  for (const el of fs.querySelectorAll("[data-k]")) out[el.dataset.k] = el.value.trim();
  return out;
}

$("claudeTest").onclick = async () => {
  const out = $("claudeTestResult");
  out.textContent = "Checking…";
  try {
    const p = new ClaudeProvider(CLAUDE_MODELS[0].id, { ...settings.claude, apiKey: $("claudeKey").value.trim() });
    const ids = await p.testKey();
    const ours = CLAUDE_MODELS.filter((m) => ids.includes(m.id)).map((m) => m.label.replace(/ \(.*\)$/, ""));
    out.textContent = `The key works. ${ours.length ? `Models: ${ours.join(", ")}.` : `None of this page's models are listed for it (${ids.length} others are).`}`;
  } catch (e) {
    out.textContent = String(e.message ?? e);
  }
};

$("settings").onclick = () => {
  $("claudeKey").value = settings.claude.apiKey;
  $("claudeEffort").value = settings.claude.effort;
  $("costLimit").value = settings.costLimit;
  $("claudeTestResult").textContent = "";
  $("thinking").checked = settings.thinking;
  $("maxSteps").value = settings.maxSteps;
  $("assist").value = settings.assist;
  buildRemoteFields();
  for (const panel of $("settingsForm").querySelectorAll("[data-help-panel]")) panel.hidden = true;
  $("settingsDialog").showModal();
};
// The ? on each section: instructions for getting that provider's key (src/help.js).
$("settingsForm").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".help-btn");
  if (!btn) return;
  const panel = btn.closest("fieldset").querySelector(`[data-help-panel="${btn.dataset.help}"]`);
  if (!panel.innerHTML) panel.innerHTML = HELP[btn.dataset.help] ?? "<p>No instructions yet.</p>";
  panel.hidden = !panel.hidden;
  btn.classList.toggle("on", !panel.hidden);
});
$("settingsDialog").addEventListener("close", () => {
  if ($("settingsDialog").returnValue !== "save") return;
  const hadKey = !!settings.claude.apiKey;
  // Mutate in place: Claude providers hold a reference to this object.
  Object.assign(settings.claude, { apiKey: $("claudeKey").value.trim(), effort: $("claudeEffort").value });
  settings.costLimit = Math.max(0, Number($("costLimit").value) || 0);
  if (!hadKey && settings.claude.apiKey && !settings.provider.startsWith("claude:")) settings.provider = `claude:${CLAUDE_MODELS[0].id}`;
  settings.thinking = $("thinking").checked;
  settings.maxSteps = Math.max(1, Math.min(40, Number($("maxSteps").value) || 12));
  settings.assist = $("assist").value;
  for (const fs of $("remoteFields").querySelectorAll("fieldset")) settings.remote[fs.dataset.id] = readFieldset(fs);
  saveSettings();
  // Remote providers are rebuilt with the new settings; Claude providers read them at each call.
  for (const [value, p] of providers) if (!p.local && !(p instanceof ClaudeProvider)) providers.delete(value);
  providerOptions(); // selects settings.provider
  agent = null;
  updateProviderUi();
});

// ---------------------------------------------------------------------------------------------
// Wiring

$("provider").onchange = () => {
  settings.provider = $("provider").value;
  saveSettings();
  if (running) running.controller.abort();
  agent = null; // a new model starts a fresh context; the chat log stays visible
  updateProviderUi();
};
$("models").onclick = () => openModelPicker({
  current: settings.provider === "remote:openrouter" ? settings.remote.openrouter.model : null,
  onPick: (id) => {
    // Like choosing in the menu: the new model starts a fresh context; the chat log stays.
    settings.remote.openrouter.model = id;
    settings.provider = "remote:openrouter";
    saveSettings();
    for (const [value, p] of providers) if (!p.local && !(p instanceof ClaudeProvider)) providers.delete(value);
    if (running) running.controller.abort();
    agent = null;
    providerOptions();
    updateProviderUi();
    if (!settings.remote.openrouter.apiKey) addEl("error", "Add your OpenRouter API key in Settings to use this model.");
  },
});
$("load").onclick = () => ensureLoaded(currentProvider()).catch((e) => addEl("error", escapeHtml(String(e.message ?? e))));
$("send").onclick = () => send();
$("stop").onclick = () => running?.controller.abort();
$("new").onclick = newChat;
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
$("download").onclick = () => {
  const data = agent ? agent.transcript() : { messages: [] };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  a.download = `slicer-chat-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

if (params.get("provider")) settings.provider = params.get("provider");
providerOptions();
updateProviderUi();
showSpend();
finishOpenRouterSignIn()
  .then((key) => {
    if (!key) return;
    settings.remote.openrouter.apiKey = key;
    settings.provider = "remote:openrouter";
    saveSettings();
    providerOptions();
    updateProviderUi();
    addEl("assistant", "<div class=\"meta\">Signed in to OpenRouter; the key is saved in this browser.</div>");
  })
  .catch((e) => addEl("error", escapeHtml(String(e.message ?? e))));

// For scripted evaluation (bench/eval.mjs) and the console.
window.slicerChat = {
  send, newChat, slicer,
  get agent() { return agent; },
  get bundle() { return bundle; },
  get provider() { return currentProvider(); },
  setProvider(value) {
    $("provider").value = value;
    $("provider").onchange();
    return $("provider").value === value;
  },
  ensureLoaded: () => ensureLoaded(currentProvider()),
  /** After changing settings.remote from a script: build the remote providers again from it. */
  resetRemote() {
    for (const [value, p] of providers) if (!p.local && !(p instanceof ClaudeProvider)) providers.delete(value);
  },
  settings,
  bundleReady,
};
