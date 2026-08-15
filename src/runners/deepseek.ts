/**
 * DeepSeekRunner — bring-your-own-key (BYOK) DeepSeek cloud backend (§16).
 *
 * Talks to DeepSeek's OpenAI-compatible /chat/completions endpoint with the
 * same in-process MCP servers a real model uses, so ACLs, approval gates and
 * the inbox mechanic apply identically. Agents whose model name is a
 * deepseek-* model are routed here when DEEPSEEK_API_KEY is present.
 *
 * Tool names are sanitized to OpenAI function-name rules ([a-zA-Z0-9_-]+),
 * since MCP names like "tasks.set_status" contain dots that OpenAI rejects.
 */
import type { Runner, RunnerHandle, SessionOutcome } from "./types.js";
import type { McpRuntime, McpServer, McpTool } from "../mcp/context.js";
import type { SessionManifest } from "../domain/types.js";
import type { AgentScript } from "./script.js";
import { serversForManifest } from "../mcp/index.js";
import { jsonSchemaOf } from "../mcp/context.js";
import { buildAgentPrompt } from "./prompt.js";
import { estimateDeepseekCost } from "./models.js";

const MAX_TURNS = 50;

interface DeepseekToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface DeepseekMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: DeepseekToolCall[];
  tool_call_id?: string;
}

export interface DeepseekRunnerOptions {
  apiKey: string;
  baseUrl?: string;
}

/** MCP tool name → OpenAI-safe function name. */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export class DeepseekRunner implements Runner {
  kind = "deepseek";

  constructor(private opts: DeepseekRunnerOptions) {}

  async provision(opts: {
    sessionId: string;
    manifest: SessionManifest;
    runtime: McpRuntime;
    script?: AgentScript;
    cwd: string;
  }): Promise<RunnerHandle> {
    const { manifest, runtime } = opts;
    const servers = serversForManifest(manifest.mcpConnections);
    const baseUrl = (this.opts.baseUrl ?? "https://api.deepseek.com").replace(/\/$/, "");
    const model = manifest.agent.model;

    // Build OpenAI function specs + a reverse map back to (server, tool).
    const toolByFn = new Map<string, { server: McpServer; tool: McpTool }>();
    const tools: unknown[] = [];
    for (const server of servers) {
      for (const tool of server.tools) {
        const fn = sanitizeToolName(tool.name);
        toolByFn.set(fn, { server, tool });
        tools.push({
          type: "function",
          function: {
            name: fn,
            description: tool.description,
            parameters: jsonSchemaOf(tool.inputSchema),
          },
        });
      }
    }

    const messages: DeepseekMessage[] = [
      { role: "system", content: buildAgentPrompt(manifest) },
      { role: "user", content: "Begin your work now. Use the available tools, verify your results, and finish when your exit criteria are met." },
    ];

    let resolveDone!: (o: SessionOutcome) => void;
    const done = new Promise<SessionOutcome>((r) => (resolveDone = r));
    let aborted = false;
    let usage = { promptTokens: 0, completionTokens: 0 };

    const fail = (error: string) =>
      resolveDone({ status: "failed", summary: null, costUsd: null, commitShas: [], error });

    const runLoop = async (): Promise<void> => {
      for (let turn = 0; turn < MAX_TURNS && !aborted; turn++) {
        const resp = await this.chat(baseUrl, model, messages, tools);
        const choice = resp.choices?.[0];
        if (!choice) throw new Error("DeepSeek returned no completion choice");
        const msg = choice.message ?? {};
        usage.promptTokens += resp.usage?.prompt_tokens ?? 0;
        usage.completionTokens += resp.usage?.completion_tokens ?? 0;

        const content: string = msg.content ?? "";
        const toolCalls: DeepseekToolCall[] = msg.tool_calls ?? [];

        if (toolCalls.length === 0) {
          resolveDone({
            status: "ok",
            summary: content || "finished",
            costUsd: estimateDeepseekCost(model, usage),
            commitShas: [],
            error: null,
          });
          return;
        }

        messages.push({ role: "assistant", content, tool_calls: toolCalls });

        for (const call of toolCalls) {
          if (aborted) return;
          const entry = toolByFn.get(call.function.name);
          let args: Record<string, unknown> = {};
          try {
            args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
          } catch {
            args = {};
          }

          let output: unknown = null;
          let error: string | null = null;
          if (!entry) {
            error = `unknown tool ${call.function.name}`;
          } else {
            try {
              output = await entry.server.call(runtime, entry.tool.name, args);
            } catch (e) {
              error = e instanceof Error ? e.message : String(e);
            }
          }
          await runtime.recordToolCall({
            ts: new Date().toISOString(),
            name: entry?.tool.name ?? call.function.name,
            input: args,
            output: error ? null : (output as Record<string, unknown> | string | null),
            error,
          });

          // inbox.ask pauses until the human answers; feed the answer back
          // as the tool result so the loop continues on the reply.
          if (entry?.tool.name === "inbox.ask") {
            const answer = await runtime.waitForAnswer();
            if (answer == null) return; // session destroyed
            const text = answer.label ?? answer.body ?? answer.selectedChoiceId ?? "answered";
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ answer: text }) });
          } else {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(error ? { error } : output),
            });
          }
        }
      }
      if (!aborted) fail("turn limit reached without finishing");
    };

    runLoop()
      .then(() => {
        /* outcome resolved inside runLoop */
      })
      .catch((err) => {
        if (!aborted) fail(err instanceof Error ? err.message : String(err));
      });

    return {
      runner: "deepseek",
      async injectReply(answer) {
        runtime.injectAnswer(answer);
      },
      async destroy() {
        aborted = true;
        runtime.cancelWait();
      },
      done,
    };
  }

  private async chat(
    baseUrl: string,
    model: string,
    messages: DeepseekMessage[],
    tools: unknown[],
  ): Promise<{
    choices?: { message?: { content?: string; tool_calls?: DeepseekToolCall[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }> {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? "auto" : undefined,
        stream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`DeepSeek API ${res.status}: ${body.slice(0, 500)}`);
    }
    return (await res.json()) as Awaited<ReturnType<DeepseekRunner["chat"]>>;
  }
}
