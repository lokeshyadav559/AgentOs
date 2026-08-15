/**
 * Least-privilege ACL engine (§5, §7).
 *
 * Default deny. Everything an agent may touch must be listed on the agent:
 * MCPs, repos, env, filesystem folders, collaboration spawns, network hosts.
 * Filesystem ops are authorized server-side per folder grant + verb.
 */
import type {
  Agent,
  FilesystemGrant,
  FileObject,
  SessionManifest,
  Skill,
} from "../domain/types.js";

export type FsOp = "list" | "read" | "write" | "mkdir" | "delete";

/** Normalize a virtual path; returns null when escaping the root. */
export function normalizePath(raw: string): string | null {
  const parts = raw.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") return null; // traversal is denied outright
    out.push(p);
  }
  return "/" + out.join("/");
}

export function pathWithin(prefix: string, path: string): boolean {
  const p = normalizePath(prefix);
  const q = normalizePath(path);
  if (!p || !q) return false;
  if (p === "/") return true;
  return q === p || q.startsWith(p.endsWith("/") ? p : p + "/");
}

/** Combined grant for a path across all the agent's folder grants. */
export function grantFor(grants: FilesystemGrant[], path: string): FilesystemGrant {
  const merged: FilesystemGrant = {
    folderPath: path,
    canRead: false,
    canWrite: false,
    canDelete: false,
  };
  for (const g of grants) {
    if (pathWithin(g.folderPath, path)) {
      merged.canRead ||= g.canRead;
      merged.canWrite ||= g.canWrite;
      merged.canDelete ||= g.canDelete;
    }
  }
  return merged;
}

/** §7 server-side authorization: deny unless the grant covers the op. */
export function checkFsOp(
  grants: FilesystemGrant[],
  op: FsOp,
  path: string,
): { ok: true } | { ok: false; reason: string } {
  const norm = normalizePath(path);
  if (!norm) return { ok: false, reason: `path escape denied: ${path}` };
  const g = grantFor(grants, norm);
  if (!g.canRead && (op === "list" || op === "read"))
    return { ok: false, reason: `no read grant for ${norm}` };
  if (!g.canWrite && (op === "write" || op === "mkdir"))
    return { ok: false, reason: `no write grant for ${norm}` };
  if (!g.canDelete && op === "delete")
    return { ok: false, reason: `no delete grant for ${norm}` };
  return { ok: true };
}

/** The session manifest is the ONLY envelope a runner receives (§8.1). */
export function buildSessionManifest(input: {
  projectId: string;
  sessionId: string;
  agent: Agent;
  skills: Skill[];
  envNames: string[];
  environment: SessionManifest["environment"];
  task: SessionManifest["task"];
  goal: SessionManifest["goal"];
  attachments: FileObject[];
  /** MCP connection names (agent-facing contract); defaults to agent ids. */
  mcpConnectionNames?: string[];
}): SessionManifest {
  const { agent, skills, envNames, environment, task, goal, attachments } = input;
  return {
    sessionId: input.sessionId,
    projectId: input.projectId,
    agent: {
      id: agent.id,
      name: agent.name,
      title: agent.title,
      model: agent.model,
      foundationalPrompt: agent.foundationalPrompt,
      rolePrompt: agent.rolePrompt,
      skills: skills.map((s) => ({
        name: s.name,
        slug: s.slug,
        kind: s.kind,
        body: s.body,
      })),
    },
    task: task
      ? {
          id: task.id,
          name: task.name,
          description: task.description,
          status: task.status,
          approvalGate: task.approvalGate,
          attachments,
        }
      : null,
    goal,
    mcpConnections: input.mcpConnectionNames ?? agent.mcpConnectionIds,
    filesystemGrants: agent.filesystemGrants,
    repos: agent.repoAccess,
    environment,
    collaborationList: agent.collaborationList,
    inboxAccess: agent.inboxAccess,
    envNames,
    runnerPreference: agent.runnerPreference,
  };
}

/** Network wall check (§5.5): limited environments deny everything not allowlisted. */
export function networkAllowed(
  environment: SessionManifest["environment"],
  host: string,
): boolean {
  if (!environment || environment.networking === "open") return true;
  return environment.allowedHosts.some(
    (h) => h === host || host.endsWith("." + h),
  );
}
