---
name: slicerdome
description: How 3D Slicer runs in this page (SlicerWeb, WebAssembly and Pyodide) and what its Python can do here - install packages, download data, load files, and get public images from the NCI Imaging Data Commons (IDC).
---

# 3D Slicer in the browser

The Slicer next to the chat is SlicerWeb: 3D Slicer compiled to WebAssembly, with Python 3 from
Pyodide, all running in the user's browser tab. run_python runs your code in Slicer's Python, like
Slicer's Python console: slicer, slicer.util, vtk, qt and numpy are there, and variables persist
between calls.

## How it differs from desktop Slicer

- There is no operating system underneath: no subprocess, no pip command, no sockets. Files are in
  a file system in browser memory (use /tmp for your own). The user's own disk cannot be read;
  files the user drops on the page are copied in and loaded, and then show in the scene summary.
- Python runs on the page's main thread. A run_python call is stopped after 60 s of its own code,
  so do large jobs in steps. An exception inside an ITK filter ends the Python session, so check
  filter inputs first (for example, give vtkITKIslandMath an unsigned int image).
- Not available: the DICOM database and DICOM module (load DICOM files directly, see below), file
  dialogs, installing extensions from Python, and most CLI modules (for example N4 bias correction,
  BRAINSFit). These CLI modules work, with slicer.cli.runSync: Resample Scalar Volume, Gaussian
  Blur, Median, Threshold, Mask, Cast, Add and Subtract Scalar Volumes, Grayscale Model Maker.
- The Segment Editor cannot be scripted the desktop way (qMRMLSegmentEditorWidget has no
  activeEffect()). Change segments with numpy (arrayFromSegmentBinaryLabelmap,
  updateSegmentBinaryLabelmapFromArray) or VTK and vtkITK filters.

## Installing Python packages

Just import what you need. If the import fails because the package is missing, the page installs
it and runs your code again from the start; the result says so. slicer.util.pip_install("name")
works the same way. Packages come from Pyodide's own builds or, failing that, pure-Python wheels
on PyPI.

- Install: pandas, scipy, matplotlib (save figures to files), nibabel, pydicom, requests, duckdb,
  pyarrow, polars, dicomweb-client, tqdm and most pure-Python packages.
- Not installable here: scikit-image, SimpleITK, itk, opencv, scikit-learn, torch, monai,
  highdicom, psutil, idc-index (it needs the s5cmd program; use its data as shown below).
- For options, call micropip yourself:
  `from pyodide.ffi import run_sync; import micropip; run_sync(micropip.install("name", deps=False))`

## Downloading

The browser does the downloading, so a server must allow requests from other sites (CORS).
Amazon S3 and Google Cloud Storage public buckets do; GitHub release assets do not (the sample
data is mirrored on this site, so SampleData works).

- Sample data: `import SampleData; volume = SampleData.SampleDataLogic().downloadSample("MRHead")`
  (others include "CTChest", "CTACardio", "MRBrainTumor1").
- One file: `slicer.util.downloadFile(url, "/tmp/name.nrrd")`.
- Text: `from pyodide.http import open_url; text = open_url(url).read()`.
- Many files at once (much faster than one by one):

```python
import asyncio, os
from pyodide.http import pyfetch
from pyodide.ffi import run_sync

def download_all(urls, folder):
    os.makedirs(folder, exist_ok=True)
    async def get(url):
        r = await pyfetch(url)
        path = os.path.join(folder, url.rsplit("/", 1)[-1])
        with open(path, "wb") as f:
            f.write(await r.bytes())
        return path
    return run_sync(asyncio.gather(*[get(u) for u in urls]))
```

## Loading files

slicer.util.loadVolume, loadSegmentation, loadModel, loadMarkups and loadScene work on paths in
the browser's file system. For DICOM, give all files of one series together:
`ids = slicer.app.coreIOManager().loadFiles(paths)` loads .dcm files as one volume and returns the
new node IDs; name it with the series description.

## Imaging Data Commons (IDC)

IDC (imaging.datacommons.cancer.gov) has millions of public cancer imaging series (CT, MR, PET,
...), free and without an account. Its index of series comes with the idc-index-data package and
is queried with duckdb; the files are in public S3 buckets.

```python
import pandas, duckdb, idc_index_data  # the first time, installing these takes about a minute
INDEX = idc_index_data.IDC_INDEX_PARQUET_FILEPATH  # one row per series
df = duckdb.sql(f"""
  select collection_id, PatientID, Modality, BodyPartExamined, SeriesDescription,
         SeriesInstanceUID, series_aws_url, instanceCount, series_size_MB,
         license_short_name, source_DOI
  from read_parquet('{INDEX}')
  where collection_id = 'nlst' and Modality = 'CT'
    and instanceCount >= 50  -- skips scout images, which are a single slice
  order by series_size_MB limit 5""").df()
print(df.to_string())
```

Other columns: StudyInstanceUID, StudyDate, StudyDescription, PatientAge, PatientSex,
Manufacturer, ManufacturerModelName, SeriesNumber, SOPClassUID, crdc_series_uuid, aws_bucket.
List the collections with `select collection_id, count(*) from read_parquet('{INDEX}') group by 1`.
Prefer small series (series_size_MB) unless the user asks otherwise: everything is held in
browser memory.

Download a series and load it (series_aws_url looks like s3://bucket/uuid/*):

```python
import urllib.parse, xml.etree.ElementTree as ET
from pyodide.http import open_url

def idc_series_urls(series_aws_url):
    bucket, prefix = series_aws_url[len("s3://"):].rstrip("*").split("/", 1)
    ns, urls, token = "{http://s3.amazonaws.com/doc/2006-03-01/}", [], None
    while True:
        listing = f"https://{bucket}.s3.amazonaws.com/?list-type=2&prefix={prefix}"
        if token:
            listing += "&continuation-token=" + urllib.parse.quote(token)
        root = ET.fromstring(open_url(listing).read())
        urls += [f"https://{bucket}.s3.amazonaws.com/{k.text}" for k in root.iter(ns + "Key")]
        token = root.findtext(ns + "NextContinuationToken")
        if not token:
            return urls

row = df.iloc[0]
paths = download_all(idc_series_urls(row.series_aws_url), f"/tmp/idc/{row.SeriesInstanceUID}")
ids = slicer.app.coreIOManager().loadFiles(paths)
volume = slicer.mrmlScene.GetNodeByID(ids[0])
volume.SetName(f"{row.PatientID} {row.SeriesDescription}")
slicer.util.setSliceViewerLayers(background=volume, fit=True)
```

A 140-slice CT series (12 MB) takes about 5 s to download and 1 s to load. When you show IDC
data, mention its collection, license_short_name and source_DOI.
