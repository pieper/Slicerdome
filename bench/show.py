#!/usr/bin/env python3
"""Print an eval results file (bench/eval.mjs --out) as a readable trace: python3 bench/show.py results.json [task-id ...]"""
import json, sys
r = json.load(open(sys.argv[1]))
only = set(sys.argv[2:])
print(r.get("provider"), "thinking" if r.get("thinking") else "", "assist", r.get("assist"), "load", r.get("load_s"), "summary", r.get("summary"))
for t in r["tasks"]:
    if only and t["id"] not in only:
        continue
    print("=====", t["id"], "PASS" if t["pass"] else "FAIL", t["why"], "| %.0f s, %d steps, %s" % (t["seconds"], t["steps"], t["used"]))
    for e in t["log"]:
        if e["type"] == "model":
            rp = e["reply"]; tm = rp.get("timings") or {}; u = rp.get("usage") or {}
            print("  [step %s] %.1f s, %s in / %s out%s" % (e["step"], tm.get("seconds", 0), u.get("prompt_tokens"), u.get("completion_tokens"), " PROBLEMS %s" % rp["problems"] if rp.get("problems") else ""))
            if rp.get("thinking"): print("     think:", rp["thinking"][:300].replace("\n", " | "))
            if rp.get("text"): print("     text:", rp["text"][:500].replace("\n", " | "))
            for c in rp.get("calls", []): print("     call:", c["name"], json.dumps(c["args"])[:400])
        elif e["type"] == "tool":
            print("  [%s %.1f s] %s" % (e["call"]["name"], e["seconds"], e["result"][:400].replace("\n", " | ")))
        elif e["type"] == "context":
            print("  [examples] %s" % " ".join(l for l in e["text"].split("\n") if l.startswith("From ")))
        elif e["type"] == "error":
            print("  [error]", e["message"][:300])
    if t.get("answer"): print("  ANSWER:", t["answer"][:300].replace("\n", " | "))
