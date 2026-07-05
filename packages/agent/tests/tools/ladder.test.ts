/**
 * The malformed-tool-call recovery ladder in the conversation runner (#17
 * post-audit amendment, consumed by #18's runner):
 *   step 1 — one malformed emission feeds a structured error back once;
 *   step 2 — a SECOND consecutive malformed emission in the same turn aborts the
 *            turn with a provider/model-named note (never a silent retry loop);
 *   plus  — ladder events surface as subdued system notes and increment a
 *            per-session counter.
 */

import { describe, it, expect } from "vitest";
import {
  MockProvider,
  ToolRuntime,
  runConversation,
  GOLDEN_DESIGN,
  type MockFixture,
  type RunnerEvent,
} from "../../src/index.js";
import { realAirTsEngine } from "./engineAdapter.js";

function collect() {
  const events: RunnerEvent[] = [];
  return {
    events,
    onEvent: (e: RunnerEvent) => events.push(e),
    of<T extends RunnerEvent["type"]>(t: T) {
      return events.filter((e): e is Extract<RunnerEvent, { type: T }> => e.type === t);
    },
  };
}

function runtime() {
  return new ToolRuntime({ xml: GOLDEN_DESIGN, version: 0 }, { hooks: realAirTsEngine() });
}

describe("recovery ladder", () => {
  it("step 1: one malformed call feeds a structured error back, then continues", async () => {
    const fixture: MockFixture = {
      turns: [
        [
          // Malformed: an unknown tool name -> the mock produces `malformed`.
          { type: "tool-call-raw", id: "b1", name: "not_a_tool", rawArgs: "{}" },
          { type: "done", stopReason: "tool_use" },
        ],
        // Recovered: the model calls a real tool next turn.
        [
          { type: "tool-call", id: "g1", name: "list_registry_components", args: {} },
          { type: "done", stopReason: "tool_use" },
        ],
        [{ type: "text-delta", text: "ok" }, { type: "done", stopReason: "stop" }],
      ],
    };
    const counter = { count: 0 };
    const c = collect();
    const { reason } = await runConversation({
      provider: new MockProvider(fixture),
      runtime: runtime(),
      userMessage: "go",
      system: "sys",
      maxTokensPerTurn: 512,
      signal: new AbortController().signal,
      onEvent: c.onEvent,
      malformedCounter: counter,
      modelId: "mock-model",
    });

    expect(reason).toBe("completed");
    // One malformed event + one system note + counter incremented once.
    expect(c.of("malformed")).toHaveLength(1);
    expect(counter.count).toBe(1);
    // The structured error was fed back as a tool-result for that call.
    const fed = c.of("tool-result").find((r) => r.id === "b1")!;
    expect(fed.result).toContain("malformed_tool_call");
  });

  it("step 2: two consecutive malformed calls in one turn abort the turn", async () => {
    const fixture: MockFixture = {
      turns: [
        [
          { type: "tool-call-raw", id: "b1", name: "not_a_tool", rawArgs: "{}" },
          { type: "tool-call-raw", id: "b2", name: "also_bad", rawArgs: "{" },
          { type: "done", stopReason: "tool_use" },
        ],
      ],
    };
    const counter = { count: 0 };
    const c = collect();
    const { reason } = await runConversation({
      provider: new MockProvider(fixture),
      runtime: runtime(),
      userMessage: "go",
      system: "sys",
      maxTokensPerTurn: 512,
      signal: new AbortController().signal,
      onEvent: c.onEvent,
      malformedCounter: counter,
      modelId: "mock-model",
    });

    expect(reason).toBe("malformed_twice");
    // The abort note names the model + provider (amendment step 2).
    const notes = c.of("system-note").map((n) => n.note);
    expect(notes.some((n) => n.includes("mock-model") && n.includes("twice"))).toBe(true);
    expect(counter.count).toBe(2);
  });
});
