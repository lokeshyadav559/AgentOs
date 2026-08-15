/**
 * SimulatedRunner — deterministic agent execution for tests and demo.
 *
 * Executes an AgentScript (default scripts per agent, or injected scripts)
 * against the same in-process MCP servers a real model would use, so the
 * ACL, approval-gate and inbox mechanics are exercised for real. Tool calls
 * are recorded through McpRuntime.recordToolCall (persisted + streamed).
 *
 * NOT a product runner: the blueprint's production backends are the cloud
 * SDK runner and the local VM worker. Labeled as a test/demo stand-in.
 */
import type { Runner, RunnerHandle, SessionOutcome } from "./types.js";
import type { SessionManifest } from "../domain/types.js";
import type { McpRuntime } from "../mcp/context.js";
import type { McpServer } from "../mcp/index.js";
import { serversForManifest } from "../mcp/index.js";
import type { AgentScript, ScriptStep } from "./script.js";

export class SimulatedRunner implements Runner {
  kind = "simulated";

  constructor(
    private servers: McpServer[] | null = null,
    private opts: { failOnDenied?: boolean; timeScale?: number } = {},
  ) {}

  async provision(opts: {
    sessionId: string;
    manifest: SessionManifest;
    runtime: McpRuntime;
    script?: AgentScript;
    cwd: string;
  }): Promise<RunnerHandle> {
    const { manifest, runtime, sessionId } = opts;
    const script = opts.script;
    if (!script) {
      throw new Error("SimulatedRunner requires a script");
    }
    const servers = this.servers ?? serversForManifest(manifest.mcpConnections);

    let destroyed = false;
    let resolveDone!: (o: SessionOutcome) => void;
    const done = new Promise<SessionOutcome>((r) => (resolveDone = r));

    const run = async (steps: AgentScript): Promise<void> => {
      for (const step of steps) {
        if (destroyed) return;
        if (step.kind === "wait") {
          await sleep(Math.round(step.ms * (this.opts.timeScale ?? 1)));
          continue;
        }
        if (step.kind === "tool") {
          await this.execTool(servers, runtime, sessionId, step.tool, step.args);
          continue;
        }
        if (step.kind === "send") {
          await this.execTool(servers, runtime, sessionId, "inbox.send", { body: step.body });
          if (step.then) await run(step.then);
          continue;
        }
        if (step.kind === "ask") {
          const msg = (await this.execTool(servers, runtime, sessionId, "inbox.ask", {
            body: step.body,
            choices: step.choices,
          })) as { messageId: string };
          // Session pauses here (runtime.onInboxQuestion sets waiting-inbox).
          const answer = await runtime.waitForAnswer();
          if (!answer) {
            // Session destroyed while waiting — abort silently.
            return;
          }
          const choiceId = answer.selectedChoiceId;
          const label = answer.label ?? choiceId ?? "";
          const next =
            step.onReply[choiceId ?? ""] ??
            step.onReply[label] ??
            step.default ??
            [];
          await run(next);
          continue;
        }
      }
    };

    run(script)
      .then(async () => {
        if (destroyed) return;
        resolveDone({
          status: "ok",
          summary: `simulated agent "${manifest.agent.name}" finished`,
          costUsd: 0,
          commitShas: [],
          error: null,
        });
      })
      .catch(async (err) => {
        if (destroyed) return;
        const message = err instanceof Error ? err.message : String(err);
        await runtime.recordToolCall({
          ts: new Date().toISOString(),
          name: "agent.error",
          input: {},
          output: null,
          error: message,
        });
        resolveDone({
          status: "failed",
          summary: null,
          costUsd: 0,
          commitShas: [],
          error: message,
        });
      });

    return {
      runner: "simulated",
      async injectReply(answer) {
        runtime.injectAnswer(answer);
      },
      async destroy() {
        destroyed = true;
        runtime.cancelWait();
      },
      done,
    };
  }

  private async execTool(
    servers: McpServer[],
    runtime: McpRuntime,
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const ts = new Date().toISOString();
    let output: unknown = null;
    let error: string | null = null;
    try {
      for (const s of servers) {
        try {
          output = await s.call(runtime, name, args);
          await runtime.recordToolCall({
            ts,
            name,
            input: args,
            output: (output ?? null) as Record<string, unknown> | string | null,
            error: null,
          });
          return output;
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("unknown tool")) continue;
          throw e;
        }
      }
      throw new Error(`unknown tool ${name}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      await runtime.recordToolCall({ ts, name, input: args, output: null, error });
      if (this.opts.failOnDenied) throw e;
      return { ok: false, error };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
