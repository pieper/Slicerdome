// Evaluation tasks for the chat agent, in the style of Slicer Discourse questions. Each task has:
//   prompt   what the user types
//   setup    Python run in a fresh SlicerWeb before the prompt (optional)
//   truth    Python that prints one line of JSON describing the scene afterwards
//   judge(answer, truth, used) -> [pass, why]   used = {toolName: count}
// The checks look at Slicer's state and at numbers in the answer, so wording does not matter.

const LOAD_MRHEAD = `
import SampleData
v = SampleData.SampleDataLogic().downloadSample("MRHead")
v.SetName("MRHead")
`;

/** All numbers in a text, with thousands separators removed and typographic minus signs (U+2212) read as "-". */
export function numbers(text) {
  return [...String(text).replace(/−/g, "-").replace(/(\d),(?=\d{3}\b)/g, "$1").matchAll(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)].map((m) => Number(m[0]));
}
const near = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(1e-9, Math.abs(b));
const hasNear = (text, value, rel) => numbers(text).some((n) => near(n, value, rel));

export const TASKS = [
  {
    id: "load-dims",
    prompt: "Load the MRHead sample data set and tell me its dimensions and voxel spacing.",
    truth: `
import json
v = slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")
d = v[0].GetImageData().GetDimensions() if v else None
s = v[0].GetSpacing() if v else None
print(json.dumps({"n": len(v), "dims": d, "spacing": s}))`,
    judge(answer, t) {
      if (!t.n) return [false, "no volume loaded"];
      const dimsOk = t.dims.every((d) => hasNear(answer, d, 0));
      const spOk = t.spacing.every((s) => hasNear(answer, s, 0.01));
      return [dimsOk && spOk, `dims ${dimsOk ? "ok" : "missing"}, spacing ${spOk ? "ok" : "missing"}`];
    },
  },
  {
    id: "mean-max",
    setup: LOAD_MRHEAD,
    prompt: "What are the mean and the maximum voxel values of the MRHead volume?",
    truth: `
import json
a = slicer.util.arrayFromVolume(slicer.util.getNode("MRHead"))
print(json.dumps({"mean": float(a.mean()), "max": float(a.max())}))`,
    judge(answer, t) {
      const m = hasNear(answer, t.mean, 0.01);
      const x = hasNear(answer, t.max, 0);
      return [m && x, `mean ${m ? "ok" : "wrong"} (${t.mean.toFixed(2)}), max ${x ? "ok" : "wrong"} (${t.max})`];
    },
  },
  {
    id: "window-level",
    setup: LOAD_MRHEAD,
    prompt: "Set the display of MRHead to window 200 and level 100.",
    truth: `
import json
d = slicer.util.getNode("MRHead").GetDisplayNode()
print(json.dumps({"window": d.GetWindow(), "level": d.GetLevel(), "auto": d.GetAutoWindowLevel()}))`,
    judge(_a, t) {
      const ok = Math.abs(t.window - 200) < 0.5 && Math.abs(t.level - 100) < 0.5;
      return [ok, `window ${t.window}, level ${t.level}`];
    },
  },
  {
    id: "point",
    prompt: "Place a point named Target at RAS coordinates (10, -20, 30).",
    truth: `
import json
pts = []
for n in slicer.util.getNodesByClass("vtkMRMLMarkupsFiducialNode"):
    for i in range(n.GetNumberOfControlPoints()):
        pts.append({"node": n.GetName(), "label": n.GetNthControlPointLabel(i), "pos": list(n.GetNthControlPointPositionWorld(i))})
print(json.dumps({"points": pts}))`,
    judge(_a, t) {
      const hit = t.points.find((p) => Math.hypot(p.pos[0] - 10, p.pos[1] + 20, p.pos[2] - 30) < 0.01);
      if (!hit) return [false, `no point at (10,-20,30): ${JSON.stringify(t.points).slice(0, 120)}`];
      const named = /target/i.test(hit.label) || /target/i.test(hit.node);
      return [named, named ? "ok" : `point there but named ${hit.node}/${hit.label}`];
    },
  },
  {
    id: "layout-3d",
    prompt: "Change the view layout so that only the 3D view is shown.",
    truth: `
import json
print(json.dumps({"layout": slicer.app.layoutManager().layout, "want": slicer.vtkMRMLLayoutNode.SlicerLayoutOneUp3DView}))`,
    judge(_a, t) {
      return [t.layout === t.want, `layout ${t.layout} (want ${t.want})`];
    },
  },
  {
    id: "threshold-count",
    setup: LOAD_MRHEAD,
    prompt: "Create a segmentation of MRHead with one segment containing all voxels with values between 100 and 300 (inclusive), and tell me how many voxels the segment has.",
    truth: `
import json, numpy as np
a = slicer.util.arrayFromVolume(slicer.util.getNode("MRHead"))
want = int(((a >= 100) & (a <= 300)).sum())
got = []
for s in slicer.util.getNodesByClass("vtkMRMLSegmentationNode"):
    seg = s.GetSegmentation()
    for i in range(seg.GetNumberOfSegments()):
        sid = seg.GetNthSegmentID(i)
        try:
            m = slicer.util.arrayFromSegmentBinaryLabelmap(s, sid, slicer.util.getNode("MRHead"))
            got.append(int((m > 0).sum()))
        except Exception as e:
            got.append(str(e))
print(json.dumps({"want": want, "segments": got}))`,
    judge(answer, t) {
      const segOk = t.segments.some((n) => typeof n === "number" && near(n, t.want, 0.01));
      const ansOk = hasNear(answer, t.want, 0.01);
      return [segOk && ansOk, `segment ${segOk ? "ok" : `wrong ${JSON.stringify(t.segments)}`}, answer ${ansOk ? "ok" : "wrong"} (want ${t.want})`];
    },
  },
  {
    id: "segment-volume",
    setup: LOAD_MRHEAD + `
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Segmentation")
seg.SetReferenceImageGeometryParameterFromVolumeNode(v)
a = slicer.util.arrayFromVolume(v)
import numpy as np
mask = ((a >= 100) & (a <= 300)).astype(np.uint8)
sid = seg.GetSegmentation().AddEmptySegment("Bright")
slicer.util.updateSegmentBinaryLabelmapFromArray(mask, seg, sid, v)
`,
    prompt: "What is the volume, in cubic centimeters, of the segment in the segmentation?",
    truth: `
import json
v = slicer.util.getNode("MRHead")
a = slicer.util.arrayFromVolume(v)
sp = v.GetSpacing()
n = int(((a >= 100) & (a <= 300)).sum())
print(json.dumps({"cc": n * sp[0] * sp[1] * sp[2] / 1000.0}))`,
    judge(answer, t) {
      const ok = hasNear(answer, t.cc, 0.02);
      return [ok, `${ok ? "ok" : "wrong"} (want ${t.cc.toFixed(1)} cc)`];
    },
  },
  {
    id: "stl-howto",
    prompt: "How do I export all segments of a segmentation to STL files from a Python script? Show me the code.",
    truth: `print("{}")`,
    judge(answer, _t, used) {
      const api = /exportSegmentsClosedSurfaceRepresentationToFiles|ExportSegmentsClosedSurfaceRepresentationToFiles/.test(answer);
      return [api, `${api ? "uses" : "does not use"} exportSegmentsClosedSurfaceRepresentationToFiles; searched ${used.search ?? 0}x`];
    },
  },
  {
    id: "smooth",
    setup: LOAD_MRHEAD,
    prompt: "Smooth MRHead with a Gaussian filter (sigma of 2 mm) and put the result in a new volume named MRHeadSmooth. Keep the original.",
    truth: `
import json
o = slicer.util.getFirstNodeByName("MRHead")
s = slicer.util.getFirstNodeByName("MRHeadSmooth")
r = {"orig": o is not None, "smooth": s is not None}
if o and s and s.GetImageData():
    a, b = slicer.util.arrayFromVolume(o), slicer.util.arrayFromVolume(s)
    r.update(same_shape=list(a.shape) == list(b.shape), orig_std=float(a.std()), smooth_std=float(b.std()),
             diff=float(abs(a.astype(float) - b.astype(float)).mean()))
print(json.dumps(r))`,
    judge(_a, t) {
      if (!t.orig || !t.smooth) return [false, `original ${t.orig}, smoothed ${t.smooth}`];
      const ok = t.same_shape && t.smooth_std < t.orig_std && t.diff > 0.5;
      return [ok, `shape ${t.same_shape}, std ${t.orig_std?.toFixed(1)} -> ${t.smooth_std?.toFixed(1)}`];
    },
  },
  {
    id: "centroid-ras",
    setup: LOAD_MRHEAD,
    prompt: "Compute the center of mass, in RAS coordinates, of the MRHead voxels with values above 200.",
    truth: `
import json, numpy as np, vtk
v = slicer.util.getNode("MRHead")
a = slicer.util.arrayFromVolume(v)
k, j, i = np.nonzero(a > 200)
ijk = np.array([i.mean(), j.mean(), k.mean(), 1.0])
m = vtk.vtkMatrix4x4(); v.GetIJKToRASMatrix(m)
ras = [sum(m.GetElement(r, c) * ijk[c] for c in range(4)) for r in range(3)]
print(json.dumps({"ras": ras}))`,
    judge(answer, t) {
      const ns = numbers(answer);
      const ok = t.ras.every((c) => ns.some((n) => Math.abs(n - c) < 1.0));
      return [ok, `want (${t.ras.map((c) => c.toFixed(1)).join(", ")})`];
    },
  },
];
