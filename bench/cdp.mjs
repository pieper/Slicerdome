// Minimal Chrome DevTools Protocol driver for the benchmarks and the eval:
// launch Chrome with its own profile, open a page, evaluate expressions in it.
import { spawn } from "node:child_process";

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ profile, port = 9341, headless = true, extraArgs = [], onConsole }) {
  const args = [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    "--no-first-run", "--no-default-browser-check", "--enable-unsafe-webgpu",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    ...(headless ? ["--headless=new"] : ["--window-size=1600,1000"]),
    ...extraArgs, "about:blank",
  ];
  const proc = spawn(CHROME, args, { stdio: "ignore" });
  let targets;
  for (let i = 0; i < 100 && !targets; i++) {
    await sleep(200);
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {}
  }
  if (!targets) throw new Error("Chrome did not start");
  const page = targets.find((t) => t.type === "page");
  const session = await connect(page.webSocketDebuggerUrl, { onConsole });
  session.kill = () => { session.close(); proc.kill(); };
  return session;
}

export async function connect(wsUrl, { onConsole } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === "Runtime.consoleAPICalled") {
      const line = `console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`;
      logs.push(line);
      onConsole?.(line);
    }
    if (m.method === "Runtime.exceptionThrown") logs.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  /** Evaluate an expression in the page; awaits promises, returns the JSON value or throws the page's error. */
  async function evaluate(expression, { timeout = 600000 } = {}) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async function navigate(url) { await send("Page.navigate", { url }); }
  async function waitFor(expression, { timeout = 120000, interval = 250 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = await evaluate(expression, { timeout: 5000 }); if (v) return v; } catch {}
      await sleep(interval);
    }
    throw new Error(`timed out waiting for ${expression}`);
  }
  return { send, evaluate, navigate, waitFor, logs, close: () => ws.close() };
}
