#!/usr/bin/env node
// Check the evaluation tasks themselves, without a model: for each task, the judge must fail a run
// that does nothing, pass the task's reference solution, and fail its `wrong` solution if it has one.
//
//   node bench/selftest.mjs --profile DIR [--set hard] [--tasks a,b] [--base http://localhost:8795]
import { launch } from "./cdp.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const set = opt("--set", "hard");
const { TASKS } = await import(set === "hard" ? "./tasks-hard.mjs" : "./tasks.mjs");
const only = opt("--tasks")?.split(",");
const tasks = TASKS.filter((t) => !only || only.includes(t.id));

const s = await launch({ profile: opt("--profile"), port: 9345 });
let bad = 0;
try {
  await s.navigate(`${opt("--base", "http://localhost:8795")}/?provider=local:none`);
  await s.waitFor("!!window.slicerChat", { timeout: 60000 });
  const run = async (code) => s.evaluate(`slicerChat.slicer.run(${JSON.stringify(code)})`, { timeout: 300000 });
  const attempt = async (task, code) => {
    await s.evaluate("slicerChat.slicer.resetScene().then(() => true)", { timeout: 300000 });
    if (task.setup) {
      const r = await run(task.setup);
      if (!r.ok) return { error: `setup failed: ${r.output.slice(-400)}` };
    }
    let answer = "";
    if (code) {
      const r = await run(code);
      if (!r.ok) return { error: `solution failed: ${r.output.slice(-400)}` };
      answer = r.output;
    }
    const tr = await run(task.truth);
    let truth;
    try { truth = JSON.parse(tr.output.trim().split("\n").pop()); } catch { return { error: `truth failed: ${tr.output.slice(-400)}` }; }
    try {
      const [pass, why] = task.judge(answer, truth, {});
      return { pass, why, answer: answer.trim().slice(0, 160) };
    } catch (e) {
      return { error: `judge threw ${e.message}; truth ${JSON.stringify(truth).slice(0, 300)}` };
    }
  };
  for (const task of tasks) {
    const t0 = Date.now();
    const checks = [["nothing", null, false], ["solution", task.solution, true], ...(task.also ?? []).map((c) => ["also", c, true]), ...(task.wrong ? [["wrong", task.wrong, false]] : [])];
    const out = [];
    for (const [name, code, want] of checks) {
      const r = await attempt(task, code);
      const ok = !r.error && r.pass === want;
      if (!ok) bad++;
      out.push(`  ${ok ? "ok  " : "BAD "} ${name.padEnd(8)} ${r.error ?? `${r.pass ? "pass" : "fail"}: ${r.why}`}${name === "solution" && r.answer ? `\n         answer: ${r.answer}` : ""}`);
    }
    console.log(`${task.id} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n${out.join("\n")}`);
  }
} finally {
  s.kill();
}
console.log(bad ? `${bad} check(s) failed` : "all checks passed");
process.exit(bad ? 1 : 0);
