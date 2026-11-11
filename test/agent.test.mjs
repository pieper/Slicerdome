// Unit tests that need no browser: tool-call parsing, the remote provider's streaming against a
// mock OpenAI-compatible server, error queries, and the agent loop with a scripted provider.
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { Agent, errorQuery } from "../src/agent.js";
import { RemoteProvider } from "../src/providers.js";
import { parseReply, systemWithTools, toolResponses } from "../src/qwen-tools.js";

const TOOLS = [
  { name: "run_python", description: "Run Python", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
  { name: "read_file", description: "Read", parameters: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" } } } },
];

test("parseReply reads Qwen3.5 XML calls, keeps code verbatim, coerces integers", () => {
  const raw = `<think>\n\n</think>\n\nLet me check.\n<tool_call>\n<function=run_python>\n<parameter=code>\nprint("a\\nb")\nx = {'k': 1}\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=read_file>\n<parameter=path>\nDocs/x.md\n</parameter>\n<parameter=start_line>\n12\n</parameter>\n</function>\n</tool_call>`;
  const r = parseReply(raw, TOOLS);
  assert.equal(r.text, "Let me check.");
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].args.code, `print("a\\nb")\nx = {'k': 1}`);
  assert.deepEqual(r.calls[1].args, { path: "Docs/x.md", start_line: 12 });
  assert.deepEqual(r.problems, []);
});

test("parseReply accepts the older JSON form and reports unreadable calls", () => {
  const r = parseReply(`<tool_call>\n{"name": "run_python", "arguments": {"code": "1+1"}}\n</tool_call>`, TOOLS);
  assert.deepEqual(r.calls, [{ name: "run_python", args: { code: "1+1" } }]);
  const bad = parseReply("<tool_call>\nnonsense\n</tool_call>", TOOLS);
  assert.equal(bad.calls.length, 0);
  assert.equal(bad.problems.length, 1);
});

test("parseReply separates thinking from the answer", () => {
  const r = parseReply("<think>\nreasoning here\n</think>\n\nThe answer is 4.", TOOLS);
  assert.equal(r.thinking, "reasoning here");
  assert.equal(r.text, "The answer is 4.");
});

test("system prompt and tool responses follow the template's wording", () => {
  const sys = systemWithTools(TOOLS, "Be brief.");
  assert.match(sys, /^# Tools\n\nYou have access to the following functions:\n\n<tools>\n\{"type":"function"/);
  assert.match(sys, /<\/IMPORTANT>\n\nBe brief\.$/);
  assert.equal(toolResponses(["a", "b"]), "<tool_response>\na\n</tool_response>\n<tool_response>\nb\n</tool_response>");
});

test("errorQuery turns tracebacks into searches", () => {
  assert.equal(errorQuery("AttributeError: 'MRMLCorePython.vtkMRMLScalarVolumeNode' object has no attribute 'GetDimensions'"), "vtkMRMLScalarVolumeNode GetDimensions");
  assert.equal(errorQuery("NameError: name 'arrayFromVolume' is not defined"), "arrayFromVolume");
  assert.equal(errorQuery("ModuleNotFoundError: No module named 'SimpleITK'"), "import SimpleITK");
  assert.equal(errorQuery("all fine"), null);
});

function mockServer(chunks) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((r) => server.listen(0, () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

test("RemoteProvider streams text and assembles tool calls split across chunks", async () => {
  const { server, seen, url } = await mockServer([
    { choices: [{ delta: { reasoning: "thinking..." } }] },
    { choices: [{ delta: { content: "Running " } }] },
    { choices: [{ delta: { content: "it." } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "run_python", arguments: '{"co' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'de": "print(1)"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]);
  try {
    const p = new RemoteProvider({ id: "custom", label: "Mock", baseUrl: url, apiKey: "k", model: "m" });
    const r = await p.complete({
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "", calls: [{ id: "c0", name: "run_python", args: { code: "1" } }] }, { role: "tool", callId: "c0", name: "run_python", content: "1" }],
      tools: TOOLS, instructions: "sys",
    });
    assert.equal(r.text, "Running it.");
    assert.equal(r.thinking, "thinking...");
    assert.deepEqual(r.calls, [{ id: "c1", name: "run_python", args: { code: "print(1)" } }]);
    assert.equal(r.finish, "tool_calls");
    assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 5 });
    const sent = seen[0];
    assert.equal(sent.url, "/v1/chat/completions");
    assert.equal(sent.headers.authorization, "Bearer k");
    assert.equal(sent.body.messages[0].role, "system");
    assert.equal(sent.body.messages[2].tool_calls[0].function.arguments, '{"code":"1"}');
    assert.deepEqual(sent.body.messages[3], { role: "tool", tool_call_id: "c0", content: "1" });
    assert.equal(sent.body.tools[0].function.name, "run_python");
  } finally {
    server.close();
  }
});

test("Agent runs tools, refuses exact repeats, and stops on persistent repetition", async () => {
  const replies = [
    { calls: [{ id: "1", name: "run_python", args: { code: "bad()" } }] },
    { calls: [{ id: "2", name: "run_python", args: { code: "bad()" } }] },
    { calls: [{ id: "3", name: "run_python", args: { code: "bad()" } }] },
    { calls: [{ id: "4", name: "run_python", args: { code: "bad()" } }] },
  ];
  const temps = [];
  const provider = { local: true, label: "scripted", async complete({ temperature }) { temps.push(temperature); return { text: "", thinking: "", problems: [], raw: "", ...replies.shift() }; } };
  let runs = 0;
  const tools = [{ name: "run_python", parameters: {}, async run() { runs++; return "[error]\nNameError: name 'bad' is not defined"; } }];
  const agent = new Agent({ provider, tools, assist: true, maxSteps: 10 });
  const r = await agent.send("do it");
  assert.equal(runs, 1, "the failing code runs once");
  assert.equal(r.stopped, true);
  assert.match(r.text, /kept repeating/);
  assert.deepEqual(temps.slice(0, 3), [null, null, 0.9]);
});

test("Agent answers when the model stops calling tools, and adds the scene summary", async () => {
  const seen = [];
  const provider = { local: false, label: "scripted", async complete({ messages }) { seen.push(messages.map((m) => m.content)); return { text: "Done: 42", thinking: "", calls: [], problems: [], raw: null }; } };
  const agent = new Agent({ provider, tools: [], scene: async () => '- volume "MRHead"' });
  const r = await agent.send("what?");
  assert.equal(r.text, "Done: 42");
  assert.match(seen[0][0], /^what\?\n\n<scene>\nCurrently loaded in Slicer \(added automatically\):\n- volume "MRHead"\n<\/scene>$/);
});
