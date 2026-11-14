#!/usr/bin/env node
// Run the evaluation tasks (tasks.mjs) through the real chat page in headless Chrome:
// fresh SlicerWeb per task, the agent with the chosen provider, then a check of Slicer's state.
//
//   node bench/eval.mjs --profile DIR --provider local:Qwen3.5-4B-q4f16_1-MLC [--tasks a,b]
//        [--set hard|idc] [--no-skill] [--thinking] [--repeat N] [--out results.json] [--base http://localhost:8795] [--headed]
//   ANTHROPIC_API_KEY=... node bench/eval.mjs --profile DIR --provider claude:claude-haiku-5-5
//        [--effort low|medium|high] [--cost-limit 1]
//   OPENROUTER_API_KEY=... node bench/eval.mjs --profile DIR --provider remote:openrouter
//        --model qwen/qwen3.8-flash [--effort low|medium|high] [--cost-limit 1]
import { writeFileSync } from "node:fs";
import { launch } from "./cdp.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const profile = opt("--profile");
const provider = opt("--provider", "local:Qwen3.5-4B-q4f16_1-MLC");
const base = opt("--base", "http://localhost:8795");
const out = opt("--out");
const repeat = Number(opt("--repeat", 1));
const taskTimeout = Number(opt("--task-timeout", 600)) * 1000;
const set = opt("--set", "basic");
const { TASKS } = await import({ hard: "./tasks-hard.mjs", idc: "./tasks-idc.mjs" }[set] ?? "./tasks.mjs");
const only = opt("--tasks")?.split(",");
const tasks = TASKS.filter((t) => !only || only.includes(t.id));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

const s = await launch({
  profile, headless: !args.includes("--headed"), port: Number(opt("--port", 9343)),
  onConsole: (line) => {
    const m = /\[slicerChat\] (.*)$/s.exec(line);
    if (!m) return;
    try {
      const ev = JSON.parse(m[1]);
      if (ev.type === "model") log(`  step ${ev.step}: ${(ev.reply.calls || []).map((c) => `${c.name} ${JSON.stringify(c.args).slice(0, 160)}`).join("; ") || `answer ${JSON.stringify(ev.reply.text).slice(0, 160)}`}`);
      else if (ev.type === "tool") log(`    -> ${JSON.stringify(ev.result.slice(0, 200))}`);
      else if (ev.type === "error") log(`  error: ${ev.message}`);
    } catch {
      log(`  ${m[1].slice(0, 200)}`);
    }
  },
});
// --no-skill leaves SKILL.md (the guide to this Slicer) out of the model's instructions.
const skill = !args.includes("--no-skill");
const results = { provider, set, skill, thinking: args.includes("--thinking"), started: new Date().toISOString(), tasks: [] };

/** Open the chat page and apply the run's settings (again after SlicerWeb's Python has died). */
async function openPage() {
  await s.navigate(`${base}/?log=1&provider=${encodeURIComponent(provider)}${skill ? "" : "&skill=0"}`);
  await s.waitFor("!!window.slicerChat", { timeout: 60000 });
  await s.evaluate(`slicerChat.bundleReady.then(() => !!slicerChat.bundle)`);
  results.assist = opt("--assist", "local");
  results.maxSteps = Number(opt("--max-steps", 12));
  await s.evaluate(`(slicerChat.settings.thinking = ${results.thinking}, slicerChat.settings.maxSteps = ${Number(opt("--max-steps", 12))}, slicerChat.settings.assist = ${JSON.stringify(results.assist)}, true)`);
  if (provider === "remote:openrouter") {
    // Like the Claude key: from the environment, for this page session only (not saved).
    if (!process.env.OPENROUTER_API_KEY) throw new Error("Set OPENROUTER_API_KEY to evaluate OpenRouter models.");
    results.model = opt("--model", "qwen/qwen3.8-flash");
    results.effort = opt("--effort", "");
    await s.evaluate(`(Object.assign(slicerChat.settings.remote.openrouter, { apiKey: ${JSON.stringify(process.env.OPENROUTER_API_KEY)}, model: ${JSON.stringify(results.model)}, effort: ${JSON.stringify(results.effort)} }), slicerChat.settings.costLimit = ${Number(opt("--cost-limit", 1))}, slicerChat.resetRemote(), true)`);
  }
  if (provider.startsWith("claude:")) {
    // The key comes from the environment and is set for this page session only (not saved).
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY to evaluate Claude models.");
    results.effort = opt("--effort", "");
    await s.evaluate(`(Object.assign(slicerChat.settings.claude, { apiKey: ${JSON.stringify(process.env.ANTHROPIC_API_KEY)}, effort: ${JSON.stringify(results.effort)} }), slicerChat.settings.costLimit = ${Number(opt("--cost-limit", 1))}, true)`);
  }
  if (provider.startsWith("local:")) {
    const t0 = Date.now();
    await s.evaluate("slicerChat.ensureLoaded().then(() => true)");
    results.load_s = (Date.now() - t0) / 1000;
    log(`model loaded in ${results.load_s} s`);
  }
}

/** True when SlicerWeb's Python still answers. */
async function alive() {
  try {
    const r = await s.evaluate(`slicerChat.slicer.run("print(1)")`, { timeout: 30000 });
    return r.ok && r.output.trim() === "1";
  } catch {
    return false;
  }
}

try {
  await openPage();
  for (let rep = 0; rep < repeat; rep++) {
    for (const task of tasks) {
      log(`${task.id} (run ${rep + 1})`);
      if (!(await alive())) {
        log("  SlicerWeb's Python is not responding; reopening the page");
        await openPage();
      }
      try {
        // Each task starts from an empty scene with no variables left from earlier tasks.
        // (Reloading SlicerWeb would be cleaner, but a reload a few minutes after the first
        // start sometimes never finishes starting.)
        await s.evaluate("slicerChat.slicer.resetScene().then(() => true)");
        if (task.setup) {
          const r = await s.evaluate(`slicerChat.slicer.run(${JSON.stringify(task.setup)})`);
          if (!r.ok) throw new Error(`setup of ${task.id} failed: ${r.output}`);
          log("  setup done");
        }
        await s.evaluate("(slicerChat.newChat(), true)");
        const t0 = Date.now();
        const reply = await s.evaluate(`(() => {
          let timer;
          const limit = new Promise((r) => { timer = setTimeout(() => { document.getElementById("stop").click(); r({ text: "", stopped: true, timeout: true }); }, ${taskTimeout}); });
          return Promise.race([slicerChat.send(${JSON.stringify(task.prompt)}), limit]).finally(() => clearTimeout(timer));
        })()`, { timeout: taskTimeout + 60000 });
        const seconds = (Date.now() - t0) / 1000;
        await new Promise((r) => setTimeout(r, 300));
        const agentLog = await s.evaluate("slicerChat.agent ? slicerChat.agent.log : []");
        const guided = await s.evaluate("!!slicerChat.agent && /## Imaging Data Commons/.test(slicerChat.agent.instructions)");
        log("  checking");
        const truthRun = await s.evaluate(`slicerChat.slicer.run(${JSON.stringify(task.truth)})`);
        let truth = {};
        try {
          truth = JSON.parse(truthRun.output.trim().split("\n").pop());
        } catch {
          truth = { error: truthRun.output };
        }
        const used = {};
        let toolErrors = 0;
        const steps = agentLog.filter((e) => e.type === "model");
        for (const e of agentLog.filter((e) => e.type === "tool")) {
          used[e.call.name] = (used[e.call.name] ?? 0) + 1;
          if (/^\[error\]|^There is no tool|^This exact call failed/.test(e.result)) toolErrors++;
        }
        const formatProblems = steps.reduce((n, e) => n + (e.reply.problems?.length ?? 0), 0);
        let pass = false;
        let why = "";
        try {
          [pass, why] = task.judge(reply.text ?? "", truth, used);
          pass = !!pass;
        } catch (e) {
          why = `judge failed: ${e.message}; truth ${JSON.stringify(truth).slice(0, 200)}`;
        }
        const prefill = steps.map((e) => e.reply.timings?.prefill_tok_s).filter(Boolean);
        const decode = steps.map((e) => e.reply.timings?.decode_tok_s).filter(Boolean);
        const row = {
          id: task.id, source: task.source, run: rep + 1, pass, why, seconds, steps: steps.length, used, toolErrors, formatProblems, skill: guided,
          timeout: !!reply.timeout, stopped: !!reply.stopped,
          served: [...new Set(steps.map((e) => e.reply.served).filter(Boolean))],
          promptTokens: steps.reduce((n, e) => { const u = e.reply.usage ?? {}; return n + (u.prompt_tokens ?? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)); }, 0),
          completionTokens: steps.reduce((n, e) => n + (e.reply.usage?.completion_tokens ?? e.reply.usage?.output_tokens ?? 0), 0),
          cost: steps.some((e) => e.reply.cost != null) ? +steps.reduce((n, e) => n + (e.reply.cost ?? 0), 0).toFixed(4) : null,
          prefillTokS: prefill.length ? Math.round(prefill.reduce((a, b) => a + b) / prefill.length) : null,
          decodeTokS: decode.length ? +(decode.reduce((a, b) => a + b) / decode.length).toFixed(1) : null,
          answer: reply.text, log: agentLog,
        };
        results.tasks.push(row);
        log(`  ${pass ? "PASS" : "FAIL"} ${why} | ${seconds.toFixed(0)} s, ${steps.length} steps, tools ${JSON.stringify(used)}, errors ${toolErrors}, format ${formatProblems}${row.cost != null ? `, $${row.cost}` : ""}`);
      } catch (e) {
        // A fatal error in SlicerWeb (for example an ITK exception) ends its Python; the task fails.
        log(`  ERROR ${e.message.slice(0, 300)}`);
        let agentLog = [];
        try { agentLog = await s.evaluate("slicerChat.agent ? slicerChat.agent.log : []"); } catch {}
        const steps = agentLog.filter((x) => x.type === "model");
        results.tasks.push({
          id: task.id, source: task.source, run: rep + 1, pass: false, why: `error: ${e.message.slice(0, 300)}`, seconds: 0, steps: steps.length,
          used: {}, toolErrors: 0, formatProblems: 0, cost: +steps.reduce((n, x) => n + (x.reply.cost ?? 0), 0).toFixed(4), error: true, log: agentLog,
        });
      }
      if (out) writeFileSync(out, JSON.stringify(results, null, 1));
    }
  }
} finally {
  s.kill();
}
const n = results.tasks.length;
const passed = results.tasks.filter((t) => t.pass).length;
results.summary = {
  passed, n,
  mean_seconds: +(results.tasks.reduce((a, t) => a + t.seconds, 0) / n).toFixed(1),
  mean_steps: +(results.tasks.reduce((a, t) => a + t.steps, 0) / n).toFixed(1),
  tool_errors: results.tasks.reduce((a, t) => a + t.toolErrors, 0),
  format_problems: results.tasks.reduce((a, t) => a + t.formatProblems, 0),
  ...(results.tasks.some((t) => t.cost != null) ? { total_cost: +results.tasks.reduce((a, t) => a + (t.cost ?? 0), 0).toFixed(4) } : {}),
};
if (out) writeFileSync(out, JSON.stringify(results, null, 1));
console.log(JSON.stringify(results.summary));
