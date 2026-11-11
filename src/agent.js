// The agent loop: ask the model, run the tools it calls, feed the results back, until it answers
// without calling a tool or runs out of steps. Everything runs in the page.

export const INSTRUCTIONS = `You are an assistant inside 3D Slicer, which is running in the user's web browser (SlicerWeb). You do 3D Slicer tasks by writing Python and running it in the live session with run_python, and you look up how to do things with search and read_file.

About this Slicer:
- Python 3 in the browser, with slicer, vtk, numpy, qt and slicer.util. Variables persist between run_python calls.
- Load sample data with: import SampleData; volume = SampleData.SampleDataLogic().downloadSample("MRHead")  (other names include "CTChest", "CTACardio", "MRBrainTumor1").
- Not available here: scipy, SimpleITK, scikit-image, pandas, the DICOM database, file dialogs, installing extensions from Python, and most CLI modules (for example N4 bias correction, BRAINSFit). These CLI modules do work, with slicer.cli.runSync: Resample Scalar Volume, Gaussian Blur, Median, Threshold, Mask, Cast, Add and Subtract Scalar Volumes, Grayscale Model Maker.
- The Segment Editor cannot be scripted the desktop way (qMRMLSegmentEditorWidget has no activeEffect()). Change segments with numpy (arrayFromSegmentBinaryLabelmap, updateSegmentBinaryLabelmapFromArray) or VTK and vtkITK filters.
- An exception inside an ITK filter ends this Python session, so check filter inputs first (for example, give vtkITKIslandMath an unsigned int image).

How to work:
- For anything you are not sure about, search before writing code: corpus "source" has Slicer's code and the script repository examples (Docs/developer_guide/script_repository/*.md); corpus "discourse" has forum answers.
- Prefer slicer.util helpers: getNode, getNodesByClass, arrayFromVolume, updateVolumeFromArray, arrayFromSegmentBinaryLabelmap.
- Keep each run_python call short and print() the values you need. If it fails, read the error and change the code; never resend code that failed.
- When the task is done, stop calling tools and answer briefly with the result, including numbers with units.`;

const est = (s) => Math.ceil((s?.length ?? 0) / 3);

/** A search query for an error in run_python output, or null. */
export function errorQuery(output) {
  const attr = /'(?:\w+\.)?(\w+)' object has no attribute '(\w+)'/.exec(output);
  if (attr) return `${attr[1]} ${attr[2]}`;
  const name = /NameError: name '(\w+)' is not defined/.exec(output);
  if (name) return name[1];
  const mod = /(?:ModuleNotFoundError|ImportError): .*?'([\w.]+)'/.exec(output);
  if (mod) return `import ${mod[1]}`;
  const last = output.trim().split("\n").pop();
  return /Error/.test(last) ? last.replace(/^\w+Error:\s*/, "").slice(0, 120) : null;
}

export class Agent {
  /**
   * provider: LocalProvider | RemoteProvider | ClaudeProvider; tools: from makeTools(); onEvent(event) gets
   * {type: "model", step, reply} | {type: "delta", text, thinking} | {type: "tool", call, result, seconds}
   * | {type: "error", message} | {type: "done", text, stopped}
   */
  /**
   * retrieve(query) -> formatted example snippets (makeRetriever); with `assist`, the loop adds
   * examples for the request and for errors itself, and breaks loops of a repeated failing call.
   */
  /** costLimit: stop a request before running more tools once its replies cost this many US$ (providers that report cost). */
  constructor({ provider, tools, instructions = INSTRUCTIONS, maxSteps = 12, thinking = false, contextTokens = 16384, retrieve = null, assist = false, scene = null, costLimit = null, onEvent = () => {} }) {
    Object.assign(this, { provider, tools, instructions, maxSteps, thinking, contextTokens, retrieve, assist, scene, costLimit, onEvent });
    this.messages = [];
    this.log = [];
    this.failed = new Set();
    this.done = new Set();
  }

  emit(event) {
    this.log.push({ t: new Date().toISOString(), ...event });
    this.onEvent(event);
  }

  /** Keep a local model's transcript inside its context window by blanking old tool results. */
  compact() {
    if (!this.provider.local) return;
    const budget = this.contextTokens * 0.7 - est(this.instructions) - 1500;
    let total = this.messages.reduce((n, m) => n + est(m.raw ?? m.content), 0);
    const toolIdx = this.messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0).slice(0, -2);
    for (const i of toolIdx) {
      if (total <= budget) break;
      const m = this.messages[i];
      if (m.content.startsWith("[result removed")) continue;
      total -= est(m.content);
      m.content = `[result removed to save space; it was ${m.content.length} characters]`;
    }
  }

  async send(text, { signal } = {}) {
    // Repeats are judged within one request: later requests may rightly rerun the same code.
    this.failed = new Set();
    this.done = new Set();
    let content = text;
    if (this.scene) {
      try {
        const summary = await this.scene();
        if (summary) content = `${text}\n\n<scene>\nCurrently loaded in Slicer (added automatically):\n${summary}\n</scene>`;
      } catch (e) {
        console.warn("scene summary failed", e);
      }
    }
    if (this.assist && this.retrieve) {
      try {
        const examples = await this.retrieve(text);
        if (examples) {
          content = `${content}\n\n<examples>\nExamples from Slicer's documentation and code that may help (found automatically):\n\n${examples}\n</examples>`;
          this.emit({ type: "context", text: examples });
        }
      } catch (e) {
        console.warn("retrieval failed", e);
      }
    }
    this.messages.push({ role: "user", content });
    this.emit({ type: "user", text });
    let temperature = null;
    let repeats = 0;
    let spent = 0;
    const maxCalls = this.provider.local ? 3 : 6;
    for (let step = 1; step <= this.maxSteps; step++) {
      if (signal?.aborted) return this.finish("", true);
      this.compact();
      let reply;
      try {
        reply = await this.provider.complete({
          messages: this.messages, tools: this.tools, instructions: this.instructions, signal, thinking: this.thinking, temperature,
          onDelta: (t, th) => this.onEvent({ type: "delta", text: t, thinking: th }),
        });
      } catch (e) {
        if (signal?.aborted || e.name === "AbortError") return this.finish("", true);
        this.emit({ type: "error", message: String(e.message ?? e) });
        return this.finish("", true);
      }
      if (signal?.aborted) return this.finish("", true); // never act on an interrupted reply
      this.messages.push({ role: "assistant", content: reply.text, calls: reply.calls, raw: reply.raw, thinking: reply.thinking, reasoningDetails: reply.reasoningDetails });
      this.emit({ type: "model", step, reply: { text: reply.text, thinking: reply.thinking, calls: reply.calls, problems: reply.problems, finish: reply.finish, usage: reply.usage, cost: reply.cost, served: reply.served, timings: reply.timings } });
      spent += reply.cost ?? 0;

      if (!reply.calls.length) {
        if (reply.problems.length && step < this.maxSteps) {
          this.messages.push({ role: "user", content: `${reply.problems.join("\n")}\nWrite the tool call again in the required format.` });
          continue;
        }
        if (!reply.text && /^(length|max_tokens)$/.test(reply.finish ?? "") && step < this.maxSteps) {
          // The reply was all reasoning and ran out of room before an answer or a tool call.
          // It is dropped (an empty assistant turn is not accepted everywhere) and the model asked again.
          this.messages.pop();
          this.messages.push({ role: "user", content: "Your reply reached the length limit before any answer or tool call. Think less: make the next tool call now, or answer." });
          continue;
        }
        return this.finish(reply.text, false);
      }
      if (this.costLimit && spent >= this.costLimit) {
        return this.finish(`Stopped: this request has cost about $${spent.toFixed(2)}, which reached the limit set in Settings ($${this.costLimit}).`, true);
      }
      temperature = null;
      let repeated = false;
      for (const [i, call] of reply.calls.entries()) {
        const t0 = performance.now();
        let result;
        const tool = this.tools.find((t) => t.name === call.name);
        const key = `${call.name}:${JSON.stringify(call.args)}`;
        if (i >= maxCalls) result = "Skipped: call a few tools at a time and look at the results first.";
        else if (call.invalid) result = `[error] ${call.invalid}`;
        else if (!tool) result = `There is no tool "${call.name}". The tools are: ${this.tools.map((t) => t.name).join(", ")}.`;
        else if (this.failed.has(key)) {
          repeated = true;
          result = "[error] This is the same call that already failed, so it was not run again. Read the error above and change the code, or search for how to do it.";
        } else if (this.done.has(key)) {
          repeated = true;
          result = "You already made this exact call and its result is above. Use that result, or do something different. If you have what you need, answer the user.";
        } else {
          this.done.add(key);
          try {
            result = await tool.run(call.args ?? {});
          } catch (e) {
            result = `[error] ${e.message ?? e}`;
          }
          if (result.startsWith("[error]")) {
            this.failed.add(key);
            const query = this.assist && this.retrieve && call.name === "run_python" ? errorQuery(result) : null;
            if (query) {
              try {
                const examples = await this.retrieve(query, { n: 2, maxLines: 14 });
                if (examples) result += `\n\nExamples from Slicer's code for "${query}" (found automatically):\n\n${examples}`;
              } catch {}
            }
          }
        }
        this.messages.push({ role: "tool", callId: call.id, name: call.name, content: result });
        this.emit({ type: "tool", call, result, seconds: (performance.now() - t0) / 1000 });
        if (signal?.aborted) return this.finish("", true);
      }
      if (repeated && this.assist) {
        // The same context gives the same reply at a low temperature; sample more widely once,
        // and give up if the model still repeats itself.
        repeats++;
        if (repeats >= 3) return this.finish("Stopped: the model kept repeating code that had already failed.", true);
        temperature = 0.9;
      }
    }
    return this.finish("Stopped after the maximum number of steps.", true);
  }

  finish(text, stopped) {
    this.emit({ type: "done", text, stopped });
    return { text, stopped };
  }

  transcript() {
    return { provider: this.provider.label, instructions: this.instructions, messages: this.messages, log: this.log };
  }
}
