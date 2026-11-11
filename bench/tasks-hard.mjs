// Harder evaluation tasks, each modeled on a question asked on discourse.slicer.org (the topic is in
// `source`). Same shape as tasks.mjs (prompt, setup, truth, judge), plus:
//   solution  Python that does the task correctly and prints an answer (bench/selftest.mjs checks
//             that the judge passes it, and fails a run that does nothing)
//   wrong     optional Python for a plausible mistake the judge must fail (ignoring a transform, ...)
//   also      optional list of other correct solutions the judge must pass (ones models have used)
// The truth scripts recompute the expected result from the setup's parameters and a copy of the
// original MRHead array, so they do not depend on what the agent did to the scene.
import { numbers } from "./tasks.mjs";

const near = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(1e-9, Math.abs(b));
const hasNear = (text, value, rel) => numbers(text).some((n) => near(n, value, rel));
const hasWithin = (text, value, abs) => numbers(text).some((n) => Math.abs(n - value) <= abs);
const hasAll = (text, values, abs) => values.every((c) => hasWithin(text, c, abs));
const f1 = (xs) => xs.map((x) => (typeof x === "number" ? x.toFixed(1) : x)).join(", ");

// Helpers for setup and truth scripts (names start with _ev so they do not clash with the agent's).
const H = String.raw`
import json, sys, types
import numpy as np, vtk, slicer
from vtk.util import numpy_support as _ev_ns
def _ev_matrix(M):
    m = vtk.vtkMatrix4x4()
    for r in range(4):
        for c in range(4):
            m.SetElement(r, c, M[r][c])
    return m
def _ev_axes(M, shape):
    # RAS coordinates of the voxel centers, as three arrays shaped like arrayFromVolume
    K, J, I = shape
    i = np.arange(I, dtype=np.float32)[None, None, :]
    j = np.arange(J, dtype=np.float32)[None, :, None]
    k = np.arange(K, dtype=np.float32)[:, None, None]
    return [M[r][0] * i + M[r][1] * j + M[r][2] * k + M[r][3] for r in range(3)]
def _ev_sphere(M, shape, c, r):
    x, y, z = _ev_axes(M, shape)
    return (x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 <= r * r
def _ev_add(seg, name, mask, ref, color=None):
    sid = seg.GetSegmentation().AddEmptySegment(name, name)
    if color:
        seg.GetSegmentation().GetSegment(sid).SetColor(*color)
    slicer.util.updateSegmentBinaryLabelmapFromArray(mask.astype(np.uint8), seg, sid, ref)
    return sid
def _ev_new_seg(name, ref):
    seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", name)
    seg.CreateDefaultDisplayNodes()
    seg.SetReferenceImageGeometryParameterFromVolumeNode(ref)
    return seg
def _ev_node(name, cls="vtkMRMLNode"):
    # The first node of a class with this name (getFirstNodeByName can return a color table or the
    # like). When a failed attempt left an empty volume of the same name, the one with data counts.
    found = [n for n in slicer.util.getNodesByClass(cls) if n.GetName() == name]
    for n in found:
        if not hasattr(n, "GetImageData") or n.GetImageData() is not None:
            return n
    return found[0] if found else None
def _ev_segment(segName, segmentName, ref):
    # Voxels of a segment on ref's grid, or None
    seg = _ev_node(segName, "vtkMRMLSegmentationNode")
    if seg is None:
        return None
    sid = seg.GetSegmentation().GetSegmentIdBySegmentName(segmentName)
    if not sid:
        return None
    return slicer.util.arrayFromSegmentBinaryLabelmap(seg, sid, ref) > 0
def _ev_sampler_arr(arr, rasToIjk, toLocal=None):
    def f(p):
        q = list(toLocal.TransformPoint(p)) if toLocal else list(p)
        ijk = rasToIjk.MultiplyPoint(q + [1.0])
        i, j, k = [int(round(c)) for c in ijk[:3]]
        if 0 <= k < arr.shape[0] and 0 <= j < arr.shape[1] and 0 <= i < arr.shape[2]:
            return float(arr[k, j, i])
        return None
    return f
def _ev_sampler(node):
    # Nearest-voxel value of a volume at a world point, honoring its parent transforms
    m = vtk.vtkMatrix4x4()
    node.GetRASToIJKMatrix(m)
    toLocal = None
    if node.GetParentTransformNode():
        toLocal = vtk.vtkGeneralTransform()
        node.GetParentTransformNode().GetTransformFromWorld(toLocal)
    return _ev_sampler_arr(slicer.util.arrayFromVolume(node), m, toLocal)
def _ev_islands(mask, full):
    img = vtk.vtkImageData()
    K, J, I = mask.shape
    img.SetDimensions(I, J, K)
    img.GetPointData().SetScalars(_ev_ns.numpy_to_vtk(mask.astype(np.uint32).ravel(), deep=1, array_type=vtk.VTK_UNSIGNED_INT))
    import vtkITK
    im = vtkITK.vtkITKIslandMath()
    im.SetInputData(img)
    im.SetFullyConnected(full)
    im.SetMinimumSize(1)
    im.Update()
    return _ev_ns.vtk_to_numpy(im.GetOutput().GetPointData().GetScalars()).reshape(mask.shape)
`;

// Loads MRHead and keeps a copy of its voxels and geometry for the truth scripts.
const LOAD = H + String.raw`
import SampleData
v = SampleData.SampleDataLogic().downloadSample("MRHead")
v.SetName("MRHead")
a = slicer.util.arrayFromVolume(v)
_ev_S = sys.modules.setdefault("_evstore", types.ModuleType("_evstore"))
_ev_S.orig = a.copy()
m0 = vtk.vtkMatrix4x4()
v.GetIJKToRASMatrix(m0)
_ev_S.M = [[m0.GetElement(r, c) for c in range(4)] for r in range(4)]
M0 = _ev_S.M
`;

const TRUTH = H + String.raw`
_ev_S = sys.modules.get("_evstore")
a0 = _ev_S.orig if _ev_S else None
M0 = _ev_S.M if _ev_S else None
v = _ev_node("MRHead", "vtkMRMLScalarVolumeNode")
R = {}
`;
const OUT = "\nprint(json.dumps(R))";
const truth = (code) => TRUTH + code + OUT;

// Masks used by several tasks, as Python expressions over a (setup) or a0 (truth)
const BRIGHT = (arr) => `((${arr} >= 80) & _ev_sphere(M0, ${arr}.shape, (-20, 15, 25), 25))`;
const TISSUE = (arr) => `((${arr} >= 80) & (${arr} <= 279))`;

export const TASKS = [
  {
    id: "ijk-under-transform",
    source: "https://discourse.slicer.org/t/3806",
    setup: LOAD + String.raw`
t = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLLinearTransformNode", "Shift")
tr = vtk.vtkTransform(); tr.Translate(12, -8, 20); tr.RotateZ(25)
t.SetMatrixTransformToParent(tr.GetMatrix())
v.SetAndObserveTransformNodeID(t.GetID())
local = m0.MultiplyPoint((133 + 0.2, 86 - 0.15, 57 + 0.1, 1.0))[:3]
tw = vtk.vtkGeneralTransform(); t.GetTransformToWorld(tw)
p = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "P")
p.AddControlPointWorld(tw.TransformPoint(local))
`,
    prompt: "MRHead is under the transform 'Shift' (not hardened). For the first point of point list 'P', what are the IJK indices of the MRHead voxel at that point, and what is the voxel value there?",
    truth: truth(`R["ijk"] = [133, 86, 57]; R["value"] = int(a0[57, 86, 133])`),
    judge(answer, t) {
      const ns = numbers(answer);
      const ijk = t.ijk.every((n) => ns.includes(n));
      const val = ns.includes(t.value);
      return [ijk && val, `ijk ${ijk ? "ok" : "wrong"} (want ${t.ijk}), value ${val ? "ok" : "wrong"} (want ${t.value})`];
    },
    solution: String.raw`
import vtk
v = slicer.util.getNode("MRHead"); p = slicer.util.getNode("P")
w = p.GetNthControlPointPositionWorld(0)
tw = vtk.vtkGeneralTransform(); slicer.vtkMRMLTransformNode.GetTransformBetweenNodes(None, v.GetParentTransformNode(), tw)
local = tw.TransformPoint(w)
m = vtk.vtkMatrix4x4(); v.GetRASToIJKMatrix(m)
ijk = [int(round(c)) for c in m.MultiplyPoint(list(local) + [1.0])[:3]]
print("IJK", ijk, "value", int(slicer.util.arrayFromVolume(v)[ijk[2], ijk[1], ijk[0]]))`,
    wrong: String.raw`
import vtk
v = slicer.util.getNode("MRHead"); p = slicer.util.getNode("P")
w = p.GetNthControlPointPositionWorld(0)
m = vtk.vtkMatrix4x4(); v.GetRASToIJKMatrix(m)
ijk = [int(round(c)) for c in m.MultiplyPoint(list(w) + [1.0])[:3]]
a = slicer.util.arrayFromVolume(v)
ijk = [min(max(c, 0), n - 1) for c, n in zip(ijk, (a.shape[2], a.shape[1], a.shape[0]))]
print("IJK", ijk, "value", int(a[ijk[2], ijk[1], ijk[0]]))`,
  },
  {
    id: "centroid-under-transform",
    source: "https://discourse.slicer.org/t/45362",
    setup: LOAD + String.raw`
seg = _ev_new_seg("Seg", v)
_ev_add(seg, "Blob", _ev_sphere(M0, a.shape, (-25, 30, 15), 12) & (a > 60), v)
t = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLLinearTransformNode", "Move")
tr = vtk.vtkTransform(); tr.Translate(30, 0, -10); tr.RotateX(15)
t.SetMatrixTransformToParent(tr.GetMatrix())
seg.SetAndObserveTransformNodeID(t.GetID())
`,
    prompt: "Segmentation 'Seg' is under the transform 'Move'. Where is the centroid (center of mass) of segment 'Blob' in world RAS coordinates, that is, where it appears in the views?",
    truth: truth(String.raw`
mask = _ev_sphere(M0, a0.shape, (-25, 30, 15), 12) & (a0 > 60)
x, y, z = _ev_axes(M0, a0.shape)
local = [float(c[mask].mean()) for c in (x, y, z)]
tr = vtk.vtkTransform(); tr.Translate(30, 0, -10); tr.RotateX(15)
R["local"] = local; R["world"] = list(tr.TransformPoint(local))`),
    judge(answer, t) {
      const ok = hasAll(answer, t.world, 1.0);
      return [ok, `want (${f1(t.world)}); without the transform (${f1(t.local)})`];
    },
    solution: String.raw`
import numpy as np, vtk
seg = slicer.util.getNode("Seg"); v = slicer.util.getNode("MRHead")
sid = seg.GetSegmentation().GetSegmentIdBySegmentName("Blob")
import SegmentStatistics
lg = SegmentStatistics.SegmentStatisticsLogic()
lg.getParameterNode().SetParameter("Segmentation", seg.GetID())
lg.getParameterNode().SetParameter("LabelmapSegmentStatisticsPlugin.centroid_ras.enabled", "True")
lg.computeStatistics()
c = lg.getStatistics()[sid, "LabelmapSegmentStatisticsPlugin.centroid_ras"]
print("centroid (world RAS)", c)`,
    wrong: String.raw`
import numpy as np, vtk
seg = slicer.util.getNode("Seg"); v = slicer.util.getNode("MRHead")
a = slicer.util.arrayFromSegmentBinaryLabelmap(seg, seg.GetSegmentation().GetSegmentIdBySegmentName("Blob"), v)
k, j, i = np.nonzero(a)
m = vtk.vtkMatrix4x4(); v.GetIJKToRASMatrix(m)
c = m.MultiplyPoint([i.mean(), j.mean(), k.mean(), 1.0])[:3]   # already in world coordinates
tw = vtk.vtkGeneralTransform(); seg.GetParentTransformNode().GetTransformToWorld(tw)
print("centroid", tw.TransformPoint(c))   # the transform applied a second time`,
  },
  {
    id: "mirror-lr",
    source: "https://discourse.slicer.org/t/28679",
    setup: LOAD,
    prompt: "I need a mirror image of MRHead across the mid-sagittal plane x = 0 (RAS), with left and right swapped, to use the healthy side as a template. Create it as a new volume named 'MRHeadMirrored' and leave MRHead as it is.",
    truth: truth(String.raw`
mv = _ev_node("MRHeadMirrored", "vtkMRMLVolumeNode")
m = vtk.vtkMatrix4x4(); v.GetIJKToRASMatrix(m)
R["orig_ok"] = bool(v.GetParentTransformNode() is None and np.array_equal(slicer.util.arrayFromVolume(v), a0)
                    and all(abs(m.GetElement(r, c) - M0[r][c]) < 1e-4 for r in range(4) for c in range(4)))
R["mirrored"] = bool(mv is not None and mv is not v and mv.GetImageData() is not None)
if R["mirrored"]:
    inv = _ev_matrix(M0); inv.Invert()
    f0 = _ev_sampler_arr(a0, inv); fm = _ev_sampler(mv)
    rng = np.random.default_rng(1); n = agree = 0; xs, ys = [], []
    for _ in range(4000):
        p = [float(rng.uniform(-80, 80)), float(rng.uniform(-110, 125)), float(rng.uniform(-125, 110))]
        a1 = f0([-p[0], p[1], p[2]])
        if a1 is None or a1 < 30:
            continue
        a2 = fm(p)
        if a2 is None:
            continue
        n += 1; agree += abs(a1 - a2) <= 5; xs.append(a1); ys.append(a2)
        if n >= 400:
            break
    R.update(n=n, agree=agree / max(n, 1), r=float(np.corrcoef(xs, ys)[0, 1]) if n > 10 else 0)`),
    judge(_a, t) {
      // correlation with the mirrored original at tissue points: 1.0 for an exact mirror, about 0.93
      // for one resampled with linear interpolation, about 0.34 for a mirror about the wrong plane
      const ok = t.orig_ok && t.mirrored && t.n >= 100 && t.r >= 0.85;
      return [ok, `original ${t.orig_ok ? "unchanged" : "changed"}, mirrored ${t.mirrored}, correlation ${t.r?.toFixed(2)} at ${t.n} points (within 5: ${t.agree?.toFixed(2)})`];
    },
    solution: String.raw`
import vtk
v = slicer.util.getNode("MRHead")
mv = slicer.modules.volumes.logic().CloneVolume(slicer.mrmlScene, v, "MRHeadMirrored")
m = vtk.vtkMatrix4x4(); v.GetIJKToRASMatrix(m)
F = vtk.vtkMatrix4x4(); F.SetElement(0, 0, -1)
out = vtk.vtkMatrix4x4(); vtk.vtkMatrix4x4.Multiply4x4(F, m, out)
mv.SetIJKToRASMatrix(out)
print("created", mv.GetName())`,
    also: [String.raw`
import numpy as np, vtk
# resample onto the original grid with linear interpolation along the R axis (as Claude Sonnet did)
v = slicer.util.getNode("MRHead"); A = slicer.util.arrayFromVolume(v)
m = vtk.vtkMatrix4x4(); v.GetIJKToRASMatrix(m); c = -2 * m.GetElement(0, 3) / m.GetElement(0, 2)
ks = c - np.arange(A.shape[0]); f = np.floor(ks).astype(int); w = ks - f
res = np.zeros(A.shape)
for k in range(A.shape[0]):
    if 0 <= f[k] < A.shape[0] - 1:
        res[k] = A[f[k]] * (1 - w[k]) + A[f[k] + 1] * w[k]
out = slicer.modules.volumes.logic().CloneVolume(slicer.mrmlScene, v, "MRHeadMirrored")
slicer.util.updateVolumeFromArray(out, np.rint(res).astype(np.int16)); out.CopyOrientation(v)
print("created")`],
    wrong: String.raw`
import vtk
v = slicer.util.getNode("MRHead")
b = [0] * 6; v.GetRASBounds(b); cx = (b[0] + b[1]) / 2
mv = slicer.modules.volumes.logic().CloneVolume(slicer.mrmlScene, v, "MRHeadMirrored")
m = vtk.vtkMatrix4x4(); v.GetIJKToRASMatrix(m)
F = vtk.vtkMatrix4x4(); F.SetElement(0, 0, -1); F.SetElement(0, 3, 2 * cx)
out = vtk.vtkMatrix4x4(); vtk.vtkMatrix4x4.Multiply4x4(F, m, out)
mv.SetIJKToRASMatrix(out)
print("mirrored about the volume center x =", cx)`,
  },
  {
    id: "crop-box",
    source: "https://discourse.slicer.org/t/30364",
    setup: LOAD,
    prompt: "Crop MRHead to an axis-aligned box centered at RAS (0, 20, 10) that is 60 mm in the R-L direction, 80 mm A-P and 40 mm S-I. Keep the original voxel size (no resampling) and put the result in a new volume named 'MRHeadCrop'.",
    truth: truth(String.raw`
c = _ev_node("MRHeadCrop", "vtkMRMLVolumeNode")
R["exists"] = bool(c is not None and c is not v and c.GetImageData() is not None)
if R["exists"]:
    R["spacing"] = sorted(c.GetSpacing())
    b = [0.0] * 6; c.GetRASBounds(b); R["bounds"] = b
    inv = _ev_matrix(M0); inv.Invert()
    f0 = _ev_sampler_arr(a0, inv); fc = _ev_sampler(c)
    rng = np.random.default_rng(2); n = agree = 0
    for _ in range(400):
        p = [float(rng.uniform(b[0], b[1])), float(rng.uniform(b[2], b[3])), float(rng.uniform(b[4], b[5]))]
        a1, a2 = f0(p), fc(p)
        if a1 is None or a2 is None:
            continue
        n += 1; agree += abs(a1 - a2) <= 1
    R.update(n=n, agree=agree / max(n, 1))`),
    judge(_a, t) {
      if (!t.exists) return [false, "no MRHeadCrop"];
      const box = [-30, 30, -20, 60, -10, 30];
      const sp = t.spacing.every((s, i) => Math.abs(s - [1, 1, 1.3][i]) < 0.01);
      const bd = t.bounds.every((b, i) => Math.abs(b - box[i]) <= 2.0);
      const vals = t.n >= 100 && t.agree >= 0.95;
      return [sp && bd && vals, `spacing ${sp ? "ok" : t.spacing}, bounds ${bd ? "ok" : f1(t.bounds)}, values ${vals ? "ok" : t.agree}`];
    },
    solution: String.raw`
v = slicer.util.getNode("MRHead")
roi = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsROINode", "CropBox"); roi.SetCenter(0, 20, 10); roi.SetSize(60, 80, 40)
cp = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLCropVolumeParametersNode")
cp.SetInputVolumeNodeID(v.GetID()); cp.SetROINodeID(roi.GetID()); cp.SetVoxelBased(True)
out = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "MRHeadCrop"); cp.SetOutputVolumeNodeID(out.GetID())
slicer.modules.cropvolume.logic().Apply(cp)
print(out.GetImageData().GetDimensions())`,
  },
  {
    id: "resample-2mm",
    source: "https://discourse.slicer.org/t/18741",
    setup: LOAD,
    prompt: "Resample MRHead to 2 mm isotropic voxels, into a new volume named 'MRHead2mm' that covers the same region as the original.",
    truth: truth(String.raw`
r2 = _ev_node("MRHead2mm", "vtkMRMLVolumeNode")
R["exists"] = bool(r2 is not None and r2 is not v and r2.GetImageData() is not None)
if R["exists"]:
    R["spacing"] = list(r2.GetSpacing())
    b = [0.0] * 6; r2.GetRASBounds(b); R["bounds"] = b
    inv = _ev_matrix(M0); inv.Invert()
    f0 = _ev_sampler_arr(a0, inv); fr = _ev_sampler(r2)
    rng = np.random.default_rng(3); xs, ys = [], []
    for _ in range(600):
        p = [float(rng.uniform(-80, 75)), float(rng.uniform(-115, 128)), float(rng.uniform(-130, 110))]
        a1, a2 = f0(p), fr(p)
        if a1 is None or a2 is None:
            continue
        xs.append(a1); ys.append(a2)
    R["n"] = len(xs); R["r"] = float(np.corrcoef(xs, ys)[0, 1]) if len(xs) > 10 else 0`),
    judge(_a, t) {
      if (!t.exists) return [false, "no MRHead2mm"];
      const orig = [-87.29, 81.7, -121.57, 134.43, -138.71, 117.29];
      const sp = t.spacing.every((s) => Math.abs(s - 2) < 0.02);
      const bd = t.bounds.every((b, i) => Math.abs(b - orig[i]) <= 3.0);
      const vals = t.n >= 100 && t.r >= 0.9;
      return [sp && bd && vals, `spacing ${sp ? "ok" : f1(t.spacing)}, bounds ${bd ? "ok" : f1(t.bounds)}, correlation ${t.r?.toFixed(3)}`];
    },
    solution: String.raw`
v = slicer.util.getNode("MRHead")
out = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "MRHead2mm")
slicer.cli.runSync(slicer.modules.resamplescalarvolume, None, {"InputVolume": v.GetID(), "OutputVolume": out.GetID(), "outputPixelSpacing": "2,2,2", "interpolationType": "linear"})
print(out.GetSpacing(), out.GetImageData().GetDimensions())`,
  },
  {
    id: "largest-island",
    source: "https://discourse.slicer.org/t/21021",
    setup: LOAD + `seg = _ev_new_seg("Seg", v)\n_ev_add(seg, "Tissue", ${TISSUE("a")}, v)\n`,
    prompt: "Segment 'Tissue' in segmentation 'Seg' has lots of small disconnected pieces. Keep only its largest connected piece, like the Segment Editor's 'Keep largest island', and tell me how many voxels remain and its volume in mL.",
    truth: truth(`mask = ${TISSUE("a0")}
R["want6"] = int((_ev_islands(mask, False) == 1).sum())
R["want26"] = int((_ev_islands(mask, True) == 1).sum())
R["before"] = int(mask.sum())
got = _ev_segment("Seg", "Tissue", v)
R["got"] = None if got is None else int(got.sum())
R["voxel_ml"] = 1.0 * 1.0 * 1.3 / 1000`),
    judge(answer, t) {
      if (t.got == null) return [false, "segment Tissue is gone"];
      const w = Math.abs(t.got - t.want6) < Math.abs(t.got - t.want26) ? t.want6 : t.want26;
      const seg = near(t.got, w, 0.003);
      const n = hasNear(answer, t.got, 0.005);
      const ml = hasNear(answer, t.got * t.voxel_ml, 0.01);
      return [seg && n && ml, `segment ${seg ? "ok" : "wrong"} (${t.got}; want ${t.want6} or ${t.want26}, before ${t.before}), count ${n ? "ok" : "missing"}, mL ${ml ? "ok" : "missing"}`];
    },
    solution: String.raw`
import numpy as np, vtk, vtkITK
from vtk.util import numpy_support as ns
seg = slicer.util.getNode("Seg"); v = slicer.util.getNode("MRHead")
sid = seg.GetSegmentation().GetSegmentIdBySegmentName("Tissue")
a = slicer.util.arrayFromSegmentBinaryLabelmap(seg, sid, v)
img = vtk.vtkImageData(); img.SetDimensions(a.shape[2], a.shape[1], a.shape[0])
img.GetPointData().SetScalars(ns.numpy_to_vtk((a > 0).astype(np.uint32).ravel(), deep=1, array_type=vtk.VTK_UNSIGNED_INT))
im = vtkITK.vtkITKIslandMath(); im.SetInputData(img); im.SetFullyConnected(False); im.SetMinimumSize(1); im.Update()
keep = (ns.vtk_to_numpy(im.GetOutput().GetPointData().GetScalars()).reshape(a.shape) == 1).astype(np.uint8)
slicer.util.updateSegmentBinaryLabelmapFromArray(keep, seg, sid, v)
print("voxels", int(keep.sum()), "volume mL", keep.sum() * 1.3 / 1000)`,
  },
  {
    id: "subtract-segments",
    source: "https://discourse.slicer.org/t/16581",
    setup: LOAD + `seg = _ev_new_seg("Seg", v)\n_ev_add(seg, "Tissue", ${TISSUE("a")}, v)\n_ev_add(seg, "Region", _ev_sphere(M0, a.shape, (0, 30, 20), 30), v)\n`,
    prompt: "In segmentation 'Seg', subtract segment 'Region' from segment 'Tissue': remove from 'Tissue' everything that overlaps 'Region', and keep 'Region' unchanged. How many voxels does 'Tissue' have afterwards?",
    truth: truth(`T = ${TISSUE("a0")}
Rg = _ev_sphere(M0, a0.shape, (0, 30, 20), 30)
R["wantT"] = int((T & ~Rg).sum()); R["wantR"] = int(Rg.sum()); R["before"] = int(T.sum())
gt, gr = _ev_segment("Seg", "Tissue", v), _ev_segment("Seg", "Region", v)
R["gotT"] = None if gt is None else int(gt.sum()); R["gotR"] = None if gr is None else int(gr.sum())`),
    judge(answer, t) {
      if (t.gotT == null || t.gotR == null) return [false, "a segment is missing"];
      const ts = near(t.gotT, t.wantT, 0.002);
      const rs = near(t.gotR, t.wantR, 0.002);
      const n = hasNear(answer, t.gotT, 0.005);
      return [ts && rs && n, `Tissue ${ts ? "ok" : `${t.gotT} (want ${t.wantT}, before ${t.before})`}, Region ${rs ? "unchanged" : `${t.gotR} (want ${t.wantR})`}, answer ${n ? "ok" : "wrong"}`];
    },
    solution: String.raw`
import numpy as np
seg = slicer.util.getNode("Seg"); v = slicer.util.getNode("MRHead"); S = seg.GetSegmentation()
t, r = S.GetSegmentIdBySegmentName("Tissue"), S.GetSegmentIdBySegmentName("Region")
at = slicer.util.arrayFromSegmentBinaryLabelmap(seg, t, v) > 0
ar = slicer.util.arrayFromSegmentBinaryLabelmap(seg, r, v) > 0
new = (at & ~ar).astype(np.uint8)
slicer.util.updateSegmentBinaryLabelmapFromArray(new, seg, t, v)
print("Tissue voxels", int(new.sum()))`,
  },
  {
    id: "dice-jaccard",
    source: "https://discourse.slicer.org/t/30000",
    setup: LOAD + String.raw`
seg = _ev_new_seg("Seg", v)
_ev_add(seg, "Manual", (a >= 80) & _ev_sphere(M0, a.shape, (0, 20, 30), 40), v)
_ev_add(seg, "Auto", (a >= 90) & _ev_sphere(M0, a.shape, (3, 18, 32), 42), v)
`,
    prompt: "What are the Dice similarity coefficient and the Jaccard index between segments 'Manual' and 'Auto' in segmentation 'Seg'?",
    truth: truth(String.raw`
A = (a0 >= 80) & _ev_sphere(M0, a0.shape, (0, 20, 30), 40)
B = (a0 >= 90) & _ev_sphere(M0, a0.shape, (3, 18, 32), 42)
i = int((A & B).sum()); R["dice"] = 2 * i / (int(A.sum()) + int(B.sum())); R["jaccard"] = i / int((A | B).sum())
ga, gb = _ev_segment("Seg", "Manual", v), _ev_segment("Seg", "Auto", v)
R["state_ok"] = bool(ga is not None and gb is not None and np.array_equal(ga, A) and np.array_equal(gb, B))`),
    judge(answer, t) {
      const ok = (x) => hasWithin(answer, x, 0.005) || hasWithin(answer, x * 100, 0.5);
      const d = ok(t.dice);
      const j = ok(t.jaccard);
      return [d && j, `Dice ${d ? "ok" : "wrong"} (want ${t.dice.toFixed(3)}), Jaccard ${j ? "ok" : "wrong"} (want ${t.jaccard.toFixed(3)})`];
    },
    solution: String.raw`
seg = slicer.util.getNode("Seg"); v = slicer.util.getNode("MRHead"); S = seg.GetSegmentation()
A = slicer.util.arrayFromSegmentBinaryLabelmap(seg, S.GetSegmentIdBySegmentName("Manual"), v) > 0
B = slicer.util.arrayFromSegmentBinaryLabelmap(seg, S.GetSegmentIdBySegmentName("Auto"), v) > 0
i = (A & B).sum()
print("Dice", 2 * i / (A.sum() + B.sum()), "Jaccard", i / (A | B).sum())`,
  },
  {
    id: "segment-stats",
    source: "https://discourse.slicer.org/t/18296",
    setup: LOAD + String.raw`
seg = _ev_new_seg("Seg", v)
_ev_add(seg, "Low", (a >= 30) & (a <= 79), v)
_ev_add(seg, "Mid", (a >= 80) & (a <= 149), v)
_ev_add(seg, "High", (a >= 150) & (a <= 279), v)
`,
    prompt: "For each segment in segmentation 'Seg', report its volume in mL and the mean and standard deviation of the MRHead intensity inside it.",
    truth: truth(String.raw`
R["segments"] = []
for name, lo, hi in (("Low", 30, 79), ("Mid", 80, 149), ("High", 150, 279)):
    vals = a0[(a0 >= lo) & (a0 <= hi)].astype(float)
    R["segments"].append({"name": name, "ml": vals.size * 1.3 / 1000, "mean": float(vals.mean()), "std": float(vals.std())})`),
    judge(answer, t) {
      const bad = [];
      for (const s of t.segments) {
        if (!hasNear(answer, s.ml, 0.01)) bad.push(`${s.name} volume (${s.ml.toFixed(1)})`);
        if (!hasNear(answer, s.mean, 0.01)) bad.push(`${s.name} mean (${s.mean.toFixed(1)})`);
        if (!hasNear(answer, s.std, 0.02)) bad.push(`${s.name} std (${s.std.toFixed(1)})`);
      }
      return [!bad.length, bad.length ? `missing ${bad.join(", ")}` : "all 9 values ok"];
    },
    solution: String.raw`
import SegmentStatistics
seg = slicer.util.getNode("Seg"); v = slicer.util.getNode("MRHead")
lg = SegmentStatistics.SegmentStatisticsLogic()
lg.getParameterNode().SetParameter("Segmentation", seg.GetID()); lg.getParameterNode().SetParameter("ScalarVolume", v.GetID())
lg.computeStatistics(); st = lg.getStatistics()
for sid in st["SegmentIDs"]:
    print(seg.GetSegmentation().GetSegment(sid).GetName(), st[sid, "ScalarVolumeSegmentStatisticsPlugin.volume_cm3"], "mL, mean", st[sid, "ScalarVolumeSegmentStatisticsPlugin.mean"], "std", st[sid, "ScalarVolumeSegmentStatisticsPlugin.stdev"])`,
  },
  {
    id: "labelmap-values",
    source: "https://discourse.slicer.org/t/1916",
    setup: LOAD + String.raw`
seg = _ev_new_seg("Seg", v)
c = (-20, 20, 30)
s8, s15, s25 = (_ev_sphere(M0, a.shape, c, r) for r in (8, 15, 25))
_ev_add(seg, "Edema", s25 & ~s15, v)
_ev_add(seg, "Tumor", s15 & ~s8, v)
_ev_add(seg, "Necrosis", s8, v)
`,
    prompt: "Export segmentation 'Seg' to a labelmap volume named 'BraTSLabels' on MRHead's voxel grid, with label value 1 for 'Necrosis', 2 for 'Edema' and 4 for 'Tumor', and 0 everywhere else.",
    truth: truth(String.raw`
c = (-20, 20, 30)
s8, s15, s25 = (_ev_sphere(M0, a0.shape, c, r) for r in (8, 15, 25))
want = np.zeros(a0.shape, np.int16); want[s25 & ~s15] = 2; want[s15 & ~s8] = 4; want[s8] = 1
L = _ev_node("BraTSLabels", "vtkMRMLVolumeNode")
R["exists"] = bool(L is not None and L.IsA("vtkMRMLVolumeNode") and L.GetImageData() is not None)
if R["exists"]:
    arr = slicer.util.arrayFromVolume(L)
    m = vtk.vtkMatrix4x4(); L.GetIJKToRASMatrix(m)
    R["grid"] = bool(arr.shape == a0.shape and all(abs(m.GetElement(r, cc) - M0[r][cc]) < 1e-3 for r in range(3) for cc in range(4)))
    if R["grid"]:
        R["mismatch"] = int((arr != want).sum()); R["labelled"] = int((want > 0).sum())
        R["values"] = [int(x) for x in np.unique(arr)][:10]`),
    judge(_a, t) {
      if (!t.exists) return [false, "no volume named BraTSLabels"];
      if (!t.grid) return [false, "BraTSLabels is not on MRHead's grid"];
      const ok = t.mismatch <= 0.005 * t.labelled;
      return [ok, `${t.mismatch} voxels differ (of ${t.labelled} labelled), values ${t.values}`];
    },
    solution: String.raw`
import numpy as np
seg = slicer.util.getNode("Seg"); v = slicer.util.getNode("MRHead"); S = seg.GetSegmentation()
lm = slicer.modules.volumes.logic().CreateAndAddLabelVolume(slicer.mrmlScene, v, "BraTSLabels")
arr = np.zeros(slicer.util.arrayFromVolume(v).shape, np.uint8)
for name, value in (("Necrosis", 1), ("Edema", 2), ("Tumor", 4)):
    arr[slicer.util.arrayFromSegmentBinaryLabelmap(seg, S.GetSegmentIdBySegmentName(name), v) > 0] = value
slicer.util.updateVolumeFromArray(lm, arr)
print(np.unique(arr, return_counts=True))`,
    wrong: String.raw`
seg = slicer.util.getNode("Seg"); v = slicer.util.getNode("MRHead")
lm = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLLabelMapVolumeNode", "BraTSLabels")
slicer.modules.segmentations.logic().ExportAllSegmentsToLabelmapNode(seg, lm, slicer.vtkSegmentation.EXTENT_REFERENCE_GEOMETRY)
print("exported")`,
  },
  {
    id: "mask-volume",
    source: "https://discourse.slicer.org/t/7066",
    setup: LOAD + `seg = _ev_new_seg("Seg", v)\n_ev_add(seg, "Head", _ev_sphere(M0, a.shape, (0, 0, -10), 70) & (a > 20), v)\n`,
    prompt: "Make a new volume named 'MRHeadMasked' that keeps the MRHead values inside segment 'Head' and sets every voxel outside it to -100. Don't change MRHead.",
    truth: truth(String.raw`
mask = _ev_sphere(M0, a0.shape, (0, 0, -10), 70) & (a0 > 20)
mk = _ev_node("MRHeadMasked", "vtkMRMLVolumeNode")
R["orig_ok"] = bool(np.array_equal(slicer.util.arrayFromVolume(v), a0))
R["exists"] = bool(mk is not None and mk is not v and mk.GetImageData() is not None)
if R["exists"]:
    arr = slicer.util.arrayFromVolume(mk)
    m = vtk.vtkMatrix4x4(); mk.GetIJKToRASMatrix(m)
    R["grid"] = bool(arr.shape == a0.shape and all(abs(m.GetElement(r, c) - M0[r][c]) < 1e-3 for r in range(3) for c in range(4)))
    if R["grid"]:
        R["inside"] = float((arr[mask] == a0[mask]).mean()); R["outside"] = float((arr[~mask] == -100).mean())`),
    judge(_a, t) {
      if (!t.exists) return [false, "no MRHeadMasked"];
      if (!t.grid) return [false, "MRHeadMasked is not on MRHead's grid"];
      const ok = t.orig_ok && t.inside >= 0.995 && t.outside >= 0.995;
      return [ok, `MRHead ${t.orig_ok ? "unchanged" : "changed"}, inside kept ${t.inside.toFixed(3)}, outside -100 ${t.outside.toFixed(3)}`];
    },
    solution: String.raw`
seg = slicer.util.getNode("Seg"); v = slicer.util.getNode("MRHead")
mask = slicer.util.arrayFromSegmentBinaryLabelmap(seg, seg.GetSegmentation().GetSegmentIdBySegmentName("Head"), v) > 0
mk = slicer.modules.volumes.logic().CloneVolume(slicer.mrmlScene, v, "MRHeadMasked")
arr = slicer.util.arrayFromVolume(mk); arr[~mask] = -100; slicer.util.arrayFromVolumeModified(mk)
print("done", arr.min(), arr.max())`,
  },
  {
    id: "sphere-segment",
    source: "https://discourse.slicer.org/t/36192",
    setup: LOAD,
    prompt: "Create a segmentation named 'Spheres' containing a segment 'Ball': a sphere of radius 12 mm centered at RAS (0, 25, 15), on MRHead's voxel grid. Then tell me the mean MRHead intensity inside the ball.",
    truth: truth(String.raw`
want = _ev_sphere(M0, a0.shape, (0, 25, 15), 12)
R["mean"] = float(a0[want].mean()); R["count"] = int(want.sum())
got = _ev_segment("Spheres", "Ball", v)
R["dice"] = None if got is None else float(2 * (got & want).sum() / (got.sum() + want.sum()))`),
    judge(answer, t) {
      if (t.dice == null) return [false, "no segment Ball in a segmentation named Spheres"];
      const shape = t.dice >= 0.9;
      const mean = hasNear(answer, t.mean, 0.03);
      return [shape && mean, `sphere overlap (Dice) ${t.dice.toFixed(3)}, mean ${mean ? "ok" : "wrong"} (want ${t.mean.toFixed(1)})`];
    },
    solution: String.raw`
import numpy as np, vtk
v = slicer.util.getNode("MRHead"); a = slicer.util.arrayFromVolume(v)
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Spheres"); seg.CreateDefaultDisplayNodes()
seg.SetReferenceImageGeometryParameterFromVolumeNode(v)
sphere = vtk.vtkSphereSource(); sphere.SetCenter(0, 25, 15); sphere.SetRadius(12); sphere.SetPhiResolution(60); sphere.SetThetaResolution(60); sphere.Update()
sid = seg.AddSegmentFromClosedSurfaceRepresentation(sphere.GetOutput(), "Ball")
m = slicer.util.arrayFromSegmentBinaryLabelmap(seg, sid, v) > 0
print("voxels", int(m.sum()), "mean", float(a[m].mean()))`,
  },
  {
    id: "bounding-box-roi",
    source: "https://discourse.slicer.org/t/26227",
    setup: LOAD + `seg = _ev_new_seg("Seg", v)\n_ev_add(seg, "Bright", ${BRIGHT("a")}, v)\n`,
    prompt: "Create an axis-aligned ROI named 'BBox' that tightly encloses segment 'Bright' in segmentation 'Seg', and tell me the ROI's center and size in mm.",
    truth: truth(String.raw`
mask = ${BRIGHT("a0")}
x, y, z = _ev_axes(M0, a0.shape)
R["lo"] = [float(c[mask].min()) for c in (x, y, z)]; R["hi"] = [float(c[mask].max()) for c in (x, y, z)]
R["half"] = [0.5 * sum(abs(M0[r][c]) for c in range(3)) for r in range(3)]
roi = _ev_node("BBox", "vtkMRMLMarkupsROINode")
old = _ev_node("BBox", "vtkMRMLAnnotationROINode")
R["exists"] = bool(roi is not None or old is not None)
if roi is not None:
    b = [0.0] * 6; roi.GetRASBounds(b); R["bounds"] = b
    R["size"] = list(roi.GetSize()); R["kind"] = "markups"
elif old is not None:
    # the older Annotation ROI (still in Slicer, deprecated): always axis-aligned, center and half-size
    c = [0.0] * 3; h = [0.0] * 3; old.GetXYZ(c); old.GetRadiusXYZ(h)
    R["bounds"] = [c[0] - h[0], c[0] + h[0], c[1] - h[1], c[1] + h[1], c[2] - h[2], c[2] + h[2]]
    R["size"] = [2 * x for x in h]; R["kind"] = "annotation"`),
    judge(answer, t) {
      if (!t.exists) return [false, "no ROI named BBox"];
      const faces = [0, 1, 2].flatMap((i) => [[t.bounds[2 * i], t.lo[i], -t.half[i]], [t.bounds[2 * i + 1], t.hi[i], t.half[i]]]);
      // a face may sit on the outermost voxel centers or on their outer edges, with 0.6 mm to spare
      const fit = faces.every(([b, c, h]) => Math.min(Math.abs(b - c), Math.abs(b - (c + h))) <= 0.6);
      const aligned = [0, 1, 2].every((i) => Math.abs(t.bounds[2 * i + 1] - t.bounds[2 * i] - t.size[i]) < 0.1);
      const center = [0, 1, 2].map((i) => (t.lo[i] + t.hi[i]) / 2);
      const said = hasAll(answer, center, 1.0);
      return [fit && aligned && said, `fit ${fit ? "ok" : `bounds ${f1(t.bounds)} vs voxels ${f1(t.lo)} .. ${f1(t.hi)}`}, axis-aligned ${aligned}, center ${said ? "ok" : `want (${f1(center)})`}${t.kind === "annotation" ? " (older Annotation ROI)" : ""}`];
    },
    solution: String.raw`
import numpy as np, vtk
seg = slicer.util.getNode("Seg"); v = slicer.util.getNode("MRHead")
mask = slicer.util.arrayFromSegmentBinaryLabelmap(seg, seg.GetSegmentation().GetSegmentIdBySegmentName("Bright"), v) > 0
k, j, i = np.nonzero(mask)
m = vtk.vtkMatrix4x4(); v.GetIJKToRASMatrix(m)
corners = []
for ii in (i.min() - 0.5, i.max() + 0.5):
    for jj in (j.min() - 0.5, j.max() + 0.5):
        for kk in (k.min() - 0.5, k.max() + 0.5):
            corners.append(m.MultiplyPoint([ii, jj, kk, 1.0])[:3])
corners = np.array(corners); lo, hi = corners.min(0), corners.max(0)
roi = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsROINode", "BBox")
roi.SetCenter(*((lo + hi) / 2)); roi.SetSize(*(hi - lo))
print("center", (lo + hi) / 2, "size", hi - lo)`,
    also: [String.raw`
import numpy as np, vtk
# the older Annotation ROI node (as Claude Haiku did)
seg = slicer.util.getNode("Seg"); v = slicer.util.getNode("MRHead")
k, j, i = np.nonzero(slicer.util.arrayFromSegmentBinaryLabelmap(seg, "Bright", v))
m = vtk.vtkMatrix4x4(); v.GetIJKToRASMatrix(m)
c = np.array([m.MultiplyPoint([x, y, z, 1])[:3] for x in (i.min() - 0.5, i.max() + 0.5) for y in (j.min() - 0.5, j.max() + 0.5) for z in (k.min() - 0.5, k.max() + 0.5)])
lo, hi = c.min(0), c.max(0)
roi = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLAnnotationROINode", "BBox"); roi.SetXYZ(*((lo + hi) / 2)); roi.SetRadiusXYZ(*((hi - lo) / 2))
print("center", (lo + hi) / 2, "size", hi - lo)`],
  },
  {
    id: "slice-perpendicular",
    source: "https://discourse.slicer.org/t/29153",
    setup: LOAD + String.raw`
L = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsLineNode", "L")
L.AddControlPointWorld((10, -30, 5)); L.AddControlPointWorld((-20, 40, 35))
`,
    prompt: "Make the Red slice view show the plane that is perpendicular to line 'L' and passes through the line's midpoint.",
    truth: truth(String.raw`
p0, p1 = np.array([10, -30, 5.0]), np.array([-20, 40, 35.0])
d = (p1 - p0) / np.linalg.norm(p1 - p0); mid = (p0 + p1) / 2
m = slicer.mrmlScene.GetNodeByID("vtkMRMLSliceNodeRed").GetSliceToRAS()
n = np.array([m.GetElement(r, 2) for r in range(3)]); n /= np.linalg.norm(n)
o = np.array([m.GetElement(r, 3) for r in range(3)])
R["dot"] = float(abs(n @ d)); R["dist"] = float(abs((mid - o) @ n))`),
    judge(_a, t) {
      const ok = t.dot >= 0.995 && t.dist <= 0.5;
      return [ok, `|normal . line| ${t.dot.toFixed(4)}, midpoint ${t.dist.toFixed(2)} mm from the plane`];
    },
    solution: String.raw`
import numpy as np
L = slicer.util.getNode("L")
p0, p1 = np.array(L.GetNthControlPointPositionWorld(0)), np.array(L.GetNthControlPointPositionWorld(1))
n = (p1 - p0) / np.linalg.norm(p1 - p0); mid = (p0 + p1) / 2
t = np.cross(n, [0, 0, 1.0]); t /= np.linalg.norm(t)
red = slicer.app.layoutManager().sliceWidget("Red").mrmlSliceNode()
red.SetSliceToRASByNTP(*n, *t, *mid, 0)
print("done")`,
  },
  {
    id: "line-profile",
    source: "https://discourse.slicer.org/t/17785",
    setup: LOAD + String.raw`
L = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsLineNode", "Probe")
L.AddControlPointWorld((-60, 10, 20)); L.AddControlPointWorld((60, 10, 20))
`,
    prompt: "Sample MRHead along line 'Probe' every 0.5 mm, starting at its first point. What is the highest intensity along the line, and how far from the first point is it?",
    truth: truth(String.raw`
p0, p1 = np.array([-60, 10, 20.0]), np.array([60, 10, 20.0])
L = np.linalg.norm(p1 - p0); ts = np.arange(0, L + 1e-6, 0.5)
pts = p0[None, :] + ts[:, None] * ((p1 - p0) / L)[None, :]
inv = np.linalg.inv(np.array(M0))
ijk = (inv @ np.c_[pts, np.ones(len(pts))].T).T[:, :3]
near_ = [float(a0[int(round(k)), int(round(j)), int(round(i))]) for i, j, k in ijk]
lin = []
for i, j, k in ijk:
    i0, j0, k0 = int(np.floor(i)), int(np.floor(j)), int(np.floor(k)); fi, fj, fk = i - i0, j - j0, k - k0
    val = 0.0
    for di in (0, 1):
        for dj in (0, 1):
            for dk in (0, 1):
                w = (fi if di else 1 - fi) * (fj if dj else 1 - fj) * (fk if dk else 1 - fk)
                val += w * float(a0[k0 + dk, j0 + dj, i0 + di])
    lin.append(val)
R["t"] = ts.tolist(); R["near"] = near_; R["lin"] = lin`),
    judge(answer, t) {
      const ns = numbers(answer);
      const tries = [["nearest", t.near], ["linear", t.lin]].map(([name, vals]) => {
        const max = Math.max(...vals);
        const at = t.t.filter((_, i) => vals[i] >= max - Math.max(1, 0.01 * max));
        const val = hasNear(answer, max, 0.02);
        const dist = ns.some((n) => at.some((x) => Math.abs(n - x) <= 1.0));
        return { name, max, at, ok: val && dist };
      });
      const hit = tries.find((x) => x.ok);
      return [!!hit, hit ? `ok (${hit.name} sampling)` : tries.map((x) => `${x.name}: max ${x.max.toFixed(1)} at ${f1(x.at.slice(0, 3))} mm`).join("; ")];
    },
    solution: String.raw`
import numpy as np, vtk
v = slicer.util.getNode("MRHead"); L = slicer.util.getNode("Probe"); a = slicer.util.arrayFromVolume(v)
p0, p1 = np.array(L.GetNthControlPointPositionWorld(0)), np.array(L.GetNthControlPointPositionWorld(1))
n = np.linalg.norm(p1 - p0); ts = np.arange(0, n + 1e-6, 0.5)
m = vtk.vtkMatrix4x4(); v.GetRASToIJKMatrix(m)
vals = []
for t in ts:
    p = p0 + t * (p1 - p0) / n
    i, j, k = [int(round(c)) for c in m.MultiplyPoint(list(p) + [1.0])[:3]]
    vals.append(a[k, j, i])
best = int(np.argmax(vals))
print("max", vals[best], "at", ts[best], "mm")`,
  },
  {
    id: "phantom-volume",
    source: "https://discourse.slicer.org/t/22327",
    setup: H,
    prompt: "Create a new volume named 'Phantom': 100 x 100 x 60 voxels, 0.8 x 0.8 x 2.0 mm spacing, voxel axes along R, A and S, and the center of the volume at RAS (0, 0, 0). Fill it with 0, except for a cylinder of value 1000 with a radius of 15 mm that runs along the S axis through the whole volume, with its axis at R = 10, A = 0.",
    truth: truth(String.raw`
ph = _ev_node("Phantom", "vtkMRMLVolumeNode")
R["exists"] = bool(ph is not None and ph.IsA("vtkMRMLScalarVolumeNode") and ph.GetImageData() is not None)
if R["exists"]:
    arr = slicer.util.arrayFromVolume(ph)
    m = vtk.vtkMatrix4x4(); ph.GetIJKToRASMatrix(m)
    M = [[m.GetElement(r, c) for c in range(4)] for r in range(4)]
    R["dims"] = list(ph.GetImageData().GetDimensions()); R["spacing"] = list(ph.GetSpacing())
    dirs = np.array(M)[:3, :3] / np.array(ph.GetSpacing())[None, :]
    R["axes_ok"] = bool(np.allclose(dirs, np.eye(3), atol=1e-3))
    b = [0.0] * 6; ph.GetRASBounds(b); R["center"] = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2]
    x, y, z = _ev_axes(M, arr.shape)
    cyl = arr == 1000
    R["count"] = int(cyl.sum()); R["other"] = int((~cyl & (arr != 0)).sum())
    R["axis"] = [float(x[cyl].mean()), float(y[cyl].mean())] if cyl.any() else None
xi = (np.arange(100) - 49.5) * 0.8
R["want"] = int(((xi[None, :] - 10) ** 2 + xi[:, None] ** 2 <= 225).sum()) * 60`),
    judge(_a, t) {
      if (!t.exists) return [false, "no volume named Phantom"];
      const dims = String(t.dims) === "100,100,60";
      const sp = t.spacing.every((s, i) => Math.abs(s - [0.8, 0.8, 2][i]) < 1e-3);
      const ctr = t.center.every((c) => Math.abs(c) <= 1.0);
      const cyl = near(t.count, t.want, 0.03) && t.other === 0 && t.axis && Math.abs(t.axis[0] - 10) <= 0.5 && Math.abs(t.axis[1]) <= 0.5;
      const ok = dims && sp && t.axes_ok && ctr && cyl;
      return [ok, `dims ${dims ? "ok" : t.dims}, spacing ${sp ? "ok" : t.spacing}, axes ${t.axes_ok ? "ok" : "wrong"}, center ${ctr ? "ok" : f1(t.center)}, cylinder ${cyl ? "ok" : `${t.count} voxels (want ${t.want}), axis at ${t.axis ? f1(t.axis) : "-"}, other values ${t.other}`}`];
    },
    solution: String.raw`
import numpy as np
x0, y0, z0 = -49.5 * 0.8, -49.5 * 0.8, -29.5 * 2.0
i = np.arange(100); x = x0 + 0.8 * i; y = y0 + 0.8 * i
cyl = ((x[None, :] - 10) ** 2 + y[:, None] ** 2) <= 225
arr = np.zeros((60, 100, 100), np.int16); arr[:, cyl] = 1000
ph = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "Phantom")
slicer.util.updateVolumeFromArray(ph, arr); ph.SetSpacing(0.8, 0.8, 2.0); ph.SetOrigin(x0, y0, z0)
ph.CreateDefaultDisplayNodes()
print("created", ph.GetImageData().GetDimensions())`,
  },
  {
    id: "otsu-threshold",
    source: "https://discourse.slicer.org/t/19652",
    setup: LOAD,
    prompt: "Segment MRHead with an automatic Otsu threshold: make a new segmentation with one segment containing all voxels above the threshold. What threshold value did you use, and how many voxels are in the segment?",
    truth: truth(String.raw`
import vtkITK
c = vtkITK.vtkITKImageThresholdCalculator(); c.SetInputData(v.GetImageData()); c.SetMethodToOtsu(); c.Update()
h = np.bincount((a0 - a0.min()).ravel()).astype(float); vals = np.arange(h.size) + a0.min()
w0 = np.cumsum(h); w1 = w0[-1] - w0; m0 = np.cumsum(h * vals)
mu0 = m0 / np.maximum(w0, 1); mu1 = (m0[-1] - m0) / np.maximum(w1, 1)
R["otsu"] = [float(c.GetThreshold()), float(vals[np.argmax(w0 * w1 * (mu0 - mu1) ** 2)])]
R["ge"] = {int(t): int((a0 >= t).sum()) for t in range(15, 90)}
R["segs"] = []
for s in slicer.util.getNodesByClass("vtkMRMLSegmentationNode"):
    S = s.GetSegmentation()
    for i in range(S.GetNumberOfSegments()):
        R["segs"].append(int((slicer.util.arrayFromSegmentBinaryLabelmap(s, S.GetNthSegmentID(i), v) > 0).sum()))`),
    judge(answer, t) {
      const lo = 0.85 * Math.min(...t.otsu);
      const hi = 1.15 * Math.max(...t.otsu);
      const ts = Object.keys(t.ge).map(Number).filter((x) => x >= Math.floor(lo) && x <= Math.ceil(hi) + 1);
      const seg = t.segs.find((n) => ts.some((x) => near(n, t.ge[x], 0.002)));
      const said = numbers(answer).some((n) => n >= lo && n <= hi);
      const count = seg != null && hasNear(answer, seg, 0.01);
      return [seg != null && said && count, `segment ${seg != null ? "ok" : `none matches a threshold in ${lo.toFixed(0)}..${hi.toFixed(0)} (${t.segs})`}, threshold ${said ? "ok" : "missing"} (Otsu ${f1(t.otsu)}), count ${count ? "ok" : "missing"}`];
    },
    solution: String.raw`
import vtkITK, numpy as np
v = slicer.util.getNode("MRHead"); a = slicer.util.arrayFromVolume(v)
c = vtkITK.vtkITKImageThresholdCalculator(); c.SetInputData(v.GetImageData()); c.SetMethodToOtsu(); c.Update()
t = c.GetThreshold()
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Otsu"); seg.CreateDefaultDisplayNodes(); seg.SetReferenceImageGeometryParameterFromVolumeNode(v)
sid = seg.GetSegmentation().AddEmptySegment("Above")
mask = (a > t).astype(np.uint8); slicer.util.updateSegmentBinaryLabelmapFromArray(mask, seg, sid, v)
print("threshold", t, "voxels", int(mask.sum()))`,
  },
  {
    id: "volume-rendering",
    source: "https://discourse.slicer.org/t/3063",
    setup: LOAD,
    prompt: "Show MRHead in the 3D view with volume rendering using the 'MR-Default' preset, and hide the three slice planes in the 3D view.",
    truth: truth(String.raw`
vrl = slicer.modules.volumerendering.logic()
dn = vrl.GetFirstVolumeRenderingDisplayNode(v)
R["vr"] = bool(dn is not None and dn.GetVisibility())
if dn is not None and dn.GetVolumePropertyNode():
    def pts(f):
        out = []
        for i in range(f.GetSize()):
            q = [0.0] * 4; f.GetNodeValue(i, q); out.append(q[:2])
        return out
    want = pts(vrl.GetPresetByName("MR-Default").GetVolumeProperty().GetScalarOpacity())
    got = pts(dn.GetVolumePropertyNode().GetVolumeProperty().GetScalarOpacity())
    same = len(want) == len(got) and all(abs(g[1] - w[1]) < 1e-3 for g, w in zip(got, want))
    shifts = [g[0] - w[0] for g, w in zip(got, want)] if same else []
    R["preset"] = bool(same and max(shifts) - min(shifts) < 1e-3)
hidden = []
for name in ("Red", "Green", "Yellow"):
    sn = slicer.mrmlScene.GetNodeByID("vtkMRMLSliceNode" + name)
    model = slicer.util.getFirstNodeByName(name + " Volume Slice")
    md = model.GetDisplayNode() if model else None
    hidden.append(bool(not sn.GetSliceVisible() or (md is not None and not md.GetVisibility())))
R["hidden"] = hidden`),
    judge(_a, t) {
      const ok = t.vr && t.preset && t.hidden.every(Boolean);
      return [ok, `volume rendering ${t.vr ? "on" : "off"}, MR-Default ${t.preset ? "yes" : "no"}, slice planes hidden ${t.hidden}`];
    },
    solution: String.raw`
v = slicer.util.getNode("MRHead")
vrl = slicer.modules.volumerendering.logic()
dn = vrl.CreateDefaultVolumeRenderingNodes(v)
dn.GetVolumePropertyNode().Copy(vrl.GetPresetByName("MR-Default"))
dn.SetVisibility(True)
for name in ("Red", "Green", "Yellow"):
    slicer.mrmlScene.GetNodeByID("vtkMRMLSliceNode" + name).SetSliceVisible(False)
print("done")`,
  },
  {
    id: "fusion-display",
    source: "https://discourse.slicer.org/t/10087",
    setup: LOAD + String.raw`
thr = slicer.modules.volumes.logic().CloneVolume(slicer.mrmlScene, v, "Thr")
ta = slicer.util.arrayFromVolume(thr); ta[ta < 100] = 0; slicer.util.arrayFromVolumeModified(thr)
slicer.util.setSliceViewerLayers(background=v, foreground=None)
`,
    prompt: "Show MRHead as the background and 'Thr' as the foreground in all three slice views, with the foreground at 40% opacity, and display 'Thr' with the 'Rainbow' color table.",
    truth: truth(String.raw`
thr = _ev_node("Thr", "vtkMRMLScalarVolumeNode")
R["views"] = []
for name in ("Red", "Green", "Yellow"):
    c = slicer.mrmlScene.GetNodeByID("vtkMRMLSliceCompositeNode" + name)
    R["views"].append({"bg": c.GetBackgroundVolumeID() == v.GetID(), "fg": thr is not None and c.GetForegroundVolumeID() == thr.GetID(), "opacity": c.GetForegroundOpacity()})
cn = thr.GetDisplayNode().GetColorNode() if thr and thr.GetDisplayNode() else None
R["color"] = cn.GetName() if cn else None`),
    judge(_a, t) {
      const views = t.views.every((x) => x.bg && x.fg && Math.abs(x.opacity - 0.4) < 0.01);
      const color = t.color === "Rainbow";
      return [views && color, `views ${views ? "ok" : JSON.stringify(t.views)}, color table ${t.color}`];
    },
    solution: String.raw`
v = slicer.util.getNode("MRHead"); thr = slicer.util.getNode("Thr")
slicer.util.setSliceViewerLayers(background=v, foreground=thr, foregroundOpacity=0.4)
thr.GetDisplayNode().SetAndObserveColorNodeID("vtkMRMLColorTableNodeRainbow")
print("done")`,
  },
  {
    id: "curve-distance",
    source: "https://discourse.slicer.org/t/30750",
    setup: H + String.raw`
c = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsCurveNode", "Path")
for p in [(0, 0, 0), (20, 30, 0), (40, 0, 10), (60, 30, 20), (80, 0, 30)]:
    c.AddControlPointWorld(p)
x = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "X")
x.AddControlPointWorld((33, 24, 2))
`,
    prompt: "How long is curve 'Path', and what is the shortest distance from the point in point list 'X' to the curve?",
    truth: truth(String.raw`
c = _ev_node("Path", "vtkMRMLMarkupsCurveNode")
R["length"] = c.GetCurveLengthWorld()
P = _ev_ns.vtk_to_numpy(c.GetCurvePointsWorld().GetData()).astype(float)
q = np.array([33, 24, 2.0])
d = P[1:] - P[:-1]; t = np.clip(((q - P[:-1]) * d).sum(1) / np.maximum((d * d).sum(1), 1e-12), 0, 1)
R["distance"] = float(np.min(np.linalg.norm(P[:-1] + t[:, None] * d - q, axis=1)))
cp = np.array([(0, 0, 0), (20, 30, 0), (40, 0, 10), (60, 30, 20), (80, 0, 30.0)])
R["polyline_length"] = float(np.linalg.norm(cp[1:] - cp[:-1], axis=1).sum())`),
    judge(answer, t) {
      const len = hasNear(answer, t.length, 0.005);
      const dist = hasWithin(answer, t.distance, Math.max(0.2, 0.02 * t.distance));
      return [len && dist, `length ${len ? "ok" : "wrong"} (want ${t.length.toFixed(2)}; through the control points it is ${t.polyline_length.toFixed(2)}), distance ${dist ? "ok" : "wrong"} (want ${t.distance.toFixed(2)})`];
    },
    solution: String.raw`
import numpy as np
c = slicer.util.getNode("Path"); q = slicer.util.getNode("X").GetNthControlPointPositionWorld(0)
p = [0.0, 0.0, 0.0]; c.GetClosestPointPositionAlongCurveWorld(q, p)
print("length", c.GetCurveLengthWorld(), "mm, distance", np.linalg.norm(np.array(p) - np.array(q)), "mm")`,
  },
  {
    id: "model-area-volume",
    source: "https://discourse.slicer.org/t/43508",
    setup: LOAD + `seg = _ev_new_seg("Seg", v)\n_ev_add(seg, "Bright", ${BRIGHT("a")}, v)\n`,
    prompt: "Export segment 'Bright' from segmentation 'Seg' as a surface model named 'BrightModel', and tell me the model's surface area in mm² and the volume it encloses in mL.",
    truth: truth(String.raw`
mn = _ev_node("BrightModel", "vtkMRMLModelNode")
R["exists"] = bool(mn is not None and mn.IsA("vtkMRMLModelNode") and mn.GetPolyData() is not None and mn.GetPolyData().GetNumberOfPoints() > 0)
if R["exists"]:
    tri = vtk.vtkTriangleFilter(); tri.SetInputData(mn.GetPolyData())
    mp = vtk.vtkMassProperties(); mp.SetInputConnection(tri.GetOutputPort()); mp.Update()
    R["area"] = mp.GetSurfaceArea(); R["ml"] = mp.GetVolume() / 1000`),
    judge(answer, t) {
      if (!t.exists) return [false, "no model named BrightModel"];
      const area = hasNear(answer, t.area, 0.02);
      const ml = hasNear(answer, t.ml, 0.02);
      return [area && ml, `area ${area ? "ok" : "wrong"} (model has ${t.area.toFixed(0)} mm²), volume ${ml ? "ok" : "wrong"} (${t.ml.toFixed(2)} mL)`];
    },
    solution: String.raw`
import vtk
seg = slicer.util.getNode("Seg"); sid = seg.GetSegmentation().GetSegmentIdBySegmentName("Bright")
seg.CreateClosedSurfaceRepresentation()
pd = vtk.vtkPolyData(); seg.GetClosedSurfaceRepresentation(sid, pd)
mn = slicer.modules.models.logic().AddModel(pd); mn.SetName("BrightModel")
mp = vtk.vtkMassProperties(); mp.SetInputData(pd); mp.Update()
print("area", mp.GetSurfaceArea(), "mm2, volume", mp.GetVolume() / 1000, "mL")`,
  },
  {
    id: "outline-display",
    source: "https://discourse.slicer.org/t/20871",
    setup: LOAD + `seg = _ev_new_seg("Seg", v)\n_ev_add(seg, "Bright", ${BRIGHT("a")}, v, (0.2, 0.6, 1.0))\n_ev_add(seg, "Other", (a >= 80) & _ev_sphere(M0, a.shape, (20, 15, 25), 15), v, (0.9, 0.3, 0.3))\n`,
    prompt: "In the slice views, show segment 'Bright' (segmentation 'Seg') only as an outline, with no fill, with an outline thickness of 3 pixels, and make it yellow. Leave segment 'Other' as it is.",
    truth: truth(String.raw`
seg = _ev_node("Seg", "vtkMRMLSegmentationNode"); S = seg.GetSegmentation(); dn = seg.GetDisplayNode()
b, o = S.GetSegmentIdBySegmentName("Bright"), S.GetSegmentIdBySegmentName("Other")
fill2d, outline2d = dn.GetVisibility2DFill(), dn.GetVisibility2DOutline()
R["bright_fill"] = bool(dn.GetVisibility() and fill2d and dn.GetSegmentVisibility(b) and dn.GetSegmentVisibility2DFill(b) and dn.GetSegmentOpacity2DFill(b) * dn.GetOpacity2DFill() > 0)
R["bright_outline"] = bool(dn.GetVisibility() and outline2d and dn.GetSegmentVisibility(b) and dn.GetSegmentVisibility2DOutline(b) and dn.GetSegmentOpacity2DOutline(b) * dn.GetOpacity2DOutline() > 0)
R["other_fill"] = bool(dn.GetVisibility() and fill2d and dn.GetSegmentVisibility(o) and dn.GetSegmentVisibility2DFill(o))
R["other_outline"] = bool(dn.GetVisibility() and outline2d and dn.GetSegmentVisibility(o) and dn.GetSegmentVisibility2DOutline(o))
R["thickness"] = dn.GetSliceIntersectionThickness()
ov = list(dn.GetSegmentOverrideColor(b))
R["color"] = list(S.GetSegment(b).GetColor()); R["override"] = list(ov)
R["other_color"] = list(S.GetSegment(o).GetColor())`),
    judge(_a, t) {
      const yellow = (c) => Math.abs(c[0] - 1) < 0.05 && Math.abs(c[1] - 1) < 0.05 && c[2] < 0.05;
      const ov = t.override.some((x) => x > 0) ? t.override : null;
      const col = ov ? yellow(ov) : yellow(t.color);
      const other = t.other_fill && t.other_outline && Math.abs(t.other_color[0] - 0.9) < 0.01;
      const ok = !t.bright_fill && t.bright_outline && t.thickness === 3 && col && other;
      return [ok, `Bright fill ${t.bright_fill}, outline ${t.bright_outline}, thickness ${t.thickness}, color ${col ? "yellow" : f1(ov ?? t.color)}, Other ${other ? "unchanged" : "changed"}`];
    },
    solution: String.raw`
seg = slicer.util.getNode("Seg"); S = seg.GetSegmentation(); dn = seg.GetDisplayNode()
b = S.GetSegmentIdBySegmentName("Bright")
dn.SetSegmentVisibility2DFill(b, False); dn.SetSegmentVisibility2DOutline(b, True)
dn.SetSliceIntersectionThickness(3); S.GetSegment(b).SetColor(1, 1, 0)
print("done")`,
  },
  {
    id: "largest-cross-section",
    source: "https://discourse.slicer.org/t/20421",
    setup: LOAD + `seg = _ev_new_seg("Seg", v)\n_ev_add(seg, "Bright", ${BRIGHT("a")}, v)\n`,
    prompt: "Which sagittal slice of MRHead has the largest cross-sectional area of segment 'Bright' (segmentation 'Seg')? Give the slice's position as its R coordinate in mm, and the area in mm².",
    truth: truth(String.raw`
mask = ${BRIGHT("a0")}
per = mask.sum(axis=(1, 2))   # MRHead's K axis is R-L, so each K slice is sagittal
k = int(np.argmax(per)); R["ties"] = int((per == per[k]).sum())
R["r"] = M0[0][2] * k + M0[0][3]; R["area"] = float(per[k] * abs(M0[1][0]) * abs(M0[2][1]))
R["k"] = k`),
    judge(answer, t) {
      const r = hasWithin(answer, t.r, 0.7);
      const area = hasNear(answer, t.area, 0.01);
      return [r && area, `R ${r ? "ok" : "wrong"} (want ${t.r.toFixed(1)} mm, slice k=${t.k}), area ${area ? "ok" : "wrong"} (want ${t.area.toFixed(0)} mm²)${t.ties > 1 ? `, ${t.ties} tied slices` : ""}`];
    },
    solution: String.raw`
import numpy as np, vtk
seg = slicer.util.getNode("Seg"); v = slicer.util.getNode("MRHead")
mask = slicer.util.arrayFromSegmentBinaryLabelmap(seg, seg.GetSegmentation().GetSegmentIdBySegmentName("Bright"), v) > 0
per = mask.sum(axis=(1, 2)); k = int(np.argmax(per))
m = vtk.vtkMatrix4x4(); v.GetIJKToRASMatrix(m)
sp = v.GetSpacing()
print("slice k", k, "R", m.MultiplyPoint([0, 0, k, 1])[0], "mm, area", per[k] * sp[0] * sp[1], "mm2")`,
    wrong: String.raw`
import numpy as np
seg = slicer.util.getNode("Seg"); v = slicer.util.getNode("MRHead")
mask = slicer.util.arrayFromSegmentBinaryLabelmap(seg, seg.GetSegmentation().GetSegmentIdBySegmentName("Bright"), v) > 0
per = mask.sum(axis=(0, 2)); j = int(np.argmax(per))
print("slice", j, "R", -86.6 + 1.3 * j, "mm, area", per[j] * 1.3, "mm2")`,
  },
];
