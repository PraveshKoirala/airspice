/**
 * AC#6 — Import is untrusted input; routed through the air-ts XML byte-security
 * gate BEFORE it can touch app state, and a corrupt/malicious file never
 * destroys the currently-open project.
 *
 * Contract (PRD #26 criterion 6): "Importing a file routes through the air-ts
 * XML byte-security gate (`parseXmlBytes` / the #43 contract: size/depth/DOCTYPE)
 * BEFORE normalize/validate, and a corrupt/malicious file never destroys the
 * currently-open project."
 *
 * Real entry points: `openFromDisk()` from `src/storage/fileIo.ts` (both the FSA
 * and fallback branches) and the `useProjectStore` state, exercised the way
 * `Sidebar.handleImport` uses them (openFromDisk -> on success createProject; on
 * throw the import is aborted).
 *
 * Genuine failure modes this catches:
 *   - An import that decodes/normalizes the bytes WITHOUT the gate accepts the
 *     DOCTYPE / oversized file (no throw) -> the reject assertions FAIL.
 *   - An import flow that mutates the open project before the gate runs (or that
 *     swallows the error and clears state) -> the "open project intact" test
 *     FAILS.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { MAX_INPUT_BYTES } from "air-ts";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const DOCTYPE_BYTES = new TextEncoder().encode(
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE system [<!ENTITY xxe "boom">]>\n<system name="evil">&xxe;</system>`,
);

function makeFsaWindow(bytes: Uint8Array) {
  const handle = {
    name: "import.xml",
    async getFile() {
      return {
        name: "import.xml",
        async arrayBuffer() {
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          );
        },
      };
    },
  };
  return { showOpenFilePicker: async () => [handle] };
}

function makeFallbackDocument(bytes: Uint8Array) {
  const file = {
    name: "import.xml",
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
  };
  const input: Record<string, unknown> = {
    files: [file],
    click() {
      Promise.resolve().then(() => (input.onchange as () => void)());
    },
  };
  return { createElement: () => input };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function importAndCatch(): Promise<unknown> {
  const { openFromDisk } = await import("../../src/storage/fileIo");
  try {
    await openFromDisk();
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("AC#6 import routes through the security gate", () => {
  it("rejects a DOCTYPE/XXE file via the FSA path (SEC-001)", async () => {
    vi.stubGlobal("window", makeFsaWindow(DOCTYPE_BYTES));
    const err = (await importAndCatch()) as { name?: string; code?: string };
    expect(err).toBeDefined();
    expect(err.name).toBe("XmlSecurityError");
    expect(err.code).toBe("SEC-001");
  });

  it("rejects an oversized file via the FSA path (SEC-002)", async () => {
    const big = new Uint8Array(MAX_INPUT_BYTES + 1024).fill(0x41); // 'A' * (>5MB)
    vi.stubGlobal("window", makeFsaWindow(big));
    const err = (await importAndCatch()) as { name?: string; code?: string };
    expect(err).toBeDefined();
    expect(err.name).toBe("XmlSecurityError");
    expect(err.code).toBe("SEC-002");
  });

  it("rejects a DOCTYPE file via the fallback <input type=file> path (SEC-001)", async () => {
    vi.stubGlobal("window", {}); // no showOpenFilePicker -> fallback
    vi.stubGlobal("document", makeFallbackDocument(DOCTYPE_BYTES));
    const err = (await importAndCatch()) as { name?: string; code?: string };
    expect(err).toBeDefined();
    expect(err.name).toBe("XmlSecurityError");
    expect(err.code).toBe("SEC-001");
  });

  it("leaves the currently-open project intact when an import is rejected", async () => {
    const { useProjectStore } = await import("../../src/storage/projectStore");
    const { useDesignStore } = await import("../../src/agent/designStore");

    await useProjectStore.getState().init();
    const KEEP_XML = "<system name='keep_me_open'/>";
    const id = await useProjectStore.getState().createProject("Keep", KEEP_XML);

    const beforeActive = useProjectStore.getState().activeProjectId;
    const beforeXml = useDesignStore.getState().xml;
    const beforeCount = useProjectStore.getState().projectsList.length;
    expect(beforeActive).toBe(id);
    expect(beforeXml).toBe(KEEP_XML);

    // Simulate Sidebar.handleImport with a malicious file.
    vi.stubGlobal("window", makeFsaWindow(DOCTYPE_BYTES));
    const { openFromDisk } = await import("../../src/storage/fileIo");
    let threw = false;
    try {
      const res = await openFromDisk();
      if (res) {
        await useProjectStore.getState().createProject(res.name, res.xml);
      }
    } catch {
      threw = true; // handleImport shows a diagnostic; state is untouched
    }
    expect(threw).toBe(true);

    // Nothing about the open project changed; no partial/new project created.
    expect(useProjectStore.getState().activeProjectId).toBe(beforeActive);
    expect(useDesignStore.getState().xml).toBe(beforeXml);
    expect(useProjectStore.getState().projectsList.length).toBe(beforeCount);
    const { getProject } = await import("../../src/storage/db");
    expect((await getProject(id))!.xml).toBe(KEEP_XML);
  });
});
