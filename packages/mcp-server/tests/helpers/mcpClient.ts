/**
 * Minimal, real MCP-over-stdio JSON-RPC client used by the mcp-server tests
 * (issue #40). It spawns the BUILT server as a Node child process and speaks the
 * actual MCP wire protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout,
 * with `initialize` -> `notifications/initialized` -> `tools/list` /
 * `tools/call`. This is deliberately NOT the official SDK client -- the tests
 * must exercise the server's real stdio transport, not a mocked in-process seam.
 *
 * BINDING CONTRACT (coordinator-confirmed for #40):
 *  - The server's built entrypoint is the package `bin` `airspice-mcp` ->
 *    `packages/mcp-server/dist/cli.js`. If the build output is missing,
 *    `resolveServerEntry()` runs the package's `build` script once, then
 *    re-checks.
 *  - The server reads an OPTIONAL launch design-context path from the
 *    `AIRSPICE_MCP_DESIGN` environment variable (an AIR XML file). This scopes
 *    the advertised tool surface: `run_cosim` is advertised in `tools/list`
 *    ONLY when that design contains a firmware block (PRD #40: "run_cosim
 *    appears ONLY when the design has a firmware block"). Each tool remains
 *    stateless -- the design XML is still passed explicitly per `tools/call`.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/mcp-server/tests/helpers
/** packages/mcp-server */
export const PKG_ROOT = resolve(HERE, "..", "..");

/** The env var the server reads to scope its advertised tool surface. */
export const DESIGN_ENV = "AIRSPICE_MCP_DESIGN";

/**
 * Resolve the built server entry. Prefers `dist/cli.js`; if absent, builds the
 * package once (tsc project references pull in the workspace deps) and re-checks.
 * Throws a precise, builder-actionable error if it still cannot be found.
 */
export function resolveServerEntry(): string {
  // Binding contract: bin `airspice-mcp` -> dist/cli.js.
  const dist = join(PKG_ROOT, "dist", "cli.js");
  if (existsSync(dist)) return dist;
  try {
    execSync("npm run build", { cwd: PKG_ROOT, stdio: "ignore" });
  } catch {
    /* fall through to the assertion below */
  }
  if (existsSync(dist)) return dist;
  throw new Error(
    `MCP server entry not found. Expected a built stdio server at ${dist}. ` +
      `Builder contract: 'npm --workspace mcp-server run build' must emit ` +
      `dist/cli.js (the 'airspice-mcp' bin -- a Node stdio MCP entrypoint). ` +
      `The tests spawn it as a child process and speak MCP JSON-RPC over stdio.`,
  );
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/** A single MCP `tools/call` result envelope. */
export interface ToolCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

/**
 * A live stdio connection to a spawned MCP server. Buffers stdout, splits on
 * newlines, parses each complete line as a JSON-RPC message, and matches
 * responses to pending requests by id. Non-JSON lines (e.g. stderr-style logs
 * that leak to stdout) and id-less notifications are ignored.
 */
export class McpStdioClient {
  private child: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();
  private stderr = "";
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;

  constructor(entry: string, env: Record<string, string | undefined> = {}) {
    this.child = spawn(process.execPath, [entry], {
      cwd: PKG_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (d: string) => this.onData(d));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (d: string) => {
      this.stderr += d;
    });
    this.child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      // Fail any in-flight requests so tests don't hang on a crashed server.
      for (const [, p] of this.pending) {
        p.reject(
          new Error(
            `MCP server exited (code=${code}, signal=${signal}) with pending ` +
              `request. stderr:\n${this.stderr}`,
          ),
        );
      }
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not a JSON-RPC frame -- ignore log noise on stdout
      }
      if (msg && typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        p.resolve(msg as JsonRpcResponse);
      }
    }
  }

  request(
    method: string,
    params?: unknown,
    timeoutMs = 20000,
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const frame =
      JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n";
    return new Promise<JsonRpcResponse>((resolvePromise, reject) => {
      if (this.exitInfo) {
        reject(
          new Error(
            `MCP server already exited (code=${this.exitInfo.code}). ` +
              `stderr:\n${this.stderr}`,
          ),
        );
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request '${method}' timed out after ${timeoutMs}ms. ` +
              `stderr:\n${this.stderr}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolvePromise(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin!.write(frame);
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n",
    );
  }

  /** Full MCP handshake: `initialize` then the `notifications/initialized` ping. */
  async initialize(): Promise<JsonRpcResponse> {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-server-tests", version: "0.0.0" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  async listTools(): Promise<JsonRpcResponse> {
    return this.request("tools/list", {});
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    return this.request("tools/call", { name, arguments: args });
  }

  getStderr(): string {
    return this.stderr;
  }

  async close(): Promise<void> {
    try {
      this.child.stdin!.end();
    } catch {
      /* ignore */
    }
    if (this.exitInfo) return;
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        try {
          this.child.kill();
        } catch {
          /* ignore */
        }
        r();
      }, 500);
      this.child.on("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }
}
