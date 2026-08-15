/**
 * Local worker agent — runs on the VM (or as a child process here) and asks
 * the control plane to execute every tool call. It is NOT the control plane
 * (§16). Consumes the protocol implemented in LocalVmRunner.provisionWorker.
 */
import type { AgentScript } from "./script.js";

interface StartMsg {
  type: "start";
  sessionId: string;
  script: AgentScript;
  manifest: {
    agent: { name: string; model: string };
    task: { name: string; approvalGate: boolean } | null;
    goal: { id: string; title: string } | null;
  };
}

function main(): void {
  const stdin = process.stdin;
  let buffer = "";
  let pending: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  let askResolver: ((answer: unknown) => void) | null = null;

  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");

  const exec = (tool: string, args: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      pending.set(id, { resolve, reject });
      send({ type: "tool_call", id, name: tool, args });
    });

  const run = async (script: AgentScript, manifest: StartMsg["manifest"]): Promise<void> => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (const step of script) {
      if (step.kind === "wait") {
        await wait(step.ms);
        continue;
      }
      if (step.kind === "tool") {
        await exec(step.tool, step.args);
        continue;
      }
      if (step.kind === "send") {
        send({ type: "note", body: step.body });
        if (step.then) await run(step.then, manifest);
        continue;
      }
      if (step.kind === "ask") {
        send({ type: "ask", id: Math.random().toString(36).slice(2), body: step.body, choices: step.choices });
        const answer = await new Promise<unknown>((r) => (askResolver = r));
        const a = answer as { selectedChoiceId?: string; label?: string };
        const next = step.onReply[a.selectedChoiceId ?? ""] ?? step.onReply[a.label ?? ""] ?? step.default ?? [];
        await run(next, manifest);
      }
    }
  };

  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const start = msg as StartMsg;
        run(start.script, start.manifest)
          .then(() => {
            send({ type: "finish", outcome: { status: "ok", summary: `local worker agent "${start.manifest.agent.name}" finished`, costUsd: 0, commitShas: [], error: null } });
          })
          .catch((e) => {
            send({ type: "finish", outcome: { status: "failed", summary: null, costUsd: 0, commitShas: [], error: e instanceof Error ? e.message : String(e) } });
          });
      } else if (msg.type === "tool_result") {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.output);
        }
      } else if (msg.type === "ask_answer") {
        askResolver?.(msg.answer);
        askResolver = null;
      }
    }
  });
}

if (process.argv[1]?.endsWith("local-worker.js")) main();
