/**
 * LocalVmRunner — the cheap local VM backend (§16).
 *
 * Blueprint: "A worker on a cheap VM that can run Claude Code
 * (--dangerously-skip-permissions) and Grok in yolo mode. Local VM is a
 * worker process that pulls jobs; it is not the control plane."
 *
 * Two modes:
 * - "inprocess" (default here): runs the deterministic engine with runner
 *   label "local" — a stand-in for the VM slot (labeled).
 * - "worker": spawns `dist/runners/local-worker.js` as a child process; the
 *   worker executes the agent script and asks the control plane (parent) to
 *   execute every MCP tool call — a genuine worker/control-plane boundary.
 *   Deployment to an actual VM = ship the same worker with a network client.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { Runner, RunnerHandle, SessionOutcome } from "./types.js";
import type { McpRuntime } from "../mcp/context.js";
import type { SessionManifest } from "../domain/types.js";
import { serversForManifest } from "../mcp/index.js";
import type { AgentScript } from "./script.js";
import { SimulatedRunner } from "./simulated.js";

export class LocalVmRunner implements Runner {
  kind = "local";
  constructor(private mode: "inprocess" | "worker" = "inprocess") {}

  async provision(opts: {
    sessionId: string;
    manifest: SessionManifest;
    runtime: McpRuntime;
    script?: AgentScript;
    cwd: string;
  }): Promise<RunnerHandle> {
    if (this.mode === "inprocess") {
      // Stand-in: same deterministic engine, labeled "local".
      const sim = new SimulatedRunner();
      return sim.provision(opts);
    }
    return this.provisionWorker(opts);
  }

  private provisionWorker(opts: {
    sessionId: string;
    manifest: SessionManifest;
    runtime: McpRuntime;
    script?: AgentScript;
    cwd: string;
  }): Promise<RunnerHandle> {
    const { sessionId, manifest, runtime, script, cwd } = opts;
    const servers = serversForManifest(manifest.mcpConnections);

    return new Promise((resolve, reject) => {
      const workerPath = path.resolve(process.cwd(), "dist", "runners", "local-worker.js");
      const child = spawn(process.execPath, [workerPath], {
        cwd,
        stdio: ["pipe", "pipe", "inherit"],
      });
      let buffer = "";
      let busy: { resolve: (v: unknown) => void; reject: (e: Error) => void } | null = null;
      let waitingAsk: ((answer: unknown) => void) | null = null;
      let resolveDone!: (o: SessionOutcome) => void;
      const done = new Promise<SessionOutcome>((r) => (resolveDone = r));
      let destroyed = false;

      const send = (msg: unknown) => child.stdin!.write(JSON.stringify(msg) + "\n");

      child.stdout!.on("data", async (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.type === "tool_call") {
            busy = {
              resolve: (v) => send({ type: "tool_result", id: msg.id, output: v }),
              reject: (e) => send({ type: "tool_result", id: msg.id, error: e.message }),
            };
            let output: unknown;
            let error: string | null = null;
            try {
              for (const s of servers) {
                try {
                  output = await s.call(runtime, msg.name, msg.args);
                  break;
                } catch (e) {
                  if (e instanceof Error && e.message.startsWith("unknown tool")) continue;
                  throw e;
                }
              }
              if (output === undefined && error === null) {
                throw new Error(`unknown tool ${msg.name}`);
              }
            } catch (e) {
              error = e instanceof Error ? e.message : String(e);
            }
            await runtime.recordToolCall({
              ts: new Date().toISOString(),
              name: msg.name,
              input: msg.args ?? {},
              output: (error ? null : output) as Record<string, unknown> | string | null,
              error,
            });
            if (error) busy.reject(new Error(error));
            else busy.resolve(output);
            busy = null;
          } else if (msg.type === "ask") {
            const m = await runtime.services.inbox.send({
              from: "agent",
              agentId: manifest.agent.id,
              sessionId,
              taskId: manifest.task?.id ?? null,
              goalId: manifest.goal?.id ?? null,
              kind: "multiple-choice",
              body: msg.body,
              choices: msg.choices,
            });
            await runtime.onInboxQuestion(m);
            waitingAsk = (answer) => send({ type: "ask_answer", id: msg.id, answer });
          } else if (msg.type === "note") {
            const m = await runtime.services.inbox.send({
              from: "agent",
              agentId: manifest.agent.id,
              sessionId,
              taskId: manifest.task?.id ?? null,
              goalId: manifest.goal?.id ?? null,
              body: msg.body,
            });
            await runtime.onInboxNote(m);
          } else if (msg.type === "finish") {
            resolveDone(msg.outcome as SessionOutcome);
          }
        }
      });
      child.on("error", (e) => reject(e));
      child.on("exit", () => {
        if (!destroyed && !busy) {
          resolveDone({ status: "failed", summary: null, costUsd: null, commitShas: [], error: "worker exited" });
        }
      });

      send({
        type: "start",
        sessionId,
        script: script ?? [],
        manifest: {
          agent: { name: manifest.agent.name, model: manifest.agent.model },
          task: manifest.task
            ? { name: manifest.task.name, approvalGate: manifest.task.approvalGate }
            : null,
          goal: manifest.goal ? { id: manifest.goal.id, title: manifest.goal.title } : null,
        },
      });

      resolve({
        runner: "local",
        async injectReply(answer) {
          waitingAsk?.(answer);
          waitingAsk = null;
        },
        async destroy() {
          destroyed = true;
          child.kill();
        },
        done,
      });
    });
  }
}
