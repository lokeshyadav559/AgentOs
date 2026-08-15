/**
 * MCP runtime contract.
 *
 * The built-in MCP servers (agentos, inbox, r2-fs) are product logic exposed
 * as tools. They run in-process for the simulated runner and are mounted into
 * real Claude Agent SDK sessions via createSdkMcpServer (cloud runner). All
 * side effects go through callbacks implemented by the SessionService, which
 * also streams tool calls to the live viewer.
 */
import { z } from "zod";
import type { SessionManifest, InboxMessage, ToolCallLogEntry, Task } from "../domain/types.js";
import type { Services } from "../services/registry.js";
import { networkAllowed } from "../acl/grants.js";

export interface McpRuntime {
  sessionId: string;
  manifest: SessionManifest;
  services: Services;
  /** Persist + stream one tool call. */
  recordToolCall(entry: ToolCallLogEntry): Promise<void>;
  /** Called when an agent asks/sends via inbox: pauses the session. */
  onInboxQuestion(message: InboxMessage): Promise<void>;
  /** Called when an agent sends a fire-and-forget inbox note (no pause). */
  onInboxNote(message: InboxMessage): Promise<void>;
  /** Spawn a collaborator (collaboration list enforced by the caller). */
  spawnCollaborator(agentName: string, brief: string): Promise<Task>;
  /** Current human answer for a resumed inbox.ask (null when none). */
  answer(): { body?: string; selectedChoiceId?: string; label?: string } | null;
  /** Block until the human answers the current inbox.ask (resume). */
  waitForAnswer(): Promise<{ body?: string; selectedChoiceId?: string; label?: string } | null>;
  /** Deliver a human answer to a waiting agent. */
  injectAnswer(answer: { body?: string; selectedChoiceId?: string; label?: string }): void;
  /** Abort an outstanding waitForAnswer (session being destroyed). */
  cancelWait(): void;
}

export interface McpTool<Args extends z.ZodType<any> = z.ZodType<any>> {
  name: string;
  description: string;
  inputSchema: Args;
  handler: (rt: McpRuntime, args: z.infer<Args>) => Promise<unknown>;
}

export interface McpServer {
  name: string;
  tools: McpTool[];
  /**
   * Hosts this server's tools reach over the network (external connections
   * only). The §5.5 network wall is enforced here, at the one dispatch choke
   * point every runner (simulated, local, cloud SDK) goes through: a limited
   * environment denies any host that is not on its allowlist. Built-in
   * product servers (agentos, inbox, r2-fs) are in-process control-plane
   * logic and have no hosts.
   */
  networkHosts: string[];
  /** Call a tool by name; throws Error on unknown tool / zod failure. */
  call(rt: McpRuntime, name: string, args: unknown): Promise<unknown>;
  listTools(): { name: string; description: string; inputSchema: Record<string, unknown> }[];
}

export function createMcpServer<Tools extends McpTool[]>(
  name: string,
  tools: Tools,
  networkHosts: string[] = [],
): McpServer {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    name,
    tools,
    networkHosts,
    async call(rt, toolName, args) {
      const tool = byName.get(toolName);
      if (!tool) throw new Error(`unknown tool ${name}.${toolName}`);
      // §5.5 / §21 Phase 2 network wall: the environment policy is enforced
      // server-side before any external connection's tool may run.
      for (const host of networkHosts) {
        if (!networkAllowed(rt.manifest.environment, host)) {
          throw new Error(
            `network wall denied: ${name} (${host}) is not in the environment allowlist`,
          );
        }
      }
      const parsed = tool.inputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new Error(`invalid args for ${name}.${toolName}: ${parsed.error.message}`);
      }
      return tool.handler(rt, parsed.data);
    },
    listTools() {
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: jsonSchemaOf(t.inputSchema),
      }));
    },
  };
}

/** Convert a zod schema to a JSON-schema-ish object for SDK MCP registration. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema) as Record<string, unknown>;
  } catch {
    return { type: "object" };
  }
}

export function callToolWithLog(
  server: McpServer,
  rt: McpRuntime,
  name: string,
  args: unknown,
): Promise<unknown> {
  return server.call(rt, name, args);
}
