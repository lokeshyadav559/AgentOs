/**
 * CloudClaudeRunner — Claude Agent SDK backend (§16).
 *
 * Mounts the built-in MCP servers (agentos, inbox, r2-fs) into a real
 * Claude Agent SDK session via createSdkMcpServer, streams tool calls into
 * the live viewer, and resumes waiting sessions with the human's inbox
 * answer. Requires ANTHROPIC_API_KEY; the routing layer falls back to the
 * simulated runner when the key is absent (labeled in the session record).
 */
import type { Runner, RunnerHandle, SessionOutcome } from "./types.js";
import type { McpRuntime } from "../mcp/context.js";
import type { SessionManifest } from "../domain/types.js";
import type { AgentScript } from "./script.js";
import { serversForManifest } from "../mcp/index.js";
import { buildAgentPrompt } from "./prompt.js";

export class CloudClaudeRunner implements Runner {
  kind = "cloud";

  async provision(opts: {
    sessionId: string;
    manifest: SessionManifest;
    runtime: McpRuntime;
    script?: AgentScript;
    cwd: string;
  }): Promise<RunnerHandle> {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const { manifest, runtime, sessionId, cwd } = opts;

    const mcpServers: Record<string, unknown> = {};
    for (const server of serversForManifest(manifest.mcpConnections)) {
      mcpServers[server.name] = sdk.createSdkMcpServer({
        name: server.name,
        tools: server.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema:
            (t.inputSchema as { shape?: unknown }).shape ?? {},
          // Dispatch through server.call so the network wall (§5.5) and zod
          // validation apply on the cloud path exactly as on the in-process
          // runners.
          handler: async (args: Record<string, unknown>) => ({
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(await server.call(runtime, t.name, args)),
              },
            ],
          }),
        })),
      });
    }

    const prompt = buildAgentPrompt(manifest);
    const baseOptions = {
      cwd,
      mcpServers,
      model: manifest.agent.model,
      permissionMode: "acceptEdits" as const,
      env: { AGENTOS_SESSION_ID: sessionId },
    };

    let currentSessionId: string | undefined;
    let asked = false;
    let aborted = false;
    let answerText = "";
    let resolveDone!: (o: SessionOutcome) => void;
    const done = new Promise<SessionOutcome>((r) => (resolveDone = r));
    let ac = new AbortController();

    // Detect inbox.ask so the loop pauses until the human answers.
    const origOnQuestion = runtime.onInboxQuestion.bind(runtime);
    runtime.onInboxQuestion = async (msg) => {
      asked = true;
      await origOnQuestion(msg);
    };

    const runQuery = async (input: { prompt: string; resume?: string }) => {
      const options: Record<string, unknown> = {
        ...baseOptions,
        resume: input.resume,
        signal: ac.signal,
      };
      const result = sdk.query({ prompt: input.prompt, options });
      let outcome: SessionOutcome = {
        status: "failed",
        summary: null,
        costUsd: null,
        commitShas: [],
        error: "no result message",
      };
      for await (const ev of result) {
        if (aborted) return;
        if (ev.type === "assistant" && "message" in ev) {
          const msg = ev.message as { content?: { type: string; name?: string; input?: unknown }[] };
          for (const block of msg.content ?? []) {
            if (block.type === "tool_use" && block.name) {
              await runtime.recordToolCall({
                ts: new Date().toISOString(),
                name: block.name,
                input: (block.input ?? {}) as Record<string, unknown>,
              });
            }
          }
        }
        if (ev.type === "result") {
          const r = (ev as unknown as {
            result?: {
              is_error?: boolean;
              result?: string;
              total_cost_usd?: number;
              session_id?: string;
              error?: string;
            };
          }).result ?? {};
          currentSessionId = r.session_id ?? currentSessionId;
          outcome = {
            status: r.is_error ? "failed" : "ok",
            summary: r.result ?? null,
            costUsd: r.total_cost_usd ?? null,
            commitShas: [],
            error: r.is_error ? r.error ?? "cloud session error" : null,
          };
        }
      }
      return outcome;
    };

    const loop = async () => {
      let first = true;
      while (!aborted) {
        asked = false;
        const promptText = first ? prompt : answerText;
        const out = await runQuery({ prompt: promptText, resume: first ? undefined : currentSessionId });
        first = false;
        if (aborted) return;
        if (asked) {
          // Agent asked the human; wait for the reply to arrive via
          // injectReply, which restarts the loop.
          await new Promise<void>((r) => (waiter = r));
          continue;
        }
        resolveDone(out ?? { status: "failed", summary: null, costUsd: null, commitShas: [], error: "query aborted" });
        return;
      }
    };
    let waiter: (() => void) | null = null;

    loop().catch((err) =>
      resolveDone({
        status: "failed",
        summary: null,
        costUsd: null,
        commitShas: [],
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    return {
      runner: "cloud",
      async injectReply(answer) {
        answerText = answer.label ?? answer.body ?? "answered";
        asked = false;
        waiter?.();
        waiter = null;
      },
      async destroy() {
        aborted = true;
        ac.abort();
        waiter?.();
      },
      done,
    };
  }
}
