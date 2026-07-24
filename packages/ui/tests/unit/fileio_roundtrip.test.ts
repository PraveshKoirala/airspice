/**
 * AC#5 — File I/O both paths, byte-exact round-trip.
 *
 * Contract (PRD #26 criterion 5): "Save-to-disk / Open-from-disk via the File
 * System Access API where available (feature-detected), with a download-blob /
 * <input type=file> fallback elsewhere. BOTH paths are exercised by tests (do
 * not test only the Chrome path). Save/Open round-trips the XML byte-exactly."
 *
 * Real entry points: `saveAsToDisk` / `saveToDisk` / `openFromDisk` /
 * `isFileSystemAccessSupported` from `src/storage/fileIo.ts`. The FSA-vs-fallback
 * branch is feature-detected on `window.showOpenFilePicker`, so each test stubs
 * `window`/`document`/`URL` to select the branch under test — no jsdom needed.
 *
 * Genuine failure modes this catches:
 *   - A save that alters the bytes (BOM, re-encode, trailing newline munging)
 *     breaks the byte-exact round-trip.
 *   - A fallback download that writes something other than the raw XML fails.
 *   - Skipping the fallback entirely (Chrome-only) leaves those tests unable to
 *     run the code path -> FAIL.
 */

import "fake-indexeddb/auto"; // harmless here; keeps the storage-test env uniform
import { afterEach, describe, it, expect, vi } from "vitest";
import { saveAsToDisk, saveToDisk, openFromDisk, isFileSystemAccessSupported } from "../../src/storage/fileIo";

const VALID_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n<system name="roundtrip" ir_version="0.1">\n  <nets>\n    <net id="gnd" role="ground"/>\n  </nets>\n  <components/>\n  <simulation_profiles/>\n</system>\n`;

function bytesEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  for (let i = 0; i < ea.length; i++) if (ea[i] !== eb[i]) return false;
  return true;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// File System Access API path (Chromium): save then open -> byte-exact.
// ---------------------------------------------------------------------------
describe("AC#5 File System Access path", () => {
  it("round-trips XML byte-exactly through showSaveFilePicker + showOpenFilePicker", async () => {
    // A tiny in-memory "disk file" the fake handle reads/writes.
    let diskContent = "";
    let savedName = "";

    const fakeSaveHandle = {
      name: "roundtrip.air.xml",
      async createWritable() {
        return {
          async write(data: string) {
            diskContent = data;
          },
          async close() {},
        };
      },
    };
    const fakeOpenHandle = {
      name: "roundtrip.air.xml",
      async getFile() {
        return {
          name: "roundtrip.air.xml",
          async arrayBuffer() {
            return new TextEncoder().encode(diskContent).buffer;
          },
        };
      },
    };

    vi.stubGlobal("window", {
      showSaveFilePicker: async (opts: { suggestedName: string }) => {
        savedName = opts.suggestedName;
        return fakeSaveHandle;
      },
      showOpenFilePicker: async () => [fakeOpenHandle],
    });

    expect(isFileSystemAccessSupported()).toBe(true);

    // Save
    const handle = await saveAsToDisk(VALID_XML, "roundtrip");
    expect(handle).not.toBeNull();
    expect(savedName).toBe("roundtrip.air.xml");
    expect(diskContent).toBe(VALID_XML);

    // Open (routes through the security gate) -> byte-exact
    const opened = await openFromDisk();
    expect(opened).not.toBeNull();
    expect(opened!.xml).toBe(VALID_XML);
    expect(bytesEqual(opened!.xml, VALID_XML)).toBe(true);
  });

  it("saveToDisk writes the exact XML to an existing handle", async () => {
    let written = "";
    const handle = {
      name: "x.air.xml",
      async createWritable() {
        return {
          async write(d: string) {
            written = d;
          },
          async close() {},
        };
      },
    } as unknown as FileSystemFileHandle;

    await saveToDisk(VALID_XML, handle);
    expect(written).toBe(VALID_XML);
  });
});

// ---------------------------------------------------------------------------
// Fallback path (Firefox/Safari): download-blob save + <input type=file> open.
// ---------------------------------------------------------------------------
describe("AC#5 fallback path", () => {
  it("saves via a download blob whose bytes equal the XML exactly", async () => {
    let capturedBlob: Blob | null = null;

    // window WITHOUT showOpenFilePicker -> feature detection selects fallback.
    vi.stubGlobal("window", {});
    vi.stubGlobal("URL", {
      createObjectURL: (b: Blob) => {
        capturedBlob = b;
        return "blob:fake";
      },
      revokeObjectURL: () => {},
    });
    const anchor: Record<string, unknown> = { click: () => {} };
    vi.stubGlobal("document", {
      createElement: () => anchor,
      body: { appendChild: () => {}, removeChild: () => {} },
    });

    expect(isFileSystemAccessSupported()).toBe(false);

    const result = await saveAsToDisk(VALID_XML, "roundtrip");
    expect(result).toBeNull(); // fallback returns no handle
    expect(anchor.download).toBe("roundtrip.air.xml");
    expect(capturedBlob).not.toBeNull();
    const text = await (capturedBlob as unknown as Blob).text();
    expect(text).toBe(VALID_XML);
    expect(bytesEqual(text, VALID_XML)).toBe(true);
  });

  it("opens via <input type=file>, routes through the gate, and returns exact XML", async () => {
    const fakeFile = {
      name: "loaded.air.xml",
      async arrayBuffer() {
        return new TextEncoder().encode(VALID_XML).buffer;
      },
    };
    // A fake <input> whose click() fires the onchange handler the code installs.
    const input: Record<string, unknown> = {
      files: [fakeFile],
      click() {
        // Simulate the user picking a file.
        Promise.resolve().then(() => (input.onchange as () => void)());
      },
    };

    vi.stubGlobal("window", {}); // no FSA -> fallback
    vi.stubGlobal("document", { createElement: () => input });

    const opened = await openFromDisk();
    expect(opened).not.toBeNull();
    expect(opened!.xml).toBe(VALID_XML);
    expect(bytesEqual(opened!.xml, VALID_XML)).toBe(true);
  });
});
