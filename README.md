# Slicerdome

Ask an AI model to work in 3D Slicer, in your browser. Slicerdome is a chat panel next to
[SlicerWeb](https://github.com/lassoan/SlicerWeb), the build of 3D Slicer that runs entirely in the
browser. The model you pick can:

- **search** Slicer's source code, the [Slicer forum](https://discourse.slicer.org) archive and
  Slicer's dependencies (CTK, vtkAddon, SlicerExecutionModel), through a static index;
- **read_file** from them;
- **run_python** in the Slicer next to the chat, and see the output, the value of the last line
  and any traceback. Python packages it imports are installed on the spot, and it can fetch
  public data, such as images from the [Imaging Data Commons](https://imaging.datacommons.cancer.gov).

So you can watch it load data, segment, measure and render, and see the code it ran. Drop your
own files or DICOM folders anywhere on the page to load them into Slicer.

**Try it: <https://pieper.github.io/Slicerdome/>** (Chrome or Edge; Safari 26 works too)

This is an early test. Bring your own key for a model provider: there is no shared account.

## Getting started

1. Open the page. SlicerWeb (about 70 MB) loads on the right, and a welcome note in the chat says
   how to get started, or, once there is a key, which model answers.
2. Open **Settings** and add a key from Anthropic, OpenRouter, or both. The **?** next to each
   provider says how to get one; OpenRouter (hundreds of models with one key) also has a sign-in
   button that makes a key for you.
3. Pick the model in the menu at the top, or find one with **Models**.
4. Ask, for example: *Load MRHead and show it with volume rendering using the MR-Default preset,
   with the slice planes hidden in 3D*, or *Load a chest CT from the Imaging Data Commons and
   tell me its voxel spacing.*

Keys stay in your browser (localStorage) and are sent only to the provider they belong to.
Messages, the code the model writes and Slicer's output go to the provider you pick; a notice
above the chat says which one. Models that run in the browser (WebGPU, through
[WebLLM](https://github.com/mlc-ai/web-llm)) send nothing anywhere, but they are much weaker, so
they are off unless turned on in Settings → **Models in this browser** (see below).

## Your data, packages and public data

- **Drop** files (NRRD, NIfTI, MetaImage, VTK, STL, OBJ, segmentations, markups, MRB scenes, ...)
  or a folder of DICOM files anywhere on the page, on the chat or on Slicer's views. DICOM files
  are sorted into series and each series becomes a volume named like desktop Slicer names it;
  the chat lists what was loaded. The files are copied into the browser's memory, not uploaded;
  what the model then sees of them is what it reads with its code.
- **Python packages**: when the model's code imports a package that is not installed (or calls
  `slicer.util.pip_install`), the page installs it, from Pyodide's builds or as a pure-Python
  wheel from PyPI, and runs the code again. pandas, scipy, matplotlib, nibabel, pydicom, duckdb,
  pyarrow and requests install this way; packages with compiled code that Pyodide has not built
  (SimpleITK, scikit-image, torch) cannot.
- **[SKILL.md](SKILL.md)** is the guide the model gets with its instructions: how this Slicer
  differs from desktop Slicer, installing packages, downloading, loading DICOM, and getting
  series from the Imaging Data Commons (its index is queried with duckdb, and the files come
  straight from IDC's public buckets). Edit it to teach the models more about this setup.

## Keys and safety

Use keys you can afford to lose: give each a low credit or spend limit and an expiry date (the
**?** in Settings shows how for each provider), and remove them from Settings when you are done.

- Keys are kept in this browser's storage for the site's origin. GitHub Pages serves all of an
  account's project sites from one origin (`pieper.github.io`), so pages of other sites published
  from the same account could read them.
- The model runs Python in SlicerWeb, which shares the page's origin, so code it writes could read
  the stored keys and send them elsewhere. Text it reads (forum posts, files you load) could try to
  steer it into doing that. Watch the code it runs; it is shown in the chat.

Both would go away with a site of its own origin, and with SlicerWeb on a separate origin (which
needs SlicerWeb to accept commands by message).

## What it costs

The toolbar shows what this browser tab has spent so far as the fewest US bills and coins that
make it up, coins at their real relative sizes and a part of a penny as a pie (hover for the
amount, each model and the current chat), and each answer ends with the cost of that request. Claude costs are estimated from list
prices; OpenRouter reports what it charged. **Cost limit** in Settings (default $0.50) stops a
request once it has cost that much.

On the forum-style tasks below, a task cost about $0.0015 with Claude Haiku 5.5, $0.017 with
Sonnet 5.5 and $0.023 with Opus 5.5.

## Choosing a model

**Models** opens a picker over OpenRouter's models that can call tools. Search by name, maker or
description; filter by maker, open weights, price, speed, image input and use for coding; sort by
use, price, speed, [Artificial Analysis](https://artificialanalysis.ai) scores, or results on this
project's own Slicer tasks. Those results are buttons (for example *hard 21/23*): they open a
dashboard of every task the model passed and failed, how each failure happened, and what the test
cost. Picking a model switches the chat to it through OpenRouter.

**Benchmarks** puts every model tested here side by side, one test at a time (easy or hard tasks,
12 or 25 steps): tasks passed, cost, time and steps per task, failed tool calls, and what the whole
test cost and took. Sort the table by any column, or switch to a chart of any two of these, for
example tasks passed against cost per task, with a line through the models that no other model
beats on both. Click a model or a point for its task-by-task dashboard. The results so far were measured
before [SKILL.md](SKILL.md) was added to the instructions.

Claude models can also be used directly with an Anthropic key (Settings → Claude). Other
OpenAI-compatible endpoints (Jetstream2, Azure AI Foundry, Ollama, LM Studio, vLLM) are set up in
Settings and chosen in the menu.

## Run it yourself

```sh
git clone https://github.com/pieper/Slicerdome && cd Slicerdome
gh release download index-2026-11-07 -R pieper/Slicerdome -p index-bundle.tar.gz
mkdir bundle && tar -xzf index-bundle.tar.gz -C bundle
node dev-server.mjs --bundle bundle
open http://localhost:8795/
```

The dev server serves the page and SlicerWeb from the same origin (SlicerWeb only lets pages of
its own origin reach its Python): it fetches SlicerWeb from lassoan.github.io on first use and
keeps a copy in `~/.cache/slicerdome`. The published site holds its own copy, added by
`.github/workflows/pages.yml`.

`?index=URL` points the page at another index, `?provider=claude:claude-haiku-5-5` or
`?provider=remote:openrouter` preselects a model.

## How it fits together

```
index.html, src/app.js   page, settings, rendering
src/agent.js             the agent loop and its instructions (SKILL.md is added to them)
SKILL.md                 the guide to this Slicer that the model gets (packages, downloads, IDC)
src/providers.js         LocalProvider (WebLLM) and RemoteProvider (OpenAI chat completions)
src/claude.js            ClaudeProvider (Anthropic Messages API, official SDK, prompt caching)
src/qwen-tools.js        Qwen3.5's tool-call format for the local models
src/local-llm.js         WebLLM engine in a Web Worker (src/llm-worker.js), model list
src/tools.js             search / read_file / run_python, and the example retriever
src/slicer.js            SlicerBridge: runs Python in SlicerWeb (installing missing packages),
                         scene summary, reset, loading dropped files
src/drop.js              takes files and folders dropped anywhere on the page
src/models.js            the model picker (OpenRouter's model list)
src/scores.js            the dashboard of a model's results on the Slicer tasks (bench/scores.json)
src/bench.js             the Benchmarks dialog: all tested models as a sortable table or a chart
src/us-cash.js           an amount as US bills and coins in SVG, and the <us-cash> element; no
                         dependencies, so it can become a library of its own (test/us-cash.test.mjs)
src/help.js              the instructions behind the ? buttons in Settings
static-index/src/        the search index client (HTTP range reads, BM25 and embeddings)
dev-server.mjs           local server: this directory, the index, SlicerWeb from the same origin
bench/                   speed benchmark and task evaluation (headless Chrome)
.github/workflows/       publishes the site to GitHub Pages with SlicerWeb and the index
```

What the loop adds for small models (Settings → Help; on for local models by default):

- each message carries a short **scene summary** (loaded volumes, segmentations, markups), for
  every provider, so the model works with what is loaded instead of loading it again;
- the request is searched in the **script repository** and the best examples are attached;
- when code fails, the error is **searched** and examples attached; for "X has no attribute Y"
  the Python side also checks what the node holds (`volume.GetImageData().GetDimensions()`);
- a call identical to one that failed is not run again; after that the next reply is sampled at a
  higher temperature, and the task stops if the model keeps repeating itself;
- tool output is clipped harder for local models (prefill is their bottleneck).

## Local models

Speed, measured on an Apple M4 MacBook Air (16 GB), Chrome 156, WebLLM 0.2.87, 4-bit weights:

| Model | Download | Prefill | Time to first token at 8k tokens | Decode (short / 8k context) |
|---|---|---|---|---|
| Qwen3.5 2B | 1.1 GB | 390–480 tok/s | 20 s | 34 / 13 tok/s |
| Qwen3.5 4B | 2.4 GB | 160–200 tok/s | 48 s | 17 / 8.6 tok/s |
| Qwen3.5 9B | 5.0 GB | 105–120 tok/s | 74 s | 9.4 / 6.6 tok/s |

WebLLM keeps the conversation's KV cache between steps, so a step only prefills what is new (a
follow-up turn started in 0.1–0.4 s). `bench/run-speed.mjs` repeats these measurements.

## How well they do

`bench/tasks.mjs` has ten Discourse-style requests, each checked against Slicer's state or the
numbers in the answer. One run each in headless Chrome on the same M4 Air, with the loop's help
on and at most 12 steps:

| Task | 2B | 4B | 9B |
|---|---|---|---|
| Load MRHead, report dimensions and spacing | fail | pass, 33 s | fail (spacing wrong), 55 s |
| Mean and maximum voxel value | fail | pass, 22 s | pass, 42 s |
| Set window 200 / level 100 | fail | fail | pass, 39 s |
| Place a point named Target at (10, -20, 30) | fail | fail (not named) | pass, 390 s |
| Show only the 3D view | fail | fail | pass, 301 s |
| Threshold 100–300 into a segment, count voxels | fail | fail | fail (count right, segment not made) |
| Volume of an existing segment in cc | fail | fail | fail |
| How to export segments to STL (code) | fail | fail | fail |
| Gaussian smoothing into a new volume | fail | fail | fail |
| Center of mass of voxels above 200 | fail | fail | fail |
| **Passed** | **0 / 10** | **2 / 10** (same in a second run) | **4 / 10** |
| Mean time per task | 86 s | 141 s | 256 s |
| Median time per model step | 7 s | 13 s | 18 s |

The 4B with thinking on passed 1 of the first 5 tasks at 27 s per step, so that run was stopped.

What the traces show:

- One-step scene edits work when an example or hint points the way. The "has no attribute" hint
  is what fixed `volume.GetDimensions()` → `volume.GetImageData().GetDimensions()`.
- Multi-step work fails on API details: the 9B computed the right voxel count in its first step,
  then spent nine minutes rewriting a 40-line script around a wrong segmentation call.
- None turned search results into an answer: on the STL question they kept searching and reading
  until the steps ran out, although the right method name came up early.
- Small models ignore context they are given: the 4B reloaded MRHead although the scene summary
  listed it, and repeated failing code until the loop stopped it.

The same ten tasks with Claude through the page (Anthropic API, default effort, loop help off,
one run each, 2026-11-10):

| | Claude Haiku 5.5 | Claude Sonnet 5.5 | Claude Opus 5.5 |
|---|---|---|---|
| Passed | 10 / 10 | 10 / 10 | 10 / 10 |
| Mean time per task | 5 s | 4.7 s | 5.2 s |
| Mean steps per task | 2.4 | 2.3 | 2.1 |
| Cost for all ten tasks | $0.005 | $0.08 | $0.13 |

(Haiku's centre-of-mass answer was first scored a failure because it wrote "−23.24" with a
typographic minus sign; the checker now reads those.) These tasks are too easy to tell the Claude
models apart.

The 23 harder tasks (`--set hard`, each modeled on a forum topic; see Evaluate below), same
settings (at most 12 steps, $0.50 cost limit per request), one run each, 2026-11-10:

| | Claude Haiku 5.5 | Claude Sonnet 5.5 | Claude Opus 5.5 |
|---|---|---|---|
| Passed | 21 / 23 | 22 / 23 | 23 / 23 |
| Mean time per task | 10.6 s | 9.7 s | 9.1 s |
| Mean steps per task | 4.4 | 3.1 | 2.3 |
| Failed tool calls (all tasks) | 13 | 3 | 0 |
| Cost for all 23 tasks | $0.035 | $0.38 | $0.52 |
| Most expensive task | $0.005 | $0.07 | $0.04 |

What failed:

- **Haiku, Otsu threshold:** its own Otsu code returned 194.5, but ITK's calculator and a direct
  histogram computation give 41–44. It noticed that 261 voxels was "far from a whole-head mask"
  and reported it anyway.
- **Haiku, segment outline:** it spent all 12 steps searching for the outline-thickness setting
  (`SetSliceIntersectionThickness`) and changed nothing.
- **Sonnet, model export:** `ExportSegmentToRepresentationNode` renames the model to the segment's
  name, so no model was named `BrightModel`. The area and volume it reported were right.

Two results were first scored as failures and then rescored after the checks were fixed:

- **Haiku's bounding box:** the box was exact, but it used the older Annotation ROI type, which the
  check did not accept.
- **Sonnet's mirror:** it resampled with linear interpolation onto the original grid, a correct
  mirror that the check's per-voxel tolerance rejected. The check now uses correlation: 0.93 for
  Sonnet's method, against 0.34 for mirroring about the wrong plane.

Both approaches are now extra reference solutions in the tasks.

Opus usually wrote one script that did the whole task and checked its own result. That is why it
needed the fewest steps, and its total cost was only 1.4× Sonnet's at twice the price per token.
Haiku got there by trial and error.

This run used corrected instructions. Before, they said Resample Scalar Volume was not available,
although it and seven other CLI modules work. They now also say that the desktop Segment Editor
cannot be scripted here and that scipy and SimpleITK are missing.

The same tasks with other models through OpenRouter (2026-11-11, one run each, each model at its
default reasoning effort; OpenRouter chose the host). The hard tasks were run with the usual 12
steps and, for the four best open models, again with 25:

| Model | Easy tasks | Hard, 12 steps | Hard, 25 steps | Cost per hard task | Time per hard task |
|---|---|---|---|---|---|
| Claude Opus 5.5 (Anthropic API) | 10 / 10 | 23 / 23 | | $0.023 | 9 s |
| Claude Sonnet 5.5 (Anthropic API) | 10 / 10 | 22 / 23 | | $0.017 | 10 s |
| Claude Haiku 5.5 (Anthropic API / OpenRouter) | 10 / 10 | 21 / 23, 23 / 23 | | $0.0014 | 10 s |
| Kimi K3 (open weights, 2.8T) | 9 / 10 | 21 / 23 | 22 / 23 | $0.048 / $0.050 | 31 / 36 s |
| MiniMax M3.1 Flash (open) | 7 / 10 | 16 / 23 | 22 / 23 | $0.0064 / $0.0095 | 49 / 81 s |
| Qwen3.8 Flash | 7 / 10 | 15 / 23 | 22 / 23 | $0.0066 / $0.0091 | 118 / 148 s |
| DeepSeek V4.1 Flash (open) | 9 / 10 | 15 / 23 | 21 / 23 | $0.0043 / $0.0043 | 27 / 37 s |
| GLM 5.3 (open) | 7 / 10 | 13 / 23 | | $0.020 | 54 s |
| Qwen3.8 27B (open) | 7 / 10 | 11 / 23 | | $0.026 | 75 s |
| Qwen3.5 9B (open) | 5 / 10 | 3 / 23 | | $0.0095 | 46 s |

(Two numbers: with 12 / 25 steps.) **Benchmarks** in the page sorts and charts these numbers;
clicking a model there, or a score in **Models**, shows each run task by task, with how each
failure happened.

- Haiku through OpenRouter did as well as through the Anthropic API, so the OpenRouter path does not
  hold models back.
- With 12 steps most open-model failures ran out of steps while fixing API mistakes
  (`slicer.getNodesByClass`, `slicer.appApplicationLogic()`, numpy 2's missing `ptp`); they made
  36–106 failed tool calls on the hard tasks, against 0–13 for Claude. Given 25 steps the best of
  them got there: MiniMax, Qwen3.8 Flash and Kimi K3 passed 22 of 23 and DeepSeek 21, but they
  needed 6–14 steps a task against Claude's 2–4.
- None was cheaper per task than Haiku, although their prices per token are similar: more steps
  mean more input, and most reason at length by default. DeepSeek V4.1 Flash came closest (3 times
  Haiku's cost, 3–4 times slower); Kimi K3 cost twice as much as Claude Opus.
- Wrong answers were often reported as success: a segmentation the model never made, a mask built
  with transposed axes, an ROI of the legacy `vtkMRMLROINode` class, a crop renamed "MRHead" by
  `newNode.Copy(vol)`, a voxel spacing of 1 × 1 × 1 read from `GetImageData().GetSpacing()` (the
  image data's spacing is always 1; the volume node's is 1 × 1 × 1.3).
- Twice a model spent its whole reply (16k tokens) reasoning and the loop took the empty reply as
  the answer; the loop now asks again instead. One result was rescored as a pass after a fix to its
  check (GLM's masked volume: a failed first attempt had left an empty `MRHeadMasked` ahead of the
  correct one); replaying every other failed run's code against a fresh scene gave the same
  failures.
- Qwen3.5 9B, the model run in the browser above, passed 5 of the 10 easy tasks this way (4 in
  the browser at 4 bits).

So the models that run in the browser are off by default (Settings → **Models in this browser**);
turned on, **Qwen3.5 9B** is the best of them, and anything beyond a simple scene edit is a job for
a remote model. The local models fit better as a fallback for simple requests, or for roles that
need no planning (screening what goes to a remote model, rewriting search queries).

## Evaluate

```sh
node bench/eval.mjs --profile /tmp/chrome-eval --provider local:Qwen3.5-4B-q4f16_1-MLC --out results.json
python3 bench/show.py results.json          # step-by-step trace
```

`--set hard` runs the 23 harder tasks in `bench/tasks-hard.mjs` instead. Each one is modeled on a
forum topic (linked in the task) and needs several steps: coordinates under transforms, segment
editing without the desktop Segment Editor, labelmap export with given label values, cropping,
resampling, slice reformatting, display settings. Each task also has a reference solution, and
some have a plausible wrong one. `bench/selftest.mjs` checks the tasks themselves, without a
model: the judge must fail a run that does nothing, pass the reference solution, and fail the
wrong one:

```sh
node bench/selftest.mjs --profile /tmp/chrome-eval --set hard
```

The Chrome profile keeps the downloaded model weights, so reuse it between runs. The same
runner works for remote models (`--provider remote:openrouter`, after saving a key in that
profile's settings) and for Claude, with the key taken from the environment and the cost of each
task recorded:

```sh
ANTHROPIC_API_KEY=sk-ant-... node bench/eval.mjs --profile /tmp/chrome-eval \
    --provider claude:claude-haiku-5-5 --out haiku.json      # --effort low|medium|high, --cost-limit 1
```

OpenRouter models work the same way, with any model id from [openrouter.ai/models](https://openrouter.ai/models):

```sh
OPENROUTER_API_KEY=sk-or-... node bench/eval.mjs --profile /tmp/chrome-eval \
    --provider remote:openrouter --model qwen/qwen3.8-flash --out qwen.json
```

On OpenRouter the page leaves sampling settings and reasoning effort at each model's defaults
(unless `--effort` is given), sends the model's reasoning back with each tool result, and
records the cost OpenRouter reports for each step and which host served it. One model id is
often served by several hosts at different quantizations; OpenRouter picks the host.

## Known limits

- SlicerWeb runs Python on the page's main thread. A long computation freezes the page until it
  finishes; the cell's own Python code is stopped after 60 s, but a long call into a library is not.
- Reloading the SlicerWeb frame a few minutes after it first started sometimes never finishes
  starting (seen in headless Chrome; the evaluation resets the scene instead of reloading).
- The weights are kept in the browser's Cache Storage, and Chrome lets a page use only part of
  the disk's free space (a fresh profile got 10.7 GB with 16 GB free). On a nearly full disk the
  download stops with "Quota exceeded"; the page now checks the room first and says so. A Chrome
  that had been running for days refused after 230 MB although a fresh profile on the same disk
  stored all of the 9B, so its idea of the free space can be out of date.
- An exception inside an ITK filter ends SlicerWeb's Python, and the page has to be reloaded. For
  example, `vtkITKIslandMath` on an 8-bit image with more than 255 islands does this; desktop
  Slicer raises a Python exception instead. The instructions warn the model; the evaluation
  reopens the page when it happens.
- No PHI screen yet: with a remote provider, prompts, code and tool output go to that provider.
- Everything loaded or downloaded is held in the browser's memory, so very large series or many
  of them can run it out; prefer small series from IDC.
- The model cannot see the views yet (no screenshot tool).
- SlicerLive (TypeScript) is not connected yet.

## License and credits

Slicerdome is under the [Apache License 2.0](LICENSE).

- [SlicerWeb](https://github.com/lassoan/SlicerWeb) is by Andras Lasso and contributors, under the
  [3D Slicer license](https://github.com/lassoan/SlicerWeb/blob/main/LICENSE). The published site
  serves an unmodified copy of its [published build](https://github.com/lassoan/slicerweb-app)
  (with that license, at `slicerweb/SLICERWEB-LICENSE.txt`); this repository does not contain it.
- The search index is built from [Slicer](https://github.com/Slicer/Slicer),
  [CTK](https://github.com/commontk/CTK), vtkAddon and SlicerExecutionModel sources and from the
  public [archive of the Slicer forum](https://github.com/pieper/slicer-discourse-archive). It is
  published as a release asset of this repository; search results link back to the sources.
- The page loads the Anthropic TypeScript SDK, WebLLM and transformers.js from jsDelivr.
