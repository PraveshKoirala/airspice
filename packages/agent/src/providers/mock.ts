/**
 * Mock provider (issue #17): a deterministic, offline provider that replays a
 * scripted sequence of events from a fixture. It powers CI for #18/#19 (the tool
 * runtime and the repair loop) and this package's own tests, so those flows are
 * exercised with zero network and identical output on every run and platform.
 *
 * PORT of the Python `MockAgentClient` recipe behaviour (agent.py): that mock is
 * "deterministic, offline: rule-based repair and a known-valid design" -- it
 * returns a canonical GOLDEN_DESIGN and a no-op edit patch. This browser mock
 * generalizes that idea to the streaming/tool-use contract: a fixture is a list
 * of "turns", each a scripted list of AgentEvents (text deltas + tool calls +
 * done). Given the same fixture and the same number of prior turns, it always
 * yields the same events -- the determinism the acceptance criteria require.
 *
 * A fixture maps a turn INDEX to its scripted events, so a multi-step tool
 * conversation (call tool -> receive result -> continue) replays step by step:
 * the caller sends message N, the mock yields turn N's events. This mirrors how
 * the real providers behave across a tool-use loop, without any model.
 */

import { parseToolArgs } from "../repair.js";
import type {
  AgentEvent,
  AgentProvider,
  ChatRequest,
  DoneEvent,
  ValidateKeyResult,
} from "../types.js";

/** A single scripted event in a mock turn. Serializable (JSON fixtures). */
export type ScriptedEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; args: Record<string, unknown> }
  | {
      // A deliberately malformed tool call: `rawArgs` is passed through the real
      // recovery ladder so the mock exercises the SAME validation path the real
      // providers use (invalid JSON / unknown tool / schema mismatch).
      type: "tool-call-raw";
      id: string;
      name: string;
      rawArgs: string;
    }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; stopReason: DoneEvent["stopReason"] }
  | {
      type: "error";
      kind: "auth" | "quota" | "network" | "model";
      retryable: boolean;
      message: string;
    };

export interface MockFixture {
  /** Ordered turns; turn i replays when the (i+1)-th user message is sent. */
  turns: ScriptedEvent[][];
  /** Optional: validateKey answer. Defaults to ok. */
  validateKey?: ValidateKeyResult;
}

export class MockProvider implements AgentProvider {
  readonly id = "mock" as const;
  readonly models = ["mock-model"] as const;
  readonly defaultModel = "mock-model";

  private readonly fixture: MockFixture;
  private turnIndex = 0;

  constructor(fixture: MockFixture) {
    this.fixture = fixture;
  }

  /** Reset the replay cursor (useful between independent conversations). */
  reset(): void {
    this.turnIndex = 0;
  }

  async validateKey(_key: string): Promise<ValidateKeyResult> {
    void _key;
    return this.fixture.validateKey ?? { ok: true, detail: "Mock key accepted." };
  }

  async *chat(req: ChatRequest): AsyncIterable<AgentEvent> {
    const turn = this.fixture.turns[this.turnIndex];
    this.turnIndex++;
    if (!turn) {
      // Past the end of the script: a benign terminal turn keeps callers safe.
      yield { type: "done", stopReason: "stop" };
      return;
    }
    for (const scripted of turn) {
      if (req.signal.aborted) {
        yield { type: "done", stopReason: "aborted" };
        return;
      }
      yield materialize(scripted, req);
    }
  }
}

function materialize(ev: ScriptedEvent, req: ChatRequest): AgentEvent {
  switch (ev.type) {
    case "text-delta":
      return { type: "text-delta", text: ev.text };
    case "tool-call":
      // Validate even the "good" scripted args through the ladder so a fixture
      // author cannot accidentally script a call that the runtime would reject.
      {
        const parsed = parseToolArgs(ev.name, JSON.stringify(ev.args), req.tools);
        if (parsed.ok) {
          return { type: "tool-call", id: ev.id, name: ev.name, args: parsed.args };
        }
        return {
          type: "tool-call",
          id: ev.id,
          name: ev.name,
          args: null,
          malformed: parsed.malformed!,
        };
      }
    case "tool-call-raw": {
      const parsed = parseToolArgs(ev.name, ev.rawArgs, req.tools);
      if (parsed.ok) {
        return { type: "tool-call", id: ev.id, name: ev.name, args: parsed.args };
      }
      return {
        type: "tool-call",
        id: ev.id,
        name: ev.name,
        args: null,
        malformed: parsed.malformed!,
      };
    }
    case "usage":
      return {
        type: "usage",
        inputTokens: ev.inputTokens,
        outputTokens: ev.outputTokens,
      };
    case "done":
      return { type: "done", stopReason: ev.stopReason };
    case "error":
      return {
        type: "error",
        kind: ev.kind,
        retryable: ev.retryable,
        message: ev.message,
      };
  }
}
