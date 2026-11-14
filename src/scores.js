// Results of this page's own evaluation (bench/scores.json, made by bench/scores.mjs): a summary
// per model for the picker, and a dashboard of one model's runs - which tasks passed and failed,
// how each failure happened, and what the run cost.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (x) => (x == null ? "?" : x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(4)}` : x < 1 ? `$${x.toFixed(3)}` : `$${x.toFixed(2)}`);
const duration = (s) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

let scores = null; // promise, fetched once per page load

/** This page's evaluation results (bench/scores.json). */
export function loadScores(url = "./bench/scores.json") {
  scores ??= fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    return r.json();
  });
  scores.catch(() => (scores = null)); // try again next time
  return scores;
}

/** Easy, hard, then other task sets (such as the IDC data tasks). */
export const setOrder = (set) => ({ basic: 0, hard: 1 })[set] ?? 2;

/** Groups of runs the picker and the Benchmarks dialog show: easy and hard tasks at the usual 12 steps, then other step limits. */
export function summarize(entry) {
  const groups = new Map();
  for (const r of entry?.runs ?? []) {
    const key = `${r.set}:${r.maxSteps}`;
    const g = groups.get(key) ?? { key, set: r.set, maxSteps: r.maxSteps, passed: 0, n: 0, cost: 0, seconds: 0, steps: 0, failed: 0, runs: 0 };
    g.passed += r.passed; g.n += r.n; g.cost += r.cost; g.seconds += r.seconds; g.runs += 1;
    for (const t of r.tasks ?? []) { g.steps += t.steps ?? 0; g.failed += t.failedCalls ?? 0; }
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => setOrder(a.set) - setOrder(b.set) || a.maxSteps - b.maxSteps);
}

/** The fraction passed in a set at 12 steps (for sorting), or -1. */
export function rate(entry, set) {
  const g = summarize(entry).find((x) => x.set === set && x.maxSteps === 12);
  return g ? g.passed / g.n : -1;
}

export function groupLabel(g, sets) {
  return `${sets?.[g.set]?.label ?? g.set}${g.maxSteps !== 12 ? `, ${g.maxSteps} steps` : ""}`;
}

const humanize = (id) => id.replace(/-/g, " ").replace(/\bijk\b/i, "IJK").replace(/\broi\b/i, "ROI").replace(/\bras\b/i, "RAS")
  .replace(/\blr\b/, "left-right").replace(/(\d)mm\b/, "$1 mm").replace(/^./, (c) => c.toUpperCase());

/** A sentence on how a task failed, from what the run recorded. */
function howItFailed(t, run) {
  switch (t.outcome) {
    case "out of steps":
      return `It used all ${run.maxSteps} steps without finishing.${t.failedCalls ? ` ${t.failedCalls} of its tool calls failed${t.lastError ? `; the last error was “${t.lastError}”` : ""}.` : ""}`;
    case "wrong answer":
      return `It finished and answered, but the result was not right.${t.lastError ? ` (Its last failed call: “${t.lastError}”.)` : ""}`;
    case "repeated failing code":
      return "The chat stopped it because it kept running code that had already failed.";
    case "cost limit":
      return "It reached the cost limit for one request before finishing.";
    case "reply cut off":
      return "Its reply was all reasoning and reached the length limit before an answer or a tool call. (The chat now asks the model again when this happens.)";
    case "timed out":
      return "It took longer than the evaluation's time limit for one task.";
    case "error":
      return "The run stopped with an error.";
    default:
      return "";
  }
}

function taskRow(t, run, info) {
  const mark = t.pass ? "✓" : "✗";
  const meta = [`${t.steps} step${t.steps === 1 ? "" : "s"}`, `${Math.round(t.seconds)} s`, money(t.cost), t.failedCalls ? `${t.failedCalls} failed call${t.failedCalls === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  const body = [
    info?.prompt ? `<p><b>Task:</b> ${esc(info.prompt)}${info.source ? ` <a href="${esc(info.source)}" target="_blank" rel="noopener">forum topic</a>` : ""}</p>` : "",
    t.pass ? "" : `<p><b>How it failed:</b> ${esc(howItFailed(t, run))}</p>`,
    `<p><b>What the check found:</b> ${esc(t.why) || "–"}${t.rescored ? " <i>(rescored after a fix to the check)</i>" : ""}</p>`,
    t.answer ? `<p><b>Its answer:</b></p><pre>${esc(t.answer)}</pre>` : `<p><b>Its answer:</b> none</p>`,
  ].join("");
  return `<details class="sd-task ${t.pass ? "ok" : "bad"}" id="sd-${esc(run._key)}-${esc(t.id)}">
    <summary><span class="sd-mark">${mark}</span> <span class="sd-name">${esc(humanize(t.id))}</span>
      <span class="sd-outcome">${esc(t.pass ? "passed" : t.outcome)}</span><span class="sd-meta">${esc(meta)}</span></summary>
    <div class="sd-body">${body}</div></details>`;
}

function runSection(run, sets, open) {
  const info = new Map((sets?.[run.set]?.tasks ?? []).map((t) => [t.id, t]));
  const failedCalls = run.tasks.reduce((a, t) => a + (t.failedCalls ?? 0), 0);
  const tiles = [
    [`${run.passed} / ${run.n}`, "tasks passed"],
    [money(run.cost), "cost of this test"],
    [money(run.cost / run.n), "per task"],
    [duration(run.seconds / run.n), `per task (${duration(run.seconds)} in all)`],
    [String(failedCalls), "failed tool calls"],
  ].map(([v, l]) => `<div class="sd-tile"><div class="sd-value">${esc(v)}</div><div class="sd-label">${esc(l)}</div></div>`).join("");
  const strip = run.tasks.map((t) => `<a href="#sd-${esc(run._key)}-${esc(t.id)}" class="sd-cell ${t.pass ? "ok" : "bad"}" title="${esc(humanize(t.id))}: ${esc(t.pass ? "passed" : t.outcome)}" data-task="${esc(t.id)}"></a>`).join("");
  const where = run.via === "OpenRouter" ? `through OpenRouter${run.hosts?.length ? ` (served by ${run.hosts.slice(0, 3).join(", ")})` : ""}` : `through the ${run.via}`;
  return `<details class="sd-run"${open ? " open" : ""}>
    <summary><b>${esc(sets?.[run.set]?.label ?? run.set)} tasks</b>, at most ${run.maxSteps} steps per task — ${run.passed}/${run.n} passed, ${money(run.cost)}</summary>
    <div class="sd-note">${esc(run.date)}, ${esc(where)}, reasoning effort ${esc(run.effort)}.</div>
    <div class="sd-tiles">${tiles}</div>
    <div class="sd-strip">${strip}</div>
    <div class="sd-tasks">${run.tasks.map((t) => taskRow(t, run, info.get(t.id))).join("")}</div>
  </details>`;
}

/** Show one model's runs. focus: "basic:12", "hard:12", … opens that group's runs. */
export function openScoreDashboard({ id, name, entry, sets, focus }) {
  const runs = (entry?.runs ?? []).map((r, i) => ({ ...r, _key: String(i) }));
  $("sdTitle").textContent = name ? `${name} on Slicer tasks` : `${id} on Slicer tasks`;
  const total = runs.reduce((a, r) => a + r.cost, 0);
  $("sdBody").innerHTML = `<p class="help"><code>${esc(id)}</code> · ${runs.length} test run${runs.length === 1 ? "" : "s"}, ${money(total)} in all.
      The easy and hard tasks are modeled on questions from the Slicer forum; each task is checked against Slicer's state or the numbers in the answer.
      Click a task for details.</p>` +
    runs.map((r) => runSection(r, sets, `${r.set}:${r.maxSteps}` === focus)).join("");
  $("sdBody").onclick = (ev) => {
    const cell = ev.target.closest(".sd-cell");
    if (!cell) return;
    ev.preventDefault();
    const row = $("sdBody").querySelector(cell.getAttribute("href"));
    if (row) {
      row.open = true;
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };
  $("scoreDialog").showModal();
}
