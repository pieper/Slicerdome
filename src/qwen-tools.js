// Tool calling for Qwen3.5 models run through WebLLM's plain chat API. WebLLM's own function
// calling covers only a few older models, so the page writes the tools into the system prompt
// in the exact words of Qwen3.5's chat template and parses the model's replies itself.
//
// Qwen3.5 calls tools in XML, with each parameter's value written out verbatim:
//
//   <tool_call>
//   <function=run_python>
//   <parameter=code>
//   print(slicer.app.applicationVersion)
//   </parameter>
//   </function>
//   </tool_call>
//
// which suits code: nothing has to be escaped into a JSON string.

/** The system message: tool block from Qwen3.5's template, then our instructions. */
export function systemWithTools(tools, instructions) {
  const specs = tools.map((t) => JSON.stringify({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  return (
    "# Tools\n\nYou have access to the following functions:\n\n<tools>\n" + specs.join("\n") + "\n</tools>" +
    "\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n\n<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>\n<parameter=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n</parameter>\n</function>\n</tool_call>\n\n<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n- Required parameters MUST be specified\n- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n</IMPORTANT>" +
    (instructions ? `\n\n${instructions.trim()}` : "")
  );
}

/** Tool results go back as one user turn of <tool_response> blocks, as in the template. */
export function toolResponses(contents) {
  return contents.map((c) => `<tool_response>\n${c}\n</tool_response>`).join("\n");
}

function coerce(value, schema) {
  const type = schema?.type;
  if (type === "integer" || type === "number") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : value;
  }
  if (type === "boolean") return /^\s*true\s*$/i.test(value);
  if (type === "object" || type === "array") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Split a reply into {thinking, text, calls:[{name, args}], problems:[string]}. Accepts the XML
 * form and, as a fallback, the JSON form older Qwen models use inside <tool_call>.
 */
export function parseReply(raw, tools) {
  let rest = raw;
  let thinking = "";
  const think = /^\s*(?:<think>)?([\s\S]*?)<\/think>\s*/.exec(rest);
  if (think) {
    thinking = think[1].trim();
    rest = rest.slice(think[0].length);
  }
  const calls = [];
  const problems = [];
  const blockRe = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
  let firstCall = -1;
  for (let m; (m = blockRe.exec(rest)); ) {
    if (firstCall < 0) firstCall = m.index;
    const body = m[1];
    const fn = /<function=([^>\s]+)\s*>([\s\S]*?)(?:<\/function>|$)/.exec(body);
    if (fn) {
      const name = fn[1].trim();
      const tool = tools.find((t) => t.name === name);
      const args = {};
      const paramRe = /<parameter=([^>\s]+)\s*>\n?([\s\S]*?)\n?(?:<\/parameter>|(?=<parameter=)|$)/g;
      for (let p; (p = paramRe.exec(fn[2])); ) {
        const key = p[1].trim();
        args[key] = coerce(p[2], tool?.parameters?.properties?.[key]);
      }
      calls.push({ name, args });
      continue;
    }
    try {
      const j = JSON.parse(body.trim());
      if (j && typeof j.name === "string") {
        calls.push({ name: j.name, args: typeof j.arguments === "string" ? JSON.parse(j.arguments) : j.arguments ?? {} });
        continue;
      }
    } catch {}
    problems.push(`Could not read this tool call: ${body.trim().slice(0, 200)}`);
  }
  const text = (firstCall >= 0 ? rest.slice(0, firstCall) : rest).trim();
  return { thinking, text, calls, problems };
}
