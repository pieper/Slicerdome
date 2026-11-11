// Talking to SlicerWeb's Python. SlicerWeb exposes `window.slicerWeb` to pages of its own origin,
// so the chat page embeds a copy served from the same origin (see dev-server.mjs) and calls it
// through the iframe's window.

// Runs the agent's code in __main__ (so variables persist between calls), captures stdout,
// stderr and warnings from logging, and returns the value of a trailing expression like a
// notebook cell. The result comes back base64-encoded JSON, because SlicerWeb returns the repr
// of an eval and that is easy to decode only for plain ASCII.
const HELPER = String.raw`
def __agent_attr_hint(e):
    # For "X has no attribute Y": a method of that name on what X holds (a volume node's image
    # data, a node's display node, ...) or a close spelling. Small models often call vtkImageData
    # methods on a volume node and the like.
    import difflib
    obj, name = getattr(e, "obj", None), getattr(e, "name", None)
    if obj is None or not name:
        return None
    try:
        names = dir(obj)
    except Exception:
        return None
    found = []
    for acc in names:
        if not acc.startswith("Get") or not acc.endswith(("Node", "Data", "Segmentation", "Mesh", "Camera", "Renderer")):
            continue
        try:
            held = getattr(obj, acc)()
        except Exception:
            continue
        if held is not None and hasattr(held, name):
            found.append(f".{acc}().{name}")
        if len(found) >= 3:
            break
    close = difflib.get_close_matches(name, names, n=3, cutoff=0.75)
    parts = []
    if found:
        parts.append(f"{type(obj).__name__} has no {name}, but these do: " + ", ".join(found))
    if close:
        parts.append("Similar names: " + ", ".join(close))
    return "Hint: " + ". ".join(parts) if parts else None

def __agent_scene():
    # What a user sees in the Data module: the nodes they would refer to, briefly.
    import slicer
    kinds = [("vtkMRMLLabelMapVolumeNode", "labelmap volume"), ("vtkMRMLScalarVolumeNode", "volume"),
             ("vtkMRMLVolumeNode", "volume"), ("vtkMRMLSegmentationNode", "segmentation"), ("vtkMRMLModelNode", "model"),
             ("vtkMRMLMarkupsNode", "markups"), ("vtkMRMLTransformNode", "transform"), ("vtkMRMLTableNode", "table"),
             ("vtkMRMLSequenceNode", "sequence")]
    lines = []
    scene = slicer.mrmlScene
    for i in range(scene.GetNumberOfNodes()):
        n = scene.GetNthNode(i)
        if n.GetHideFromEditors():
            continue
        kind = next((k for c, k in kinds if n.IsA(c)), None)
        if kind is None:
            continue
        info = ""
        try:
            if kind.endswith("volume") and n.GetImageData():
                d = n.GetImageData().GetDimensions()
                sp = n.GetSpacing()
                info = f", {d[0]}x{d[1]}x{d[2]} voxels, spacing {sp[0]:.3g}x{sp[1]:.3g}x{sp[2]:.3g} mm"
            elif kind == "segmentation":
                seg = n.GetSegmentation()
                names = [seg.GetNthSegment(j).GetName() for j in range(seg.GetNumberOfSegments())]
                info = f", segments: {', '.join(names) if names else 'none'}"
            elif kind == "markups":
                info = f", {n.GetClassName().replace('vtkMRMLMarkups', '').replace('Node', '') or 'markups'}, {n.GetNumberOfControlPoints()} points"
        except Exception:
            pass
        lines.append(f'- {kind} "{n.GetName()}" ({n.GetID()}{info})')
        if len(lines) >= 25:
            lines.append("- ...")
            break
    return "\n".join(lines) if lines else "The scene is empty."

def __agent_run(b64, limit=60):
    import ast, base64, io, json, linecache, logging, sys, time, traceback
    src = base64.b64decode(b64).decode("utf-8")
    name = "<cell>"
    linecache.cache[name] = (len(src), None, src.splitlines(True), name)
    buf = io.StringIO()
    old = sys.stdout, sys.stderr
    handler = logging.StreamHandler(buf)
    handler.setLevel(logging.WARNING)
    logging.getLogger().addHandler(handler)
    sys.stdout = sys.stderr = buf
    g = sys.modules["__main__"].__dict__
    ok, result = True, None
    t0 = time.time()
    deadline = t0 + limit

    # Python runs on the page's main thread here, so nothing outside can interrupt it. Stop the
    # cell's own code once it runs past the limit (library code is not traced, to stay fast).
    def line_tracer(frame, event, arg):
        if time.time() > deadline:
            raise TimeoutError(f"stopped after {limit} s; make the code faster or do less per call")
        return line_tracer

    def call_tracer(frame, event, arg):
        return line_tracer if frame.f_code.co_filename == name else None

    sys.settrace(call_tracer)
    try:
        tree = ast.parse(src, name, "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        exec(compile(tree, name, "exec"), g)
        if last is not None:
            value = eval(compile(last, name, "eval"), g)
            if value is not None:
                result = repr(value)
    except SyntaxError:
        ok = False
        traceback.print_exc(limit=0)
    except BaseException as e:
        ok = False
        etype, value, tb = sys.exc_info()
        while tb is not None and tb.tb_frame.f_code.co_filename != name:
            tb = tb.tb_next
        traceback.print_exception(etype, value, tb)
        if isinstance(e, AttributeError):
            try:
                hint = __agent_attr_hint(e)
                if hint:
                    print(hint)
            except Exception:
                pass
    finally:
        sys.settrace(None)
        sys.stdout, sys.stderr = old
        logging.getLogger().removeHandler(handler)
    out = {"ok": ok, "output": buf.getvalue(), "result": result, "seconds": round(time.time() - t0, 3)}
    return base64.b64encode(json.dumps(out).encode("utf-8")).decode("ascii")

def __agent_reset():
    # An empty scene, the default layout and none of the variables earlier code defined.
    import sys, slicer
    slicer.mrmlScene.Clear(0)
    slicer.app.layoutManager().setLayout(slicer.vtkMRMLLayoutNode.SlicerLayoutFourUpView)
    g = sys.modules["__main__"].__dict__
    for k in list(g):
        if k not in __agent_baseline:
            del g[k]

import sys as __agent_sys
__agent_baseline = set(__agent_sys.modules["__main__"].__dict__) | {"__agent_baseline", "__agent_sys"}
`;

const b64encode = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

export class SlicerBridge {
  /** @param {HTMLIFrameElement} frame an iframe showing SlicerWeb from this page's origin */
  constructor(frame) {
    this.frame = frame;
    this.initialized = false;
  }

  get web() {
    try {
      return this.frame.contentWindow?.slicerWeb ?? null;
    } catch {
      return null; // a cross-origin frame: SlicerWeb must be served from this origin
    }
  }

  get status() {
    return this.web?.store?.status ?? "loading";
  }

  async ready({ timeout = 180000 } = {}) {
    const t0 = Date.now();
    while (this.status !== "ready") {
      if (Date.now() - t0 > timeout) throw new Error(`SlicerWeb is not ready (status: ${this.status})`);
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!this.initialized) {
      await this.web.bridge.callYielding("evalPython", [HELPER, "exec"]);
      this.initialized = true;
    }
  }

  /** Run Python in the live scene. Returns {ok, output, result, seconds}. */
  async run(code) {
    await this.ready();
    const raw = await this.web.bridge.callYielding("evalPython", [`__agent_run(${JSON.stringify(b64encode(code))})`, "eval"]);
    const m = /^'?([A-Za-z0-9+/=]+)'?$/.exec(String(raw).trim());
    if (!m) throw new Error(`unexpected reply from SlicerWeb: ${String(raw).slice(0, 200)}`);
    return JSON.parse(b64decode(m[1]));
  }

  /** Start over: clear the scene, restore the layout, drop variables from earlier code. */
  async resetScene() {
    await this.ready();
    await this.web.bridge.callYielding("evalPython", ["__agent_reset()", "exec"]);
  }

  /** A short list of the scene's nodes, as the user would see them in the Data module. */
  async sceneSummary() {
    await this.ready();
    const raw = await this.web.bridge.callYielding("evalPython", ["__import__('base64').b64encode(__agent_scene().encode()).decode()", "eval"]);
    const m = /^'?([A-Za-z0-9+/=]*)'?$/.exec(String(raw).trim());
    return m ? b64decode(m[1]) : "";
  }

  /** Forget the helper, for example after the frame reloads. */
  reset() {
    this.initialized = false;
  }
}
