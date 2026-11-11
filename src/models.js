// The OpenRouter model picker: search OpenRouter's models by name and filter them by maker, open
// weights, use for coding, speed, price and benchmark scores, then pick one for the chat.
//
// Everything comes from OpenRouter's public model list (no key needed): prices, which models are
// most used overall and for programming, a ranking by throughput, and Artificial Analysis scores.
// Results of this page's own evaluation (bench/scores.json, optional) are shown where they exist.

import { groupLabel, openScoreDashboard, rate, summarize } from "./scores.js";

const API = "https://openrouter.ai/api/v1/models";
const SHOWN = 60; // rows drawn at once; the filters narrow the rest
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let catalog = null; // promise, fetched once per page load

async function getList(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OpenRouter answered ${r.status}`);
  return (await r.json()).data ?? [];
}

/** The models the agent can use (chat completions with tool calls), with what the picker shows. */
function loadCatalog(scoresUrl) {
  catalog ??= (async () => {
    const [popular, fastest, coding, scores] = await Promise.all([
      getList(`${API}?sort=most-popular`),
      getList(`${API}?sort=throughput-high-to-low`).catch(() => []),
      getList(`${API}?category=programming`).catch(() => []),
      fetch(scoresUrl).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    const speedRank = new Map(fastest.map((m, i) => [m.id, i]));
    const codingIds = new Set(coding.map((m) => m.id));
    const models = [];
    let hidden = 0;
    popular.forEach((m, i) => {
      const priceIn = Number(m.pricing?.prompt ?? 0) * 1e6;
      const priceOut = Number(m.pricing?.completion ?? 0) * 1e6;
      if (m.alias_target || priceIn < 0 || priceOut < 0) return; // aliases of other entries; routers
      if (!(m.endpoints ?? ["/api/v1/chat/completions"]).includes("/api/v1/chat/completions")) return; // batch-only
      if (!(m.supported_parameters ?? []).includes("tools")) return void hidden++;
      const [maker, ...rest] = m.name.includes(": ") ? m.name.split(": ") : [m.id.split("/")[0], m.name];
      const rank = speedRank.get(m.id);
      models.push({
        id: m.id, name: rest.join(": "), maker, makerId: m.id.split("/")[0], description: m.description ?? "",
        open: !!m.hugging_face_id, reasoning: (m.supported_parameters ?? []).includes("reasoning"),
        images: (m.architecture?.input_modalities ?? []).includes("image"),
        priceIn, priceOut, free: priceIn === 0 && priceOut === 0, context: m.context_length,
        popularity: i, fast: rank != null && rank < fastest.length / 3, speedRank: rank ?? Infinity,
        coding: codingIds.has(m.id), aa: m.benchmarks?.artificial_analysis ?? {}, created: m.created ?? 0,
        slicer: scores.models?.[m.id] ?? null,
      });
    });
    return { models, hidden, sets: scores.sets ?? {} };
  })();
  catalog.catch(() => (catalog = null)); // try again next time
  return catalog;
}

const desc = (key) => (a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity);
const SORTS = {
  popular: (a, b) => a.popularity - b.popularity,
  easy: (a, b) => rate(b.slicer, "basic") - rate(a.slicer, "basic") || rate(b.slicer, "hard") - rate(a.slicer, "hard") || a.popularity - b.popularity,
  hard: (a, b) => rate(b.slicer, "hard") - rate(a.slicer, "hard") || rate(b.slicer, "basic") - rate(a.slicer, "basic") || a.popularity - b.popularity,
  coding: (a, b) => desc("coding_index")(a.aa, b.aa),
  agentic: (a, b) => desc("agentic_index")(a.aa, b.aa),
  intelligence: (a, b) => desc("intelligence_index")(a.aa, b.aa),
  cheapest: (a, b) => a.priceOut - b.priceOut || a.priceIn - b.priceIn,
  fastest: (a, b) => a.speedRank - b.speedRank,
  newest: (a, b) => b.created - a.created,
};

function filters() {
  return {
    words: $("mpSearch").value.toLowerCase().split(/\s+/).filter(Boolean),
    maker: $("mpMaker").value, weights: $("mpWeights").value, price: $("mpPrice").value,
    coding: $("mpCoding").checked, fast: $("mpFast").checked, images: $("mpImages").checked, tested: $("mpTested").checked,
  };
}

function matches(m, f) {
  if (f.words.length) {
    const hay = `${m.id} ${m.maker} ${m.name} ${m.description}`.toLowerCase();
    if (!f.words.every((w) => hay.includes(w))) return false;
  }
  if (f.maker && m.makerId !== f.maker) return false;
  if (f.weights === "open" && !m.open) return false;
  if (f.weights === "closed" && m.open) return false;
  if (f.price === "free" && !m.free) return false;
  if (f.price && f.price !== "free" && m.priceOut > Number(f.price)) return false;
  if (f.coding && !m.coding) return false;
  if (f.fast && !m.fast) return false;
  if (f.images && !m.images) return false;
  if (f.tested && !m.slicer) return false;
  return true;
}

const money = (x) => (x === 0 ? "0" : x < 0.1 ? x.toFixed(3) : x < 10 ? x.toFixed(2) : x.toFixed(0));
const tokens = (n) => (!n ? "?" : n >= 1e6 ? `${+(n / 1048576).toFixed(1)}M` : `${Math.round(n / 1024)}k`);

function row(m, current, sets) {
  const badges = [
    m.open && "open weights", m.coding && "used for coding", m.fast && "fast", m.images && "reads images", m.reasoning && "reasons", m.free && "free, rate limited",
  ].filter(Boolean).map((b) => `<span class="mp-badge">${b}</span>`).join("");
  const aa = [["intelligence", "intelligence_index"], ["coding", "coding_index"], ["agentic", "agentic_index"]]
    .filter(([, k]) => m.aa[k] != null).map(([label, k]) => `${label} ${Math.round(m.aa[k])}`).join(", ");
  const facts = [`$${money(m.priceIn)} / $${money(m.priceOut)}`, `${tokens(m.context)} context`, aa && `scores: ${aa}`].filter(Boolean).join(" · ");
  const groups = summarize(m.slicer);
  const slicer = groups.length ? `<div class="mp-slicer">Slicer tasks: ${groups.map((g) =>
    `<button type="button" class="sd-link" data-scores="${esc(m.id)}" data-focus="${esc(g.key)}" title="${esc(`${g.runs} run${g.runs > 1 ? "s" : ""}, $${money(g.cost / g.n)} and ${Math.round(g.seconds / g.n)} s per task. Click for the tasks it passed and failed.`)}">${esc(groupLabel(g, sets))} ${g.passed}/${g.n}</button>`).join(" ")}</div>` : "";
  return `<div class="mp-row${m.id === current ? " current" : ""}">
    <div class="mp-main">
      <div><b>${esc(m.name)}</b> <span class="mp-maker">${esc(m.maker)}</span> ${badges}</div>
      <div class="mp-facts">${facts}</div>${slicer}
      <div class="mp-desc" title="${esc(m.description)}"><code>${esc(m.id)}</code> ${esc(m.description)}</div>
    </div>
    <button type="button" data-use="${esc(m.id)}"${m.id === current ? " class=\"primary\"" : ""}>${m.id === current ? "In use" : "Use"}</button>
  </div>`;
}

/**
 * Open the picker. onPick(id) is called with the chosen OpenRouter model id.
 * current: the model in use; scoresUrl: this page's evaluation results (optional file).
 */
export async function openModelPicker({ current, onPick, scoresUrl = "./bench/scores.json" }) {
  const dlg = $("modelsDialog");
  const list = $("mpList");
  dlg.showModal();
  list.innerHTML = `<p class="help">Loading OpenRouter's model list…</p>`;
  let cat;
  try {
    cat = await loadCatalog(scoresUrl);
  } catch (e) {
    list.innerHTML = `<p class="msg error">Could not load the model list: ${esc(e.message)}</p>`;
    return;
  }
  const makers = new Map();
  for (const m of cat.models) makers.set(m.makerId, { label: m.maker, n: (makers.get(m.makerId)?.n ?? 0) + 1 });
  const sel = $("mpMaker");
  if (sel.options.length <= 1) {
    sel.innerHTML = `<option value="">All makers</option>` + [...makers].sort((a, b) => b[1].n - a[1].n)
      .map(([id, v]) => `<option value="${esc(id)}">${esc(v.label)} (${v.n})</option>`).join("");
  }
  $("mpTested").parentElement.style.display = cat.models.some((m) => m.slicer) ? "" : "none";

  const draw = () => {
    const f = filters();
    const found = cat.models.filter((m) => matches(m, f)).sort(SORTS[$("mpSort").value] ?? SORTS.popular);
    list.innerHTML = found.slice(0, SHOWN).map((m) => row(m, current, cat.sets)).join("") || `<p class="help">No model matches these filters.</p>`;
    $("mpCount").textContent = `${found.length} of ${cat.models.length} models${found.length > SHOWN ? `, first ${SHOWN} shown` : ""}. ` +
      `${cat.hidden} more cannot call tools, which the chat needs.`;
  };
  for (const id of ["mpSearch", "mpMaker", "mpWeights", "mpPrice", "mpCoding", "mpFast", "mpImages", "mpTested", "mpSort"]) $(id).oninput = draw;
  $("mpSearch").onkeydown = (e) => e.key === "Enter" && e.preventDefault(); // would close the dialog
  list.onclick = (ev) => {
    const link = ev.target.closest("[data-scores]");
    if (link) {
      const m = cat.models.find((x) => x.id === link.dataset.scores);
      openScoreDashboard({ id: m.id, name: `${m.maker}: ${m.name}`, entry: m.slicer, sets: cat.sets, focus: link.dataset.focus });
      return;
    }
    const id = ev.target.closest("[data-use]")?.dataset.use;
    if (!id) return;
    dlg.close();
    if (id !== current) onPick(id);
  };
  draw();
  $("mpSearch").focus();
}
