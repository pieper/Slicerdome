#!/usr/bin/env node
// Collect eval results (bench/eval.mjs --out files) into bench/scores.json, which the model picker
// shows: each model's runs on the easy (basic) and hard tasks, with every task's outcome, what
// the check found, the model's answer and its last error, and the cost.
//
//   node bench/scores.mjs results1.json results2.json ... > bench/scores.json
//
// Claude models run through the Anthropic API are listed under their OpenRouter ids. Runs of
// models in the browser (local:) are left out: the picker lists OpenRouter models.
import { readFileSync } from "node:fs";
import { TASKS as BASIC } from "./tasks.mjs";
import { TASKS as HARD } from "./tasks-hard.mjs";

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || "");

/** How a task ended, in a few words. */
function outcome(t, maxSteps) {
  if (t.pass) return "passed";
  if (t.error) return "error";
  const a = t.answer ?? "";
  if (/^Stopped: this request has cost/.test(a)) return "cost limit";
  if (/^Stopped: the model kept repeating/.test(a)) return "repeated failing code";
  if (t.timeout) return "timed out";
  if (t.stopped && t.steps >= maxSteps) return "out of steps";
  const models = (t.log ?? []).filter((e) => e.type === "model");
  const last = models[models.length - 1]?.reply;
  if (last && !last.text && !last.calls?.length && /^(length|max_tokens)$/.test(last.finish ?? "")) return "reply cut off";
  return "wrong answer";
}

/** The last error a tool call returned (the exception line of a traceback). */
function lastError(t) {
  const errs = (t.log ?? []).filter((e) => e.type === "tool" && /^\[error\]/.test(e.result ?? ""));
  if (!errs.length) return "";
  const lines = errs[errs.length - 1].result.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  return clip(lines.find((l) => /^(\w+Error|\w+Exception)\b/.test(l)) ?? lines[lines.length - 1], 240);
}

const models = {};
for (const file of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(file, "utf8"));
  if (!r.tasks?.length || r.provider.startsWith("local:")) continue;
  const id = r.provider.startsWith("claude:")
    ? `anthropic/${r.provider.slice(7).replace(/-(\d+)-(\d+)$/, "-$1.$2")}` // claude-haiku-5-5 -> anthropic/claude-haiku-5.5
    : r.model;
  if (!id) continue;
  const set = r.set ?? "basic";
  const maxSteps = r.maxSteps ?? 12;
  const hosts = {};
  for (const t of r.tasks) for (const h of t.served ?? []) hosts[h] = (hosts[h] ?? 0) + 1;
  const tasks = r.tasks.map((t) => ({
    id: t.id, pass: !!t.pass, outcome: outcome(t, maxSteps), why: clip(t.why, 400),
    steps: t.steps, seconds: +(t.seconds ?? 0).toFixed(1), cost: t.cost ?? null, failedCalls: t.toolErrors ?? 0,
    answer: clip(t.answer, t.pass ? 300 : 700), lastError: t.pass ? "" : lastError(t),
    ...(t.rescored ? { rescored: true } : {}),
  }));
  (models[id] ??= []).push({
    set, maxSteps, date: r.started.slice(0, 10),
    via: r.provider.startsWith("claude:") ? "Anthropic API" : "OpenRouter",
    hosts: Object.keys(hosts).sort((a, b) => hosts[b] - hosts[a]),
    effort: r.effort || "default",
    passed: tasks.filter((t) => t.pass).length, n: tasks.length,
    cost: +r.tasks.reduce((a, t) => a + (t.cost ?? 0), 0).toFixed(4),
    seconds: +r.tasks.reduce((a, t) => a + (t.seconds ?? 0), 0).toFixed(0),
    tasks,
  });
}
for (const runs of Object.values(models)) runs.sort((a, b) => (a.set === b.set ? a.maxSteps - b.maxSteps || a.date.localeCompare(b.date) : a.set === "basic" ? -1 : 1));

const describe = (list) => list.map((t) => ({ id: t.id, prompt: t.prompt, ...(t.source ? { source: t.source } : {}) }));
console.log(JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  sets: { basic: { label: "easy", tasks: describe(BASIC) }, hard: { label: "hard", tasks: describe(HARD) } },
  models: Object.fromEntries(Object.entries(models).map(([id, runs]) => [id, { runs }])),
}));
