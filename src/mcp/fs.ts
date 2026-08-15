/**
 * R2 filesystem MCP (§7).
 *
 * Exposes the persistent file store through tools ONLY. Every call is
 * authorized server-side against the session manifest's folder grants with
 * separate read / write / delete verbs. No raw blob access is ever given to
 * an agent.
 */
import { z } from "zod";
import { createMcpServer, type McpServer, type McpRuntime } from "./context.js";
import { checkFsOp, normalizePath } from "../acl/grants.js";

export function createFsMcpServer(): McpServer {
  return createMcpServer("r2-fs", [
    {
      name: "fs.list",
      description: "List entries under a folder path.",
      inputSchema: z.object({ path: z.string().default("/") }),
      handler: async (rt, { path }) => {
        assert(rt, "list", path);
        const entries = await rt.services.files.list(rt.manifest.projectId, path);
        return {
          entries: entries.map((e) => ({
            path: e.path,
            type: e.type,
            size: e.size,
          })),
        };
      },
    },
    {
      name: "fs.read",
      description: "Read a file's UTF-8 content.",
      inputSchema: z.object({ path: z.string() }),
      handler: async (rt, { path }) => {
        assert(rt, "read", path);
        const { file, content } = await rt.services.files.read(rt.manifest.projectId, path);
        return {
          path: file.path,
          mime: file.mime,
          size: file.size,
          content: content.toString("utf8"),
        };
      },
    },
    {
      name: "fs.write",
      description: "Write (create or replace) a UTF-8 text file. Persists beyond the session.",
      inputSchema: z.object({ path: z.string(), content: z.string(), mime: z.string().optional() }),
      handler: async (rt, { path, content, mime }) => {
        assert(rt, "write", path);
        const file = await rt.services.files.write(rt.manifest.projectId, path, content, mime);
        return { ok: true, path: file.path, size: file.size };
      },
    },
    {
      name: "fs.mkdir",
      description: "Validate a folder path (folders are virtual; requires write grant).",
      inputSchema: z.object({ path: z.string() }),
      handler: async (rt, { path }) => {
        assert(rt, "mkdir", path);
        return { ok: true, path: normalizePath(path) };
      },
    },
    {
      name: "fs.delete",
      description: "Delete a file. Requires canDelete on the folder grant.",
      inputSchema: z.object({ path: z.string() }),
      handler: async (rt, { path }) => {
        assert(rt, "delete", path);
        await rt.services.files.delete(rt.manifest.projectId, path);
        return { ok: true };
      },
    },
  ]);
}

function assert(
  rt: McpRuntime,
  op: "list" | "read" | "write" | "mkdir" | "delete",
  path: string,
): void {
  const res = checkFsOp(rt.manifest.filesystemGrants, op, path);
  if (!res.ok) throw new Error(`fs.${op} denied: ${res.reason}`);
}
