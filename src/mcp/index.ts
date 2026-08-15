/**
 * MCP factory: builds the tool servers a session may call from its manifest.
 *
 * Built-ins: agentos, inbox, r2-fs. External connections (github, front, …)
 * are configurable; a `front` stand-in server is provided for the simulated
 * runner so the customer-support agent has a scoped, read-only support tool
 * (never Gmail, never GitHub — §5.3). NOTE: the stand-in is labeled; a real
 * Front MCP connection is configured per project in the UI/YAML.
 */
import { z } from "zod";
import { createMcpServer, type McpServer } from "./context.js";
import { createAgentosMcpServer } from "./agentos.js";
import { createInboxMcpServer } from "./inbox.js";
import { createFsMcpServer } from "./fs.js";

export { createAgentosMcpServer, createInboxMcpServer, createFsMcpServer };
export type { McpServer, McpRuntime, McpTool } from "./context.js";

const builtins: Record<string, () => McpServer> = {
  agentos: createAgentosMcpServer,
  inbox: createInboxMcpServer,
  "r2-fs": createFsMcpServer,
};

/**
 * Stand-in Front support MCP (labeled): read-only conversation access for
 * the customer-support agent. Reads fixtures from the project's file store
 * under /front/inbox/ (one file per conversation), or a default fixture.
 */
export function createFrontMcpServer(): McpServer {
  // The Front connection reaches api.front.com, so the §5.5 network wall
  // applies to it: a limited environment must allowlist the host.
  return createMcpServer("front", [
    {
      name: "front.list_conversations",
      description: "List support conversations (read-only).",
      inputSchema: z.object({}),
      handler: async (rt) => {
        const entries = await rt.services.files.list(rt.manifest.projectId, "/front/inbox");
        const conversations = entries
          .filter((e) => e.type === "file")
          .map((e) => ({ id: e.path.split("/").pop(), path: e.path, updatedAt: e.updatedAt }));
        if (conversations.length === 0) {
          return {
            conversations: [
              {
                id: "demo-support-1",
                path: "/front/inbox/demo-support-1.txt",
                updatedAt: null,
              },
            ],
          };
        }
        return { conversations };
      },
    },
    {
      name: "front.read_conversation",
      description: "Read one support conversation transcript (read-only).",
      inputSchema: z.object({ id: z.string() }),
      handler: async (rt, { id }) => {
        const entries = await rt.services.files.list(rt.manifest.projectId, "/front/inbox");
        const found = entries.find((e) => e.path.split("/").pop() === id);
        if (found) {
          const { content } = await rt.services.files.read(rt.manifest.projectId, found.path);
          return { conversation: { id, transcript: content.toString("utf8") } };
        }
        if (id === "demo-support-1") {
          return {
            conversation: {
              id,
              transcript:
                "customer: my invoice is missing\ncustomer: please help\nagent_note: needs billing team assignment",
            },
          };
        }
        throw new Error(`conversation not found: ${id}`);
      },
    },
  ], ["api.front.com"]);
}

const externals: Record<string, () => McpServer> = {
  front: createFrontMcpServer,
};

/** Servers for a session, honoring the manifest's granted connection names. */
export function serversForManifest(mcpConnectionNames: string[]): McpServer[] {
  const out: McpServer[] = [];
  const seen = new Set<string>();
  for (const name of mcpConnectionNames) {
    const factory = builtins[name] ?? externals[name];
    if (factory && !seen.has(name)) {
      out.push(factory());
      seen.add(name);
    }
  }
  return out;
}
