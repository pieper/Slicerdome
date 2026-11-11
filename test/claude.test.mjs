// Unit tests for the Claude provider's pieces that need no network: turning the agent's
// transcript into Messages API turns, checking tool input, the cost estimate, and how the agent
// loop treats invalid calls and the cost limit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.js";
import { checkArgs, costOf, toRequestMessages } from "../src/claude.js";

const TOOLS = [
  { name: "run_python", description: "Run Python", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] }, run: async ({ code }) => `ran ${code}` },
  { name: "search", description: "Search", parameters: { type: "object", properties: { corpus: { type: "string", enum: ["source", "discourse"] }, query: { type: "string" } }, required: ["corpus", "query"] }, run: async () => "hits" },
];

test("toRequestMessages pairs every tool_use with a result, results first, user content merged", () => {
  const thinking = { type: "thinking", thinking: "plan", signature: "sig" };
  const msgs = [
    { role: "user", content: "load MRHead" },
    { role: "assistant", raw: [thinking, { type: "tool_use", id: "t1", name: "run_python", input: { code: "1" } }, { type: "tool_use", id: "t2", name: "run_python", input: { code: "2" } }] },
    { role: "tool", callId: "t1", content: "ok" },
    // t2 never ran: the user pressed Stop. Then a new request.
    { role: "user", content: "next" },
    { role: "assistant", raw: [{ type: "text", text: "done" }] },
  ];
  const out = toRequestMessages(msgs);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(out[1].content[0], thinking, "thinking block passed back unchanged");
  assert.deepEqual(out[2].content.map((b) => b.type), ["tool_result", "tool_result", "text"]);
  assert.equal(out[2].content[0].tool_use_id, "t1");
  assert.equal(out[2].content[1].tool_use_id, "t2");
  assert.equal(out[2].content[1].is_error, true);
  assert.equal(out[2].content[2].text, "next");
});

test("toRequestMessages marks [error] results and skips empty assistant turns", () => {
  const out = toRequestMessages([
    { role: "user", content: "a" },
    { role: "assistant", raw: [{ type: "tool_use", id: "t1", name: "run_python", input: { code: "x" } }] },
    { role: "tool", callId: "t1", content: "[error] NameError" },
    { role: "assistant", raw: [] },
    { role: "user", content: "b" },
  ]);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(out[2].content[0].is_error, true);
  assert.equal(out[2].content[1].text, "b");
});

test("checkArgs catches missing, mistyped and out-of-enum arguments", () => {
  assert.equal(checkArgs(TOOLS[0], { code: "print(1)" }), null);
  assert.match(checkArgs(TOOLS[0], {}), /"code" is missing/);
  assert.match(checkArgs(TOOLS[0], { code: 5 }), /type string/);
  assert.match(checkArgs(TOOLS[1], { corpus: "web", query: "x" }), /one of: source, discourse/);
  assert.match(checkArgs(TOOLS[0], "print(1)"), /not a JSON object/);
});

test("costOf uses list prices, cache rates and Haiku's long-prompt rate", () => {
  const u = { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10000, output_tokens: 500 };
  // Sonnet 5.5: 1000*2 + 2000*2.5 + 10000*0.2 + 500*10 = 14000 per million
  assert.equal(costOf("claude-sonnet-5-5", u).toFixed(6), "0.014000");
  assert.equal(costOf("claude-haiku-5-5", u).toFixed(6), (((1000 * 0.1 + 2000 * 0.125 + 10000 * 0.01 + 500 * 0.5)) / 1e6).toFixed(6));
  const long = { input_tokens: 120000, output_tokens: 0 };
  assert.equal(costOf("claude-haiku-5-5", long).toFixed(6), ((120000 * 0.5) / 1e6).toFixed(6));
  assert.equal(costOf("unknown-model", u), null);
});

function scripted(replies) {
  let i = 0;
  return { local: false, label: "scripted", async complete() { return replies[Math.min(i++, replies.length - 1)]; } };
}
const reply = (calls, extra = {}) => ({ text: "", thinking: "", calls, problems: [], raw: null, ...extra });

test("Agent answers invalid calls with an error instead of running them", async () => {
  let ran = 0;
  const tools = [{ ...TOOLS[0], run: async () => (ran++, "ran") }];
  const agent = new Agent({ provider: scripted([reply([{ id: "a", name: "run_python", args: {}, invalid: "The required argument \"code\" is missing." }]), reply([], { text: "ok" })]), tools });
  const r = await agent.send("go");
  assert.equal(r.text, "ok");
  assert.equal(ran, 0);
  assert.match(agent.messages.find((m) => m.role === "tool").content, /^\[error\] The required argument/);
});

test("Agent stops before running more tools once the cost limit is reached", async () => {
  let ran = 0;
  const tools = [{ ...TOOLS[0], run: async () => (ran++, "ran") }];
  const step = (n) => reply([{ id: `c${n}`, name: "run_python", args: { code: `x${n}` } }], { cost: 0.3 });
  const agent = new Agent({ provider: scripted([step(1), step(2), step(3)]), tools, costLimit: 0.5 });
  const r = await agent.send("go");
  assert.equal(r.stopped, true);
  assert.match(r.text, /reached the limit/);
  assert.equal(ran, 1, "the first step's tool ran; the second step's did not");
});
