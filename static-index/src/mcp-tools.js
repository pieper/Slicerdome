// Tool definitions over a Bundle, independent of transport: the Node MCP
// server (bin/) registers them over stdio, and an in-browser agent can hand
// the same JSON Schemas to a model as function-calling tools.

const SEARCH_DESCRIPTION = (label) => `Ranked search over ${label}.

Three modes are available — pick by the *shape* of your query:

  mode="lexical"   BM25 over tokenized text. Fast, deterministic. Best when
                   the query is or contains a concrete identifier, symbol,
                   path, error string, or rare keyword (e.g. 'vtkMRMLScalarVolumeNode',
                   'arrayFromVolume', 'CMAKE_PREFIX_PATH').

  mode="vector"    Dense embeddings (sentence-transformers/all-MiniLM-L6-v2).
                   Best for conceptual or paraphrased queries where the answer
                   probably uses different words than the question (e.g. 'how
                   do I draw a bounding box around the lesion', 'why does my
                   volume look flipped after export').

  mode="hybrid"    Reciprocal Rank Fusion of both signals; the safe default
                   when you don't know which side will fire. Honors
                   \`lexical_weight\` and \`vector_weight\` (defaults 1.0 each).

  mode="auto"      Hybrid when vector search is available, else lexical.
                   This is the default.

Returns top-K matches as {path, url, score, line, snippet}. Call read_file
with this corpus and a result's path to read the whole file.`;

function ok(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function err(message) {
  return JSON.stringify({ error: message });
}

/** [{name, description, inputSchema (JSON Schema), handler(args) -> string}] */
export function toolSpecs(bundle) {
  const names = bundle.corpusNames;
  const tools = [];
  for (const name of names) {
    const info = bundle.manifest.corpora[name];
    tools.push({
      name: `search_${name}`,
      description: SEARCH_DESCRIPTION(info.label || name),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for" },
          top_k: { type: "integer", default: 10, description: "Number of results (1-50)" },
          mode: { type: "string", enum: ["auto", "lexical", "vector", "hybrid"], default: "auto" },
          lexical_weight: { type: "number", default: 1.0 },
          vector_weight: { type: "number", default: 1.0 },
        },
        required: ["query"],
      },
      handler: async (a) => {
        try {
          return ok(await bundle.search(name, a.query, {
            topK: a.top_k ?? 10,
            mode: a.mode ?? "auto",
            lexicalWeight: a.lexical_weight ?? 1,
            vectorWeight: a.vector_weight ?? 1,
          }));
        } catch (e) {
          return err(`${e.name}: ${e.message}`);
        }
      },
    });
  }
  tools.push({
    name: "read_file",
    description:
      "Read a file from one of the indexed corpora, by the corpus name and the `path` " +
      "returned by a search_* tool. Returns numbered-line metadata and the text of " +
      "lines [offset, offset + limit). Use it to read the full context around a search hit.",
    inputSchema: {
      type: "object",
      properties: {
        corpus: { type: "string", enum: names },
        path: { type: "string", description: "Path relative to the corpus root, as returned by search" },
        offset: { type: "integer", default: 1, description: "First line to return (1-based)" },
        limit: { type: "integer", default: 400, description: "Maximum number of lines" },
      },
      required: ["corpus", "path"],
    },
    handler: async (a) => {
      try {
        const r = await bundle.readFile(a.corpus, a.path, { offset: a.offset ?? 1, limit: a.limit ?? 400 });
        return r ? ok(r) : err(`no file ${a.path} in ${a.corpus}`);
      } catch (e) {
        return err(`${e.name}: ${e.message}`);
      }
    },
  });
  tools.push({
    name: "list_files",
    description:
      "List file paths in a corpus that contain a substring, or match a glob " +
      "('Modules/Scripted/*/*.py', '**/vtkMRMLMarkups*.h'). Use it to find a file " +
      "when you know roughly its name or location.",
    inputSchema: {
      type: "object",
      properties: {
        corpus: { type: "string", enum: names },
        pattern: { type: "string", default: "" },
        limit: { type: "integer", default: 200 },
      },
      required: ["corpus"],
    },
    handler: async (a) => {
      try {
        return ok(await bundle.listFiles(a.corpus, a.pattern ?? "", a.limit ?? 200));
      } catch (e) {
        return err(`${e.name}: ${e.message}`);
      }
    },
  });
  tools.push({
    name: "index_status",
    description:
      "Report which corpora the index has, their source commits, segment ids, when " +
      "the index was generated, and cache statistics.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ok(bundle.status()),
  });
  return tools;
}
