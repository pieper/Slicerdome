// Files dropped anywhere on the page, on the chat or on the Slicer views, are loaded into Slicer.
// SlicerWeb takes drops only on its Data panel and refuses them elsewhere in its frame; this takes
// every file drop on the page and in the frame before SlicerWeb sees it, so that all of them load
// the same way (SlicerBridge.loadFiles) and the chat can say what was loaded.

/** The files of a drop, folders walked; a file inside a folder gets its path as webkitRelativePath. */
export async function droppedFiles(dataTransfer) {
  // The items can be read only while the event is being handled: take them before any await.
  const items = [...(dataTransfer?.items ?? [])].filter((item) => item.kind === "file");
  const sources = items.map((item) => item.webkitGetAsEntry?.() ?? item.getAsFile());
  if (!items.length) sources.push(...(dataTransfer?.files ?? []));
  const files = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      if (prefix) Object.defineProperty(file, "webkitRelativePath", { value: prefix + file.name });
      files.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const source of sources) {
    if (!source) continue;
    // (a File from the Slicer frame is not an instance of this window's File, so test for an entry)
    if (typeof source.isFile === "boolean") await walk(source, "");
    else files.push(source);
  }
  return files;
}

/**
 * Take file drops on a window (the page's, or the Slicer frame's): onHover() is called while files
 * are dragged over it, onFiles(files) when they are dropped. Other drags are left alone.
 */
export function watchDrops(win, { onHover, onFiles }) {
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  const over = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    onHover();
  };
  const drop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    droppedFiles(e.dataTransfer).then(onFiles, (err) => onFiles([], err));
  };
  // Capture: before the page's own handlers, so SlicerWeb's Data panel and its refusal elsewhere see nothing.
  win.addEventListener("dragenter", over, true);
  win.addEventListener("dragover", over, true);
  win.addEventListener("drop", drop, true);
}
