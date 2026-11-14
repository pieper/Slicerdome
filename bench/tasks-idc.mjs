// Tasks that need public data from the NCI Imaging Data Commons (IDC): finding it with the
// idc-index-data package and downloading it from IDC's public buckets, which SKILL.md describes.
// Same shape as tasks-hard.mjs (prompt, truth, judge, solution, wrong). The truth scripts look the
// series up in the same index the models use, so the checks follow new IDC releases.
import { numbers } from "./tasks.mjs";

// Python packages are installed on import (the page installs a missing module and runs again).
const INDEX = `
import json, os
import duckdb, idc_index_data
_ev_INDEX = idc_index_data.IDC_INDEX_PARQUET_FILEPATH
`;

// The reference solutions use the recipe in SKILL.md.
const DOWNLOAD = String.raw`
import asyncio, os, urllib.parse, xml.etree.ElementTree as ET
import pandas, duckdb, idc_index_data
from pyodide.http import pyfetch, open_url
from pyodide.ffi import run_sync
INDEX = idc_index_data.IDC_INDEX_PARQUET_FILEPATH

def download_all(urls, folder):
    os.makedirs(folder, exist_ok=True)
    async def get(url):
        r = await pyfetch(url)
        path = os.path.join(folder, url.rsplit("/", 1)[-1])
        with open(path, "wb") as f:
            f.write(await r.bytes())
        return path
    return run_sync(asyncio.gather(*[get(u) for u in urls]))

def idc_series_urls(series_aws_url):
    bucket, prefix = series_aws_url[len("s3://"):].rstrip("*").split("/", 1)
    ns, urls, token = "{http://s3.amazonaws.com/doc/2006-03-01/}", [], None
    while True:
        listing = f"https://{bucket}.s3.amazonaws.com/?list-type=2&prefix={prefix}"
        if token:
            listing += "&continuation-token=" + urllib.parse.quote(token)
        root = ET.fromstring(open_url(listing).read())
        urls += [f"https://{bucket}.s3.amazonaws.com/{k.text}" for k in root.iter(ns + "Key")
                 if not k.text.endswith("/")]  # some series also list their folder
        token = root.findtext(ns + "NextContinuationToken")
        if not token:
            return urls
`;

/** Lowercase letters and digits only, so "QIN-Prostate-Repeatability" matches qin_prostate_repeatability. */
const squash = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export const TASKS = [
  {
    id: "idc-modality-counts",
    prompt: "How many series of each modality does the QIN-Prostate-Repeatability collection have in the NCI Imaging Data Commons (IDC)?",
    truth: `${INDEX}
rows = duckdb.sql(f"select Modality, count(*) from read_parquet('{_ev_INDEX}') where collection_id = 'qin_prostate_repeatability' group by 1").fetchall()
print(json.dumps({"counts": {m: n for m, n in rows}}))`,
    judge(answer, t) {
      const counts = Object.entries(t.counts ?? {});
      if (!counts.length) return [false, `no counts from the index: ${JSON.stringify(t).slice(0, 200)}`];
      const found = numbers(answer);
      const missing = counts.filter(([, n]) => !found.includes(n));
      return [!missing.length, missing.length ? `missing ${missing.map(([m, n]) => `${m} ${n}`).join(", ")}` : `all of ${counts.map(([m, n]) => `${m} ${n}`).join(", ")}`];
    },
    solution: `${DOWNLOAD}
print(duckdb.sql(f"select Modality, count(*) as series from read_parquet('{INDEX}') where collection_id = 'qin_prostate_repeatability' group by 1").df().to_string())`,
    // Counting patients instead of series.
    wrong: `${DOWNLOAD}
print(duckdb.sql(f"select Modality, count(distinct PatientID) from read_parquet('{INDEX}') where collection_id = 'qin_prostate_repeatability' group by 1").df().to_string())`,
  },
  {
    id: "idc-prostate-mr",
    prompt: "Load a prostate MRI from the NCI Imaging Data Commons (IDC) into Slicer and show it in the slice views. Tell me its patient ID and the collection it comes from.",
    // Each volume's DICOM series (from its files, or else from DICOM files on disk with as many
    // slices), looked up in the IDC index.
    truth: String.raw`${INDEX}
import pydicom, slicer
def _ev_uids(path):
    try:
        d = pydicom.dcmread(path, stop_before_pixels=True, specific_tags=["SeriesInstanceUID", "SOPInstanceUID"])
        return str(d.SeriesInstanceUID), str(d.SOPInstanceUID)
    except Exception:
        return None, None
def _ev_uid(path):
    return _ev_uids(path)[0]
_ev_on_disk = None
def _ev_disk_series():
    # Series UID -> number of instances, in DICOM files the agent wrote (not under Slicer's own
    # folders); a series downloaded twice counts once
    global _ev_on_disk
    if _ev_on_disk is None:
        _ev_on_disk, n = {}, 0
        roots = ["/tmp", "/home", "/data"]
        if os.getcwd() != "/" and not any(os.getcwd().startswith(r) for r in roots):
            roots.append(os.getcwd())
        for root in roots:
            for d, _, files in os.walk(root):
                for f in files:
                    if n > 20000 or not (f.lower().endswith(".dcm") or "." not in f):
                        continue
                    n += 1
                    u, sop = _ev_uids(os.path.join(d, f))
                    if u:
                        _ev_on_disk.setdefault(u, set()).add(sop)
        _ev_on_disk = {u: len(sops) for u, sops in _ev_on_disk.items()}
    return _ev_on_disk
red = slicer.app.layoutManager().sliceWidget("Red").sliceLogic().GetBackgroundLayer().GetVolumeNode()
vols = []
for v in slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode"):
    if v.GetImageData() is None:
        continue
    dims = list(v.GetImageData().GetDimensions())
    sn = v.GetStorageNode()
    files = [f for f in ([sn.GetFileName()] + [sn.GetNthFileName(i) for i in range(sn.GetNumberOfFileNames())] if sn else []) if f]
    uids = sorted({u for u in map(_ev_uid, files[:3]) if u})
    via = "files"
    if not uids:
        uids = sorted(u for u, n in _ev_disk_series().items() if n == dims[2])
        via = "disk"
    vols.append({"name": v.GetName(), "dims": dims, "red": red is v, "uids": uids, "via": via})
uids = sorted({u for v in vols for u in v["uids"]})
idc = {}
if uids:
    q = ", ".join("'%s'" % u for u in uids)
    for row in duckdb.sql(f"select SeriesInstanceUID, collection_id, PatientID, Modality, BodyPartExamined, instanceCount from read_parquet('{_ev_INDEX}') where SeriesInstanceUID in ({q})").fetchall():
        idc[row[0]] = dict(zip(["uid", "collection", "patient", "modality", "body", "instances"], row))
for v in vols:
    v["idc"] = [idc[u] for u in v["uids"] if u in idc]
    del v["uids"]
print(json.dumps({"volumes": vols}))`,
    judge(answer, t) {
      const vols = t.volumes ?? [];
      if (!vols.length) return [false, "no volume loaded"];
      const fromIdc = vols.filter((v) => v.idc?.length);
      if (!fromIdc.length) return [false, `no volume from IDC (${vols.map((v) => v.name).join(", ")})`];
      const prostate = (s) => s.modality === "MR" && (/PROSTATE|PELVIS/.test(s.body ?? "") || /prostat|prad|pca/.test(s.collection));
      const shown = fromIdc.find((v) => v.red) ?? fromIdc[0];
      const s = shown.idc[0];
      const a = squash(answer);
      const checks = {
        "prostate MR": shown.idc.some(prostate),
        "a 3D volume": shown.dims[2] >= 5,
        "shown in the slice views": shown.red,
        "patient ID in the answer": a.includes(squash(s.patient)),
        "collection in the answer": a.includes(squash(s.collection)),
      };
      const failed = Object.keys(checks).filter((k) => !checks[k]);
      const what = `${s.collection} ${s.patient} ${s.modality} ${s.body ?? ""} (${shown.dims.join("x")}, found ${shown.via === "disk" ? "by its files on disk" : "from its file"})`;
      return [!failed.length, failed.length ? `${what}: not ${failed.join(", not ")}` : what];
    },
    solution: `${DOWNLOAD}
df = duckdb.sql(f"""
  select collection_id, PatientID, SeriesDescription, SeriesInstanceUID, series_aws_url
  from read_parquet('{INDEX}')
  where Modality = 'MR' and BodyPartExamined = 'PROSTATE' and instanceCount >= 15
  order by series_size_MB limit 1""").df()
row = df.iloc[0]
paths = download_all(idc_series_urls(row.series_aws_url), f"/tmp/idc/{row.SeriesInstanceUID}")
ids = slicer.app.coreIOManager().loadFiles(paths)
volume = slicer.mrmlScene.GetNodeByID(ids[0])
volume.SetName(f"{row.PatientID} {row.SeriesDescription}")
slicer.util.setSliceViewerLayers(background=volume, fit=True)
print(f"Patient {row.PatientID} from the collection {row.collection_id}")`,
    // Built from the pixel data, so the volume has no file name (the check finds its files on disk).
    also: [`${DOWNLOAD}
import numpy as np, pydicom
row = duckdb.sql(f"select * from read_parquet('{INDEX}') where Modality = 'MR' and BodyPartExamined = 'PROSTATE' and instanceCount >= 15 order by series_size_MB limit 1").df().iloc[0]
slices = sorted((pydicom.dcmread(p) for p in download_all(idc_series_urls(row.series_aws_url), "/tmp/series")), key=lambda d: float(d.ImagePositionPatient[2]))
volume = slicer.util.addVolumeFromArray(np.stack([d.pixel_array for d in slices]), name=row.PatientID)
slicer.util.setSliceViewerLayers(background=volume, fit=True)
print(row.PatientID, row.collection_id)`],
    // A sample volume presented as IDC data.
    wrong: `
import SampleData
v = SampleData.SampleDataLogic().downloadSample("MRHead")
slicer.util.setSliceViewerLayers(background=v, fit=True)
print("Patient ProstateX-0000 from the collection prostatex")`,
  },
];
