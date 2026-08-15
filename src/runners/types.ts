/**
 * Runner interface (§16). Two backends: CloudClaudeRunner (Claude Agent SDK)
 * and LocalVmRunner (worker process). A SimulatedRunner drives the same MCP
 * servers deterministically when no API key is available (tests/demo).
 */
import type { RunnerKind, SessionManifest } from "../domain/types.js";
import type { McpRuntime } from "../mcp/context.js";
import type { AgentScript } from "./script.js";

export interface SessionOutcome {
  status: "ok" | "failed";
  summary: string | null;
  costUsd: number | null;
  commitShas: string[];
  error: string | null;
}

export interface RunnerHandle {
  /** Backend label of the running backend. */
  runner: string;
  /** Send a human inbox answer back into the running agent. */
  injectReply(answer: { body?: string; selectedChoiceId?: string; label?: string }): Promise<void>;
  /** Tear down the runtime; resolves when gone. */
  destroy(): Promise<void>;
  /** Resolves when the agent finishes (ok or failed). */
  done: Promise<SessionOutcome>;
}

export interface Runner {
  /** Backend label ("cloud" | "local" | "simulated") — informational. */
  kind: string;
  provision(opts: {
    sessionId: string;
    manifest: SessionManifest;
    runtime: McpRuntime;
    script?: AgentScript;
    cwd: string;
  }): Promise<RunnerHandle>;
}
