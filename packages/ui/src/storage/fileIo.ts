import { parseXmlBytes } from "air-ts";

/**
 * Check if the File System Access API is supported by the browser.
 */
export function isFileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}

/**
 * Open a file picker, read the file, and run it through the XML security check.
 */
export async function openFromDisk(): Promise<{
  xml: string;
  name: string;
  fileHandle?: FileSystemFileHandle;
} | null> {
  if (isFileSystemAccessSupported()) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [handle] = await (window as any).showOpenFilePicker({
        types: [
          {
            description: "AIR XML Designs",
            accept: { "text/xml": [".xml", ".air.xml"] },
          },
        ],
        multiple: false,
      });
      if (!handle) return null;

      const file = await handle.getFile();
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // XML Security Gate check
      parseXmlBytes(bytes);

      const xml = new TextDecoder("utf-8").decode(bytes);
      return { xml, name: file.name.replace(/\.air\.xml$|\.xml$/, ""), fileHandle: handle };
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        return null;
      }
      throw e;
    }
  }

  // Fallback path (Firefox/Safari)
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".xml,.air.xml";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }

      try {
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        // XML Security Gate check
        parseXmlBytes(bytes);

        const xml = new TextDecoder("utf-8").decode(bytes);
        resolve({ xml, name: file.name.replace(/\.air\.xml$|\.xml$/, "") });
      } catch (e) {
        reject(e);
      }
    };
    input.onerror = (err) => reject(err);
    input.click();
  });
}

/**
 * Save XML text directly to an existing file handle.
 */
export async function saveToDisk(
  xml: string,
  handle: FileSystemFileHandle
): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(xml);
  await writable.close();
}

/**
 * Prompt the user to choose a file path and write the XML to it.
 */
export async function saveAsToDisk(
  xml: string,
  suggestedName: string
): Promise<FileSystemFileHandle | null> {
  if (isFileSystemAccessSupported()) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: suggestedName.endsWith(".air.xml")
          ? suggestedName
          : `${suggestedName}.air.xml`,
        types: [
          {
            description: "AIR XML Design",
            accept: { "text/xml": [".air.xml", ".xml"] },
          },
        ],
      });
      await saveToDisk(xml, handle);
      return handle;
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        return null;
      }
      throw e;
    }
  }

  // Fallback download blob
  const blob = new Blob([xml], { type: "text/xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName.endsWith(".air.xml")
    ? suggestedName
    : `${suggestedName}.air.xml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return null;
}
