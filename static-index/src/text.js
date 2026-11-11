// Text handling that must match the Python side exactly: the BM25 tokenizer
// (scripts/bm25_lib.py), str.splitlines(), and the snippet rules used by the
// local MCP server. Differences here would change scores or line numbers, so
// test/parity.test.mjs checks them against output produced by Python.

// Python's `\d` (str patterns) matches any Unicode decimal digit; JS `\d`
// only matches ASCII, so use \p{Nd} with the u flag.
const WORD_RE = /[A-Za-z][A-Za-z0-9_]*|\p{Nd}+/gu;
const CAMEL_RE = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\p{Nd}+/gu;
const HAS_UPPER = /[A-Z]/;
const HAS_LOWER = /[a-z]/;

// Same rewrites as bm25_lib._LANG_ALIAS_RE. Python's \b is Unicode-aware, so
// emulate it with explicit word-character lookarounds.
const LANG_ALIASES = [
  [/(?<![A-Za-z])C\+\+/g, " Cplusplus "],
  [/(?<![A-Za-z])C#/g, " Csharp "],
  [/(?<![A-Za-z])F#/g, " Fsharp "],
  [/(?<![\p{L}\p{N}_])Objective-?C(?![\p{L}\p{N}_])/gu, " ObjectiveC "],
];

/** BM25 tokenizer; identical output to bm25_lib.tokenize(). */
export function tokenize(text) {
  for (const [re, replacement] of LANG_ALIASES) text = text.replace(re, replacement);
  const out = [];
  for (const m of text.matchAll(WORD_RE)) {
    const w = m[0];
    const wl = w.toLowerCase();
    out.push(wl);
    if (w.includes("_")) {
      for (const part of w.split("_")) if (part) out.push(part.toLowerCase());
    }
    if (HAS_UPPER.test(w) && HAS_LOWER.test(w)) {
      for (const sub of w.matchAll(CAMEL_RE)) {
        const sl = sub[0].toLowerCase();
        if (sl && sl !== wl) out.push(sl);
      }
    }
  }
  return out;
}

// Python str.splitlines() boundaries.
const LINE_SPLIT_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** Python str.splitlines() (no keepends). */
export function pySplitlines(text) {
  if (!text) return [];
  const parts = text.split(LINE_SPLIT_RE);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// Characters for which Python's str.isspace() is true (what strip() removes).
const PY_BLANK_RE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;

/** Python `not line.strip()`. */
export function pyIsBlank(line) {
  return PY_BLANK_RE.test(line);
}

/**
 * Same as bm25_lib._best_snippet: the line with the most distinct query
 * tokens, and a window of nLines around it. Returns [1-based line, text].
 */
export function bestSnippet(text, queryTokens, nLines = 5) {
  const lines = pySplitlines(text);
  if (!lines.length) return [0, ""];
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    if (pyIsBlank(lines[i])) continue;
    let s = 0;
    for (const t of new Set(tokenize(lines[i]))) if (queryTokens.has(t)) s++;
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) {
    bestIdx = lines.findIndex((l) => !pyIsBlank(l));
    if (bestIdx < 0) return [0, ""];
  }
  const half = Math.floor(nLines / 2);
  let start = Math.max(0, bestIdx - half);
  const end = Math.min(lines.length, start + nLines);
  start = Math.max(0, end - nLines);
  return [bestIdx + 1, lines.slice(start, end).join("\n")];
}

/** Same as vector_lib._read_lines: up to maxLines of a chunk's line range. */
export function readLines(text, lineStart, lineEnd, maxLines = 8) {
  const lines = pySplitlines(text);
  if (!lines.length) return "";
  const start = Math.max(0, lineStart - 1);
  const end = Math.min(lines.length, start + Math.min(maxLines, lineEnd - lineStart + 1));
  return lines.slice(start, end).join("\n");
}
