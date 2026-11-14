// The Benchmarks dialog: every model this page's evaluation has run (bench/scores.json), as a
// table that sorts by any column and as a chart of any two measures, such as cost per task against
// tasks passed. Clicking a model opens its dashboard of the tasks it passed and failed.

import { loadScores, openScoreDashboard, setOrder, summarize } from "./scores.js";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (x) => (x >= 1 ? `$${x.toFixed(2)}` : `$${x.toPrecision(2)}`);
const moneyTick = (x) => `$${+x.toPrecision(2)}`; // $0.02 on an axis, not $0.020
const duration = (s) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${+(s / 60).toFixed(s < 600 ? 1 : 0)} min` : `${(s / 3600).toFixed(1)} h`);
const percent = (v) => `${Math.round(v * 100)}%`;
const oneDecimal = (v) => v.toFixed(1);
const plain = (v) => String(+v.toFixed(2)); // axis ticks: 2, 4, 0.5

// 1-2-5 steps for log axes: $0.0001 … $10, and 1 s … 1 h.
const steps125 = (from, to) => { const t = []; for (let e = from; e <= to; e++) for (const k of [1, 2, 5]) t.push(+(k * 10 ** e).toPrecision(1)); return t; };
const COST_TICKS = steps125(-4, 1);
const TIME_TICKS = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600];

/** The measures, for table columns and chart axes. better: which way is good. */
const METRICS = {
  passed: { label: "Tasks passed", value: (g) => g.passed / g.n, better: "high", format: percent, scale: "percent" },
  cost: { label: "Cost per task", value: (g) => g.cost / g.n, better: "low", format: money, tick: moneyTick, scale: "log", ticks: COST_TICKS },
  time: { label: "Time per task", value: (g) => g.seconds / g.n, better: "low", format: duration, scale: "log", ticks: TIME_TICKS },
  steps: { label: "Steps per task", value: (g) => g.steps / g.n, better: "low", format: oneDecimal, tick: plain, scale: "linear" },
  failed: { label: "Failed tool calls per task", value: (g) => g.failed / g.n, better: "low", format: oneDecimal, tick: plain, scale: "linear" },
  testCost: { label: "Cost of the test", value: (g) => g.cost / g.runs, better: "low", format: money, tick: moneyTick, scale: "log", ticks: COST_TICKS,
    help: "What one run of the whole test cost (the average, if the model ran it more than once)" },
  testTime: { label: "Time of the test", value: (g) => g.seconds / g.runs, better: "low", format: duration, scale: "log", ticks: TIME_TICKS,
    help: "How long one run of the whole test took (the average, if the model ran it more than once)" },
};
const COLUMNS = ["passed", "cost", "time", "steps", "failed", "testCost", "testTime"];
const AXES = ["passed", "cost", "time", "steps", "failed"];

const state = { test: "hard:12", view: "table", sort: { key: "passed", dir: -1 }, x: "cost", y: "passed" };
let resize = null;

/** One row per model that ran the chosen test. */
function rowsFor(scores, key) {
  return Object.entries(scores.models ?? {}).flatMap(([id, entry]) => {
    const g = summarize(entry).find((x) => x.key === key);
    if (!g) return [];
    const runs = entry.runs.filter((r) => `${r.set}:${r.maxSteps}` === key);
    return [{ id, entry, g, runs, name: entry.name ?? id.split("/").pop(), maker: entry.maker ?? id.split("/")[0], open: !!entry.open }];
  });
}

/** The tests any model ran, easy before hard, fewer steps first. */
function tests(scores) {
  const found = new Map();
  for (const entry of Object.values(scores.models ?? {}))
    for (const g of summarize(entry)) found.set(g.key, { ...g, models: (found.get(g.key)?.models ?? 0) + 1, tasks: g.n / g.runs });
  return [...found.values()].sort((a, b) => setOrder(a.set) - setOrder(b.set) || a.maxSteps - b.maxSteps).map((t) => {
    const label = scores.sets?.[t.set]?.label ?? t.set;
    return { key: t.key, text: `${label[0].toUpperCase()}${label.slice(1)} tasks (${t.tasks}), up to ${t.maxSteps} steps · ${t.models} model${t.models === 1 ? "" : "s"}` };
  });
}

const isBetter = (m, a, b) => (m.better === "high" ? a > b : a < b);

function compare(sort) {
  const m = METRICS[sort.key];
  const by = sort.key === "model" ? (a, b) => a.name.localeCompare(b.name) : (a, b) => m.value(a.g) - m.value(b.g);
  const passed = METRICS.passed.value;
  const cost = METRICS.cost.value;
  return (a, b) => sort.dir * by(a, b) || passed(b.g) - passed(a.g) || cost(a.g) - cost(b.g) || a.name.localeCompare(b.name);
}

const runNote = (r) => r.runs.map((r) => `${r.date}, through ${r.via === "OpenRouter" ? "OpenRouter" : `the ${r.via}`}: ${r.passed}/${r.n}`).join("\n");

function drawTable(box, rows) {
  const best = Object.fromEntries(COLUMNS.map((k) => {
    const m = METRICS[k];
    return [k, rows.reduce((b, r) => (b == null || isBetter(m, m.value(r.g), b) ? m.value(r.g) : b), null)];
  }));
  rows.sort(compare(state.sort));
  const head = (key, label, title = "") => {
    const on = state.sort.key === key;
    const arrow = on ? (state.sort.dir < 0 ? " ▼" : " ▲") : "";
    return `<th${on ? ` aria-sort="${state.sort.dir < 0 ? "descending" : "ascending"}"` : ""}><button type="button" data-sort="${key}" title="${esc(title || `Sort by ${label.toLowerCase()}`)}">${esc(label)}${arrow}</button></th>`;
  };
  const cell = (r, k) => {
    const m = METRICS[k];
    const v = m.value(r.g);
    const top = rows.length > 1 && v === best[k] ? " best" : "";
    if (k === "passed") {
      return `<td class="${top}" title="${esc(`${percent(v)} of the tasks`)}">${r.g.passed}/${r.g.n}<span class="bn-meter" aria-hidden="true"><span style="width:${(v * 100).toFixed(1)}%"></span></span></td>`;
    }
    return `<td class="${top}">${esc(m.format(v))}</td>`;
  };
  box.innerHTML = `<table class="bn-table"><thead><tr>${head("model", "Model")}${COLUMNS.map((k) => head(k, METRICS[k].label, METRICS[k].help)).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><button type="button" class="bn-model" data-open="${esc(r.id)}" title="See the tasks it passed and failed">${esc(r.name)}</button>
        <div class="bn-sub" title="${esc(runNote(r))}">${esc(r.maker)}${r.open ? " · open weights" : ""}${r.g.runs > 1 ? ` · ${r.g.runs} runs, averaged` : ""}</div></td>
      ${COLUMNS.map((k) => cell(r, k)).join("")}</tr>`).join("")}</tbody></table>`;
}

// ---------------------------------------------------------------------------------------------
// The chart: a scatter of two measures, one point per model.

/** An axis: value -> pixel, its ticks, and its domain. */
function axis(m, values, [p0, p1]) {
  let lo;
  let hi;
  let ticks;
  if (m.scale === "percent") {
    [lo, hi] = [0, 1];
    ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  } else if (m.scale === "log") {
    const min = Math.min(...values);
    const max = Math.max(...values);
    lo = [...m.ticks].reverse().find((t) => t <= min / 1.25) ?? m.ticks[0];
    hi = m.ticks.find((t) => t >= max * 1.25) ?? m.ticks[m.ticks.length - 1];
    ticks = m.ticks.filter((t) => t >= lo && t <= hi);
    if (ticks.length > 8) ticks = ticks.filter((t) => /^1/.test(String(t)) || t === lo || t === hi);
  } else {
    const max = Math.max(...values, 0.1) * 1.1;
    const step = [1, 2, 5].map((k) => k * 10 ** Math.floor(Math.log10(max / 5))).find((s) => max / s <= 6) ?? 10 ** Math.ceil(Math.log10(max / 5));
    [lo, hi] = [0, Math.ceil(max / step) * step];
    ticks = [];
    for (let t = 0; t <= hi + step / 2; t += step) ticks.push(+t.toPrecision(6));
  }
  const f = m.scale === "log"
    ? (v) => p0 + ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (p1 - p0)
    : (v) => p0 + ((v - lo) / (hi - lo)) * (p1 - p0);
  return { f, ticks };
}

/** Models no other model beats on both measures. */
function frontier(rows, xm, ym) {
  const better = (m, a, b) => (m.better === "high" ? a >= b : a <= b);
  return rows.filter((r) => !rows.some((o) => o !== r
    && better(xm, xm.value(o.g), xm.value(r.g)) && better(ym, ym.value(o.g), ym.value(r.g))
    && (xm.value(o.g) !== xm.value(r.g) || ym.value(o.g) !== ym.value(r.g))));
}

const el = (name, attrs = {}, text) => {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
};

let measureCtx = null;
function textWidth(s, px = 12) {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  measureCtx.font = `${px}px ${getComputedStyle(document.body).fontFamily}`;
  return measureCtx.measureText(s).width;
}

function drawChart(box, rows, onOpen) {
  const xm = METRICS[state.x];
  const ym = METRICS[state.y];
  box.textContent = "";
  const legend = document.createElement("div");
  legend.className = "bn-legend";
  box.append(legend);
  if (!rows.length) return;

  const W = Math.max(320, box.clientWidth);
  const H = Math.round(Math.min(460, Math.max(300, W * 0.52)));
  const pad = { l: 58, r: 18, t: 14, b: 46 };
  const X = axis(xm, rows.map((r) => xm.value(r.g)), [pad.l, W - pad.r]);
  const Y = axis(ym, rows.map((r) => ym.value(r.g)), [H - pad.b, pad.t]);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
    "aria-label": `${ym.label} against ${xm.label.toLowerCase()} for ${rows.length} models. The table view has the same numbers.` });

  // Grid, axes, ticks.
  for (const t of Y.ticks) {
    const y = Y.f(t);
    svg.append(el("line", { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: "bn-grid" }));
    svg.append(el("text", { x: pad.l - 8, y: y + 4, "text-anchor": "end", class: "bn-tick" }, (ym.tick ?? ym.format)(t)));
  }
  let lastEnd = -Infinity; // a tick label that would overlap the one before it is left out
  for (const t of X.ticks) {
    const x = X.f(t);
    svg.append(el("line", { x1: x, x2: x, y1: pad.t, y2: H - pad.b, class: "bn-grid" }));
    const text = (xm.tick ?? xm.format)(t);
    const w = textWidth(text, 11);
    if (x - w / 2 < lastEnd + 8) continue;
    lastEnd = x + w / 2;
    svg.append(el("text", { x, y: H - pad.b + 16, "text-anchor": "middle", class: "bn-tick" }, text));
  }
  svg.append(el("line", { x1: pad.l, x2: W - pad.r, y1: H - pad.b, y2: H - pad.b, class: "bn-axis" }));
  svg.append(el("line", { x1: pad.l, x2: pad.l, y1: pad.t, y2: H - pad.b, class: "bn-axis" }));
  const hint = (m) => `${m.label}${m.scale === "log" ? " (log scale)" : ""}, ${m.better === "high" ? "higher" : "lower"} is better`;
  svg.append(el("text", { x: (pad.l + W - pad.r) / 2, y: H - 8, "text-anchor": "middle", class: "bn-title" }, hint(xm)));
  svg.append(el("text", { x: 14, y: (pad.t + H - pad.b) / 2, "text-anchor": "middle", transform: `rotate(-90 14 ${(pad.t + H - pad.b) / 2})`, class: "bn-title" }, hint(ym)));

  // The frontier: a line through the models that no other model beats on both measures.
  const front = frontier(rows, xm, ym).sort((a, b) => xm.value(a.g) - xm.value(b.g) || ym.value(a.g) - ym.value(b.g));
  if (front.length > 1) {
    svg.append(el("polyline", { points: front.map((r) => `${X.f(xm.value(r.g))},${Y.f(ym.value(r.g))}`).join(" "), class: "bn-front" }));
  }

  // Points (closed weights in the first color, open in the second), then labels where they fit.
  const pts = rows.map((r) => ({ r, x: X.f(xm.value(r.g)), y: Y.f(ym.value(r.g)) }));
  const boxes = pts.map((p) => [p.x - 7, p.y - 7, p.x + 7, p.y + 7]);
  for (let i = 1; i < front.length; i++) { // labels keep off the frontier line too
    const [a, b] = [front[i - 1], front[i]].map((r) => [X.f(xm.value(r.g)), Y.f(ym.value(r.g))]);
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4);
    for (let j = 0; j <= n; j++) {
      const [x, y] = [a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n];
      boxes.push([x - 1, y - 1, x + 1, y + 1]);
    }
  }
  const hits = (b) => b[0] < pad.l + 2 || b[2] > W - 2 || b[1] < 0 || b[3] > H - pad.b - 2
    || boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
  for (const p of pts) {
    const g = el("g", { class: "bn-pt", tabindex: "0", role: "button", "aria-label": `${p.r.name}: ${ym.label.toLowerCase()} ${ym.format(ym.value(p.r.g))}, ${xm.label.toLowerCase()} ${xm.format(xm.value(p.r.g))}` });
    g.append(el("circle", { cx: p.x, cy: p.y, r: 12, class: "bn-hit" }));
    g.append(el("circle", { cx: p.x, cy: p.y, r: 9, class: "bn-halo" }));
    g.append(el("circle", { cx: p.x, cy: p.y, r: 5, class: `bn-dot ${p.r.open ? "open" : "closed"}` }));
    g.addEventListener("pointerenter", () => tip(box, p, xm, ym));
    g.addEventListener("focus", () => tip(box, p, xm, ym));
    g.addEventListener("pointerleave", () => tip(box));
    g.addEventListener("blur", () => tip(box));
    g.addEventListener("click", () => onOpen(p.r));
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(p.r); } });
    p.g = g;
    svg.append(g);
  }
  for (const p of [...pts].sort((a, b) => a.y - b.y)) {
    const w = textWidth(p.r.name);
    const spots = [
      [p.x + 10, p.y + 4, "start"], [p.x - 10, p.y + 4, "end"], [p.x, p.y - 11, "middle"], [p.x, p.y + 19, "middle"],
      [p.x + 7, p.y - 9, "start"], [p.x + 7, p.y + 17, "start"], [p.x - 7, p.y - 9, "end"], [p.x - 7, p.y + 17, "end"],
    ];
    for (const [x, y, anchor] of spots) {
      const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
      const b = [x0 - 2, y - 11, x0 + w + 2, y + 3];
      if (hits(b)) continue;
      boxes.push(b);
      p.g.append(el("text", { x, y, "text-anchor": anchor, class: "bn-label" }, p.r.name));
      break;
    }
  }
  box.append(svg);

  const kinds = [...new Set(rows.map((r) => r.open))].sort((a, b) => a - b);
  for (const open of kinds) legend.append(key("dot", open ? "open" : "closed", open ? "Open weights" : "Closed weights"));
  if (front.length > 1) legend.append(key("line", "", "Frontier: no other model is better on both measures"));
}

function key(kind, cls, text) {
  const item = document.createElement("span");
  const mark = document.createElement("span");
  mark.className = `bn-key-${kind} ${cls}`;
  item.append(mark, document.createTextNode(text));
  return item;
}

/** Show (or with no point, hide) the readout for one model: the values first, then what they are. */
function tip(box, p, xm, ym) {
  box.querySelector(".bn-tip")?.remove();
  if (!p) return;
  const t = document.createElement("div");
  t.className = "bn-tip";
  const head = document.createElement("div");
  head.className = "bn-tip-name";
  head.textContent = `${p.r.name} · ${p.r.maker}`;
  t.append(head);
  const shown = [...new Set([state.y, state.x, "passed", "cost", "time", "steps"])];
  for (const k of shown) {
    const m = METRICS[k];
    const line = document.createElement("div");
    const v = document.createElement("b");
    v.textContent = k === "passed" ? `${m.format(m.value(p.r.g))} (${p.r.g.passed}/${p.r.g.n})` : m.format(m.value(p.r.g));
    line.append(v, document.createTextNode(` ${m.label.toLowerCase().replace(/^tasks /, "")}`));
    t.append(line);
  }
  const more = document.createElement("div");
  more.className = "bn-tip-more";
  more.textContent = "Click for its tasks";
  t.append(more);
  box.append(t);
  // The point's place in the box (the drawing is scaled when the box is narrower than it).
  const svg = box.querySelector("svg").getBoundingClientRect();
  const outer = box.getBoundingClientRect();
  const k = svg.width / Number(box.querySelector("svg").getAttribute("width"));
  const x = svg.left - outer.left + p.x * k;
  const y = svg.top - outer.top + p.y * k;
  const left = x + 16 + t.offsetWidth > box.clientWidth ? x - 16 - t.offsetWidth : x + 16;
  t.style.left = `${Math.max(0, left)}px`;
  t.style.top = `${Math.max(0, y - t.offsetHeight / 2)}px`;
}

// ---------------------------------------------------------------------------------------------

/** Open the Benchmarks dialog. */
export async function openBenchmarks({ scoresUrl = "./bench/scores.json" } = {}) {
  const dlg = $("benchDialog");
  const table = $("bnTable");
  const chart = $("bnChart");
  dlg.showModal();
  let scores;
  try {
    scores = await loadScores(scoresUrl);
  } catch (e) {
    table.innerHTML = `<p class="msg error">Could not load the results: ${esc(e.message)}</p>`;
    return;
  }
  const list = tests(scores);
  if (!list.some((t) => t.key === state.test)) state.test = list[0]?.key;
  $("bnTest").innerHTML = list.map((t) => `<option value="${esc(t.key)}">${esc(t.text)}</option>`).join("");
  $("bnTest").value = state.test;
  for (const id of ["bnX", "bnY"]) $(id).innerHTML = AXES.map((k) => `<option value="${k}">${esc(METRICS[k].label)}</option>`).join("");
  $("bnX").value = state.x;
  $("bnY").value = state.y;

  const open = (r) => openScoreDashboard({ id: r.id, name: `${r.maker}: ${r.name}`, entry: r.entry, sets: scores.sets, focus: state.test });
  const draw = () => {
    const rows = rowsFor(scores, state.test);
    for (const b of dlg.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === state.view));
    table.hidden = state.view !== "table";
    chart.hidden = state.view !== "chart";
    $("bnAxes").hidden = state.view !== "chart";
    if (state.view === "table") drawTable(table, rows);
    else drawChart(chart, rows, open);
    const others = Object.keys(scores.models ?? {}).length - rows.length;
    $("bnShown").textContent = `${rows.length} model${rows.length === 1 ? "" : "s"}${others ? ` (${others} more ran other tests)` : ""}. ` +
      (state.view === "table" ? "Click a column to sort, a model for its tasks." : "Click a point for the model's tasks.");
  };
  $("bnTest").onchange = () => { state.test = $("bnTest").value; draw(); };
  $("bnX").onchange = () => { state.x = $("bnX").value; draw(); };
  $("bnY").onchange = () => { state.y = $("bnY").value; draw(); };
  for (const b of dlg.querySelectorAll("[data-view]")) b.onclick = () => { state.view = b.dataset.view; draw(); };
  table.onclick = (ev) => {
    const s = ev.target.closest("[data-sort]")?.dataset.sort;
    if (s) {
      const first = s === "model" ? 1 : METRICS[s].better === "high" ? -1 : 1; // best first
      state.sort = { key: s, dir: state.sort.key === s ? -state.sort.dir : first };
      draw();
      return;
    }
    const id = ev.target.closest("[data-open]")?.dataset.open;
    if (id) open(rowsFor(scores, state.test).find((r) => r.id === id));
  };
  $("bnGenerated").textContent = scores.generated ?? "?";

  // Redraw the chart when the dialog changes width.
  resize?.disconnect();
  let width = chart.clientWidth;
  resize = new ResizeObserver(() => {
    if (state.view === "chart" && Math.abs(chart.clientWidth - width) > 8) { width = chart.clientWidth; draw(); }
  });
  resize.observe(chart);
  dlg.addEventListener("close", () => resize?.disconnect(), { once: true });
  draw();
}
