#!/usr/bin/env node
// Drive bench/speed.html in headless Chrome for each model and print a table.
//   node bench/run-speed.mjs --profile DIR [--base http://localhost:8795] MODEL...
import { launch } from "./cdp.mjs";

const args = process.argv.slice(2);
const take = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
const profile = take("--profile");
const base = take("--base", "http://localhost:8795");
const headed = args.includes("--headed"); if (headed) args.splice(args.indexOf("--headed"), 1);
const models = args;
const results = [];
for (const model of models) {
  const s = await launch({ profile, headless: !headed });
  try {
    await s.navigate(`${base}/bench/speed.html?model=${encodeURIComponent(model)}`);
    let last = "";
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const b = await s.evaluate("JSON.stringify(window.__bench || {})").then(JSON.parse).catch(() => ({}));
      const line = `${b.status} ${b.progress ?? ""}`.slice(0, 160);
      if (line !== last) { console.error(`[${model}] ${Math.round((Date.now() - t0) / 1000)}s ${line}`); last = line; }
      if (b.status === "done" || b.status === "error") { results.push(b); break; }
      if (Date.now() - t0 > 60 * 60 * 1000) { results.push({ model, status: "timeout" }); break; }
    }
  } finally {
    s.kill();
  }
}
console.log(JSON.stringify(results, null, 1));
