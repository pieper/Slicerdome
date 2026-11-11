// The agent's tools: search and read the static index, and run Python in SlicerWeb.
// Few tools with short, compact results, because small local models do worse with many
// tools and long context.

const CORPUS_HINTS = {
  source: "3D Slicer source code, including Python examples in Docs/developer_guide/script_repository/*.md",
  discourse: "the Slicer Discourse forum archive (questions and answers)",
  ctk: "CTK source (Qt widgets used by Slicer)",
  vtkaddon: "vtkAddon source",
  slicerexecutionmodel: "SlicerExecutionModel source (CLI module infrastructure)",
};

const MAX_RESULT_CHARS = 3500;

/** Paths whose snippets are examples a model can copy from: the script repository, developer docs, Python. */
const EXAMPLE_PATH = /script_repository|developer_guide|\.py$/;

/**
 * Retrieval the agent loop does on the model's behalf (small models rarely search on their
 * own): the best example snippets for a query, formatted for the context. Returns "" when
 * nothing useful was found.
 */
export function makeRetriever(bundle) {
  if (!bundle || !bundle.corpusNames.includes("source")) return null;
  /** The example around a hit: its whole section in a Markdown page, else nearby lines of code. */
  async function expand(h, maxLines) {
    const r = await bundle.readFile("source", h.path, { offset: Math.max(1, h.line - 40), limit: 120 });
    if (!r) return h.snippet ?? "";
    const lines = r.text.split("\n");
    const at = h.line - r.start_line;
    let start = Math.max(0, at - 3);
    let end = Math.min(lines.length, at + maxLines - 3);
    if (h.path.endsWith(".md")) {
      start = at;
      while (start > 0 && !/^#{1,4} /.test(lines[start])) start--;
      end = start + 1;
      while (end < lines.length && !/^#{1,4} /.test(lines[end])) end++;
      if (end - start > maxLines) end = start + maxLines;
    }
    return lines.slice(start, end).join("\n");
  }
  return async function retrieve(query, { n = 3, maxLines = 30 } = {}) {
    const r = await bundle.search("source", query, { topK: 40 });
    const seen = new Set();
    const hits = [];
    for (const h of r.results) {
      if (!EXAMPLE_PATH.test(h.path) || seen.has(h.path)) continue;
      seen.add(h.path);
      hits.push(h);
      if (hits.length >= n) break;
    }
    const parts = [];
    for (const h of hits) parts.push(`From ${h.path}:\n${clipLines(await expand(h, maxLines), maxLines, 1600)}`);
    return parts.join("\n\n");
  };
}

/** Keep the start and the end of long text, which is where tracebacks and summaries are. */
export function clip(text, max = MAX_RESULT_CHARS) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(-tail)}`;
}

/** First lines of a snippet, with the common indentation removed (it costs tokens and says nothing). */
function clipLines(text, maxLines, maxChars) {
  const lines = text.split("\n").slice(0, maxLines);
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  const body = lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0).replace(/\s+$/, "")).join("\n");
  return clip(body.replace(/\n{3,}/g, "\n\n"), maxChars);
}

/**
 * Tools as [{name, description, parameters (JSON Schema), run(args) -> Promise<string>}].
 * `bundle` is a static-index Bundle (or null to leave search out), `slicer` a SlicerBridge.
 */
export function makeTools({ bundle, slicer, maxChars = MAX_RESULT_CHARS }) {
  const tools = [];
  if (bundle) {
    const corpora = bundle.corpusNames;
    const corpusList = corpora.map((c) => `"${c}": ${CORPUS_HINTS[c] ?? bundle.manifest.corpora[c].label}`).join("; ");
    tools.push({
      name: "search",
      description: `Search Slicer's code and forum. Corpora: ${corpusList}. Returns the best matching files with a snippet around the match. Use API names or error messages as queries for code, and questions in plain words for the forum.`,
      parameters: {
        type: "object",
        properties: {
          corpus: { type: "string", enum: corpora, description: "Where to search" },
          query: { type: "string", description: "What to look for" },
        },
        required: ["corpus", "query"],
      },
      async run({ corpus, query, top_k }) {
        if (!corpora.includes(corpus)) return `Unknown corpus "${corpus}". Use one of: ${corpora.join(", ")}.`;
        if (!query) return "The query is empty.";
        const r = await bundle.search(corpus, String(query), { topK: Math.min(Number(top_k) || 4, 8) });
        if (!r.results.length) return `No results in ${corpus} for "${query}".`;
        return r.results
          .map((h, i) => `${i + 1}. ${h.path} (line ${h.line})\n${clipLines(h.snippet ?? "", 14, 700)}`)
          .join("\n\n");
      },
    });
    tools.push({
      name: "read_file",
      description: "Read lines of a file found by search. Give the corpus and path from a search result.",
      parameters: {
        type: "object",
        properties: {
          corpus: { type: "string", enum: corpora },
          path: { type: "string", description: "Path as shown in a search result" },
          start_line: { type: "integer", description: "First line to read (default 1)" },
          num_lines: { type: "integer", description: "How many lines (default 80, at most 200)" },
        },
        required: ["corpus", "path"],
      },
      async run({ corpus, path, start_line, num_lines }) {
        const limit = Math.min(Number(num_lines) || 80, 200);
        const r = await bundle.readFile(corpus, String(path), { offset: Number(start_line) || 1, limit });
        if (!r) return `No file "${path}" in ${corpus}. Use a path exactly as returned by search.`;
        const body = r.text.split("\n").map((l, i) => `${r.start_line + i}: ${l}`).join("\n");
        return clip(`${r.path}, lines ${r.start_line}-${r.end_line} of ${r.total_lines}\n${body}`, 6000);
      },
    });
  }
  tools.push({
    name: "run_python",
    description: "Run Python code in the running 3D Slicer (SlicerWeb, Python 3 in the browser). Variables persist between calls. Returns printed output, the value of a final expression, and any error with its traceback.",
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: "Python code to run" } },
      required: ["code"],
    },
    async run({ code }) {
      if (!code || !String(code).trim()) return "No code given.";
      const r = await slicer.run(String(code));
      const parts = [r.ok ? `[ran in ${r.seconds} s]` : "[error]"];
      if (r.output) parts.push(clip(r.output.replace(/\s+$/, ""), maxChars));
      if (r.result != null) parts.push(`Value: ${clip(r.result, 1500)}`);
      if (r.ok && !r.output && r.result == null) parts.push("(no output; print() what you need to see)");
      return parts.join("\n");
    },
  });
  return tools;
}
