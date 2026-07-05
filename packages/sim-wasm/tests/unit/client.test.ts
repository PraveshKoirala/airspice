/**
 * SimClient plumbing tests against the stub worker (no WASM). Covers the
 * protocol surface: run() streaming, preload() capabilities, and the
 * terminate+respawn cancellation model (ADR 0011). Real-engine behavior is
 * covered by the Playwright browser tests; this is the deterministic logic tier.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SimClient } from "../../src/client";
import type { SimEvent } from "../../src/protocol";
import { StubWorker, stubStats, type StubBehavior } from "./stub-worker";

function makeClient(behavior: StubBehavior): SimClient {
  return new SimClient(() => new StubWorker(behavior) as unknown as Worker);
}

async function collect(stream: AsyncIterable<SimEvent>): Promise<SimEvent[]> {
  const out: SimEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

beforeEach(() => {
  stubStats.created = 0;
  stubStats.terminated = 0;
});

describe("SimClient.run", () => {
  it("streams events to completion and ends on result", async () => {
    const client = makeClient({
      onRun: (id) => [
        { id, type: "progress", pct: 0, simTime: 0 },
        { id, type: "stdout", line: "run starting" },
        { id, type: "result", tables: [] },
      ],
    });
    const events = await collect(client.run({ id: "r1", netlist: "* x\n.end" }));
    expect(events.map((e) => e.type)).toEqual(["progress", "stdout", "result"]);
    client.dispose();
  });

  it("ends the stream on an error event", async () => {
    const client = makeClient({
      onRun: (id) => [
        {
          id,
          type: "error",
          diagnostic: { code: "SIM-X", message: "m", hint: "", severity: "error", raw: "r" },
        },
      ],
    });
    const events = await collect(client.run({ id: "r2", netlist: "* x" }));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    client.dispose();
  });

  it("correlates concurrent runs by id", async () => {
    const client = makeClient({
      onRun: (id) => [
        { id, type: "stdout", line: `line-${id}` },
        { id, type: "result", tables: [] },
      ],
    });
    const [a, b] = await Promise.all([
      collect(client.run({ id: "A", netlist: "*" })),
      collect(client.run({ id: "B", netlist: "*" })),
    ]);
    expect((a[0] as { line: string }).line).toBe("line-A");
    expect((b[0] as { line: string }).line).toBe("line-B");
    client.dispose();
  });
});

describe("SimClient.preload", () => {
  it("resolves with advertised capabilities (control:false for eecircuit)", async () => {
    const client = makeClient({
      capabilities: {
        control: false,
        engine: "eecircuit-engine",
        engineVersion: "1.7.0",
        ngspiceVersion: "45.2",
      },
    });
    const caps = await client.preload();
    expect(caps.control).toBe(false);
    expect(caps.engine).toBe("eecircuit-engine");
    expect(client.getCapabilities()?.ngspiceVersion).toBe("45.2");
    client.dispose();
  });
});

describe("SimClient.cancel (terminate + respawn)", () => {
  it("settles a canceled in-flight run with SIM-CANCELED and terminates the worker", async () => {
    // A run that never completes on its own (empty async that resolves to no
    // events) so cancel must be what ends it.
    let releaseRun: () => void = () => {};
    const client = makeClient({
      onRun: () =>
        new Promise<SimEvent[]>((resolve) => {
          releaseRun = () => resolve([]);
        }),
    });
    const stream = client.run({ id: "long", netlist: "* long .tran" });
    const events: SimEvent[] = [];
    const consume = (async () => {
      for await (const ev of stream) events.push(ev);
    })();

    // Cancel mid-run.
    client.cancel("long");
    await consume;

    expect(events.at(-1)?.type).toBe("error");
    expect((events.at(-1) as { diagnostic: { code: string } }).diagnostic.code).toBe(
      "SIM-CANCELED",
    );
    expect(stubStats.terminated).toBe(1);
    releaseRun();
    client.dispose();
  });

  it("respawns a fresh worker so the NEXT run succeeds after a cancel", async () => {
    const client = makeClient({
      onRun: (id) =>
        id === "will-cancel"
          ? new Promise<SimEvent[]>(() => {}) // never resolves
          : [
              { id, type: "stdout", line: "ok" },
              { id, type: "result", tables: [] },
            ],
    });

    // Start and cancel the first run.
    const first = client.run({ id: "will-cancel", netlist: "*" });
    const firstConsume = collect(first);
    client.cancel("will-cancel");
    await firstConsume;
    expect(stubStats.terminated).toBe(1);
    expect(stubStats.created).toBe(2); // original + respawn

    // The next run must work on the fresh worker.
    const second = await collect(client.run({ id: "next", netlist: "*" }));
    expect(second.map((e) => e.type)).toEqual(["stdout", "result"]);
    client.dispose();
  });

  it("cancel on an unknown id is a no-op (does not kill the worker)", async () => {
    const client = makeClient({ onRun: (id) => [{ id, type: "result", tables: [] }] });
    await collect(client.run({ id: "done", netlist: "*" }));
    client.cancel("nonexistent");
    expect(stubStats.terminated).toBe(0);
    client.dispose();
  });
});
