import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MockProvider, type MockFixture } from "../src/index.js";
import { collect, joinText, makeRequest, toolCalls } from "./helpers.js";

function loadFixture(name: string): MockFixture {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as MockFixture;
}

describe("MockProvider: deterministic 3-step tool conversation", () => {
  const fixture = loadFixture("three_step_tool_conversation.json");

  it("replays each of the 3 turns in order", async () => {
    const provider = new MockProvider(fixture);

    // Turn 1: list_registry_parts, ends tool_use.
    const t1 = await collect(provider.chat(makeRequest()));
    expect(joinText(t1)).toBe("Let me check the available parts first.");
    expect(toolCalls(t1).map((c) => c.name)).toEqual(["list_registry_parts"]);
    expect(t1.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });

    // Turn 2: validate_design, ends tool_use.
    const t2 = await collect(provider.chat(makeRequest()));
    const t2Calls = toolCalls(t2);
    expect(t2Calls).toHaveLength(1);
    expect(t2Calls[0]!.name).toBe("validate_design");
    expect(t2Calls[0]!.args).toEqual({ design_path: "generated/ui_work/design.air.xml" });
    expect(t2.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });

    // Turn 3: final answer, ends stop.
    const t3 = await collect(provider.chat(makeRequest()));
    expect(joinText(t3)).toBe("The design validates cleanly. Your regulator rail is ready.");
    expect(toolCalls(t3)).toHaveLength(0);
    expect(t3.at(-1)).toEqual({ type: "done", stopReason: "stop" });
  });

  it("is byte-identical across independent replays (determinism)", async () => {
    const runAll = async () => {
      const p = new MockProvider(fixture);
      const all: unknown[] = [];
      for (let i = 0; i < fixture.turns.length; i++) {
        all.push(await collect(p.chat(makeRequest())));
      }
      return JSON.stringify(all);
    };
    const runA = await runAll();
    const runB = await runAll();
    expect(runA).toBe(runB);
  });

  it("reset() rewinds the replay cursor", async () => {
    const provider = new MockProvider(fixture);
    const first = await collect(provider.chat(makeRequest()));
    provider.reset();
    const again = await collect(provider.chat(makeRequest()));
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
  });

  it("yields a terminal done past the end of the script", async () => {
    const provider = new MockProvider({ turns: [] });
    const events = await collect(provider.chat(makeRequest()));
    expect(events).toEqual([{ type: "done", stopReason: "stop" }]);
  });
});

describe("MockProvider: recovery ladder (malformed tool calls)", () => {
  const fixture = loadFixture("malformed_tool_calls.json");

  it("flags invalid JSON args as malformed (kind=invalid_json)", async () => {
    const provider = new MockProvider(fixture);
    const events = await collect(provider.chat(makeRequest()));
    const call = toolCalls(events)[0]!;
    expect(call.args).toBeNull();
    expect(call.malformed?.kind).toBe("invalid_json");
  });

  it("flags an unknown tool name (kind=unknown_tool) and lists valid tools", async () => {
    const provider = new MockProvider(fixture);
    await collect(provider.chat(makeRequest())); // turn 1
    const events = await collect(provider.chat(makeRequest())); // turn 2
    const call = toolCalls(events)[0]!;
    expect(call.args).toBeNull();
    expect(call.malformed?.kind).toBe("unknown_tool");
    expect(call.malformed?.detail).toContain("validate_design");
  });

  it("flags a schema mismatch (missing required field)", async () => {
    const provider = new MockProvider(fixture);
    await collect(provider.chat(makeRequest()));
    await collect(provider.chat(makeRequest()));
    const events = await collect(provider.chat(makeRequest())); // turn 3
    const call = toolCalls(events)[0]!;
    expect(call.args).toBeNull();
    expect(call.malformed?.kind).toBe("schema_mismatch");
    expect(call.malformed?.detail).toContain("design_path");
  });

  it("aborts mid-turn when the signal fires", async () => {
    const provider = new MockProvider(fixture);
    const controller = new AbortController();
    controller.abort();
    const events = await collect(provider.chat(makeRequest({ signal: controller.signal })));
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "aborted" });
  });
});
