/**
 * Phase 2 acceptance (§21 Phase 2): least-privilege isolation.
 * §22 #2 ACL filesystem, #3 ACL MCP, #4 network wall, #13 least-privilege
 * support agent (Front only; no GitHub, no Gmail, no repo clone).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents as agentsTable, environments, repos as reposTable } from "../src/db/schema.js";
import { makeContext, newProject, agentByName, createTask, runScriptedSession, type TestContext } from "./helpers.js";
import { checkFsOp, networkAllowed, normalizePath } from "../src/acl/grants.js";
import { redactUrlCredentials } from "../src/services/sessions.js";
import { serversForManifest } from "../src/mcp/index.js";

let ctx: TestContext;
beforeEach(() => {
  ctx = makeContext();
});
afterEach(() => ctx.cleanup());

describe("§22 #2 — ACL filesystem (server-side read/write/delete)", () => {
  it("write without canWrite fails; delete without canDelete fails; ../ escape fails", async () => {
    const p = await newProject(ctx);
    const agent = await agentByName(ctx, p.id, "default");
    // Narrow the agent's grants: read+write only under /agents/default (no
    // delete), nothing else (§5.7).
    await ctx.services.db
      .update(agentsTable)
      .set({
        filesystemGrants: [
          { folderPath: "/agents/default", canRead: true, canWrite: true, canDelete: false },
        ],
      })
      .where(eq(agentsTable.id, agent.id))
      .run();
    const task = await createTask(ctx, p.id, { name: "acl", assigneeAgentId: agent.id });

    const script = [
      // 1. write into a folder the agent has no grant for → denied
      { kind: "tool", tool: "fs.write", args: { path: "/agents/other/secret.txt", content: "x" } },
      // 2. path escape → denied
      { kind: "tool", tool: "fs.read", args: { path: "/agents/default/../secret.txt" } },
      // 3. delete without canDelete → denied (grant is write, not delete)
      { kind: "tool", tool: "fs.write", args: { path: "/agents/default/keep.txt", content: "hi" } },
      { kind: "tool", tool: "fs.delete", args: { path: "/agents/default/keep.txt" } },
      // 4. legit write → ok
      { kind: "tool", tool: "fs.write", args: { path: "/agents/default/ok.txt", content: "fine" } },
      { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
    ];
    const { session } = await runScriptedSession(ctx, {
      projectId: p.id,
      agentId: agent.id,
      taskId: task.id,
      script,
    });
    const calls = session.toolCallLog;
    expect(calls[0]?.error).toContain("denied"); // no write grant
    expect(calls[1]?.error).toContain("path escape denied"); // ../
    expect(calls[2]?.error).toBeFalsy();
    expect(calls[3]?.error).toContain("no delete grant"); // delete denied
    expect(calls[4]?.error).toBeFalsy();
    // keep.txt still exists (delete was denied); ok.txt exists.
    const entries = await ctx.services.files.list(p.id, "/agents/default");
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("/agents/default/keep.txt");
    expect(paths).toContain("/agents/default/ok.txt");
    // And the denied write never landed anywhere.
    const other = await ctx.services.files.list(p.id, "/agents/other");
    expect(other.filter((e) => e.type === "file")).toHaveLength(0);
  });

  it("unit: checkFsOp enforces per-verb grants and path normalization", () => {
    const grants = [
      { folderPath: "/agents/a", canRead: true, canWrite: true, canDelete: false },
      { folderPath: "/goals/", canRead: true, canWrite: true, canDelete: false },
    ];
    expect(checkFsOp(grants, "write", "/agents/a/x.txt").ok).toBe(true);
    expect(checkFsOp(grants, "delete", "/agents/a/x.txt").ok).toBe(false);
    expect(checkFsOp(grants, "read", "/agents/b/x.txt").ok).toBe(false);
    expect(checkFsOp(grants, "read", "/agents/a/../b/x.txt").ok).toBe(false);
    expect(checkFsOp(grants, "write", "/goals/g1/note.md").ok).toBe(true);
    expect(checkFsOp(grants, "delete", "/goals/g1/note.md").ok).toBe(false); // delete still explicit
    expect(normalizePath("/a//b/")).toBe("/a/b");
    expect(normalizePath("/a/../b")).toBeNull();
  });
});

describe("§22 #3 — ACL MCP: no GitHub for agents without the grant", () => {
  it("plan agent (no github MCP) cannot invoke github tools even though the project has one", async () => {
    const p = await newProject(ctx);
    // Project HAS a github connection (seeded).
    const plan = await agentByName(ctx, p.id, "plan");
    expect(plan.mcpConnectionIds.some((id) => id.includes("github"))).toBe(false);

    // The manifest carries connection NAMES (the agent-facing contract).
    const servers = serversForManifest(["agentos", "inbox", "r2-fs"]);
    const names = servers.flatMap((s) => s.tools.map((t) => t.name));
    expect(names).not.toContain("github.list_repos");
    expect(names).toContain("tasks.current");
    expect(names).toContain("fs.read");

    const task = await createTask(ctx, p.id, { name: "plan-only", assigneeAgentId: plan.id });
    const script = [
      { kind: "tool", tool: "github.list_repos", args: {} },
      { kind: "tool", tool: "tasks.current", args: {} },
      { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
    ];
    const { session } = await runScriptedSession(ctx, {
      projectId: p.id,
      agentId: plan.id,
      taskId: task.id,
      script,
    });
    expect(session.toolCallLog[0]?.error).toContain("unknown tool");
    expect(session.toolCallLog[1]?.error).toBeFalsy();
  });
});

describe("§22 #4 — network wall", () => {
  it("limited environment to api.front.com blocks github.com but allows api.front.com; open allows all", () => {
    const limited = { networking: "limited" as const, allowedHosts: ["api.front.com"] };
    const open = { networking: "open" as const, allowedHosts: [] };
    expect(networkAllowed(limited, "api.front.com")).toBe(true);
    expect(networkAllowed(limited, "github.com")).toBe(false);
    expect(networkAllowed(limited, "sub.api.front.com")).toBe(true);
    expect(networkAllowed(open, "github.com")).toBe(true);
    expect(networkAllowed(null, "anything.example")).toBe(true); // no env → no policy
  });

  it("network wall enforced at tool dispatch: front tools denied when api.front.com is not allowlisted", async () => {
    const p = await newProject(ctx);
    const support = await agentByName(ctx, p.id, "customer-support"); // has the front MCP
    const lockedEnvId = randomUUID();
    await ctx.services.db
      .insert(environments)
      .values({
        id: lockedEnvId,
        projectId: p.id,
        name: "locked",
        networking: "limited",
        allowedHosts: ["internal.corp.example"],
        envNames: [],
      })
      .run();
    await ctx.services.db
      .update(agentsTable)
      .set({ environmentId: lockedEnvId })
      .where(eq(agentsTable.id, support.id))
      .run();
    const task = await createTask(ctx, p.id, { name: "wall", assigneeAgentId: support.id });

    // Front connection granted, but its host is not on the allowlist → denied.
    const blocked = await runScriptedSession(ctx, {
      projectId: p.id,
      agentId: support.id,
      taskId: task.id,
      script: [
        { kind: "tool", tool: "front.list_conversations", args: {} },
        { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
      ],
    });
    expect(blocked.session.toolCallLog[0]?.error).toContain("network wall denied");

    // Allowlist the host → the same tool works.
    await ctx.services.db
      .update(environments)
      .set({ allowedHosts: ["internal.corp.example", "api.front.com"] })
      .where(eq(environments.id, lockedEnvId))
      .run();
    const allowed = await runScriptedSession(ctx, {
      projectId: p.id,
      agentId: support.id,
      taskId: task.id,
      script: [
        { kind: "tool", tool: "front.list_conversations", args: {} },
        { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
      ],
    });
    expect(allowed.session.toolCallLog[0]?.error).toBeFalsy();
  });

  it("seeded agents resolve their environment — the wall is live out of the box", async () => {
    const p = await newProject(ctx);
    // customer-support → "limited-none" with Front allowlisted (§5.3).
    const support = await agentByName(ctx, p.id, "customer-support");
    expect(support.environmentId).not.toBeNull();
    const [supportEnv] = await ctx.services.db
      .select()
      .from(environments)
      .where(eq(environments.id, support.environmentId!))
      .all();
    expect(supportEnv?.networking).toBe("limited");
    expect(supportEnv?.allowedHosts).toContain("api.front.com");
    // default → "open".
    const def = await agentByName(ctx, p.id, "default");
    expect(def.environmentId).not.toBeNull();
    const [defEnv] = await ctx.services.db
      .select()
      .from(environments)
      .where(eq(environments.id, def.environmentId!))
      .all();
    expect(defEnv?.networking).toBe("open");
  });
});

describe("least-privilege hardening (§5.7)", () => {
  it("tasks.attach enforces the agent's read grant like fs.read", async () => {
    const p = await newProject(ctx);
    const agent = await agentByName(ctx, p.id, "default");
    // A file outside the agent's grants (default has /agents/default + /goals).
    await ctx.services.files.write(p.id, "/agents/other/secret.txt", "secret");
    const task = await createTask(ctx, p.id, { name: "attach", assigneeAgentId: agent.id });

    const denied = await runScriptedSession(ctx, {
      projectId: p.id,
      agentId: agent.id,
      taskId: task.id,
      script: [
        { kind: "tool", tool: "tasks.attach", args: { filePath: "/agents/other/secret.txt" } },
        { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
      ],
    });
    expect(denied.session.toolCallLog[0]?.error).toContain("attachment denied");

    // The same file is attachable once the agent has a read grant for it.
    await ctx.services.db
      .update(agentsTable)
      .set({
        filesystemGrants: [
          { folderPath: "/agents/default", canRead: true, canWrite: true, canDelete: true },
          { folderPath: "/goals/", canRead: true, canWrite: true, canDelete: false },
          { folderPath: "/agents/other", canRead: true, canWrite: false, canDelete: false },
        ],
      })
      .where(eq(agentsTable.id, agent.id))
      .run();
    const allowed = await runScriptedSession(ctx, {
      projectId: p.id,
      agentId: agent.id,
      taskId: task.id,
      script: [
        { kind: "tool", tool: "tasks.attach", args: { filePath: "/agents/other/secret.txt" } },
        { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
      ],
    });
    expect(allowed.session.toolCallLog[0]?.error).toBeFalsy();
    expect(allowed.session.toolCallLog[0]?.output).toHaveProperty("attachmentIds");
  });

  it("repo mountPath escaping the session work dir is refused at clone time", async () => {
    const p = await newProject(ctx);
    const agent = await agentByName(ctx, p.id, "default");
    const repoId = randomUUID();
    await ctx.services.db
      .insert(reposTable)
      .values({
        id: repoId,
        projectId: p.id,
        name: "evil-mount",
        remoteUrl: "https://example.com/repo.git",
        mountPath: "/ignored",
        credentialSecretId: null,
        defaultBranch: "main",
      })
      .run();
    await ctx.services.db
      .update(agentsTable)
      .set({
        repoAccess: [{ repoId, mountPath: "../escape", permissions: "git-read" }],
      })
      .where(eq(agentsTable.id, agent.id))
      .run();

    const task = await createTask(ctx, p.id, { name: "mount", assigneeAgentId: agent.id });
    const { session, outcome } = await runScriptedSession(ctx, {
      projectId: p.id,
      agentId: agent.id,
      taskId: task.id,
      script: [
        { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
      ],
    });
    expect(outcome.status).toBe("ok");
    const feed = await ctx.services.activity.list();
    expect(feed.some((a) => a.message.includes("escape denied"))).toBe(true);
    expect(feed.some((a) => a.message.includes("clone skipped/failed"))).toBe(false);
    void session;
  });
});

describe("§5.9 — repo credential redaction", () => {
  it("redactUrlCredentials masks the injected credential and any https userinfo", () => {
    const token = "ghp_abc123def456";
    const msg = `fatal: unable to access 'https://${token}@github.com/acme/repo.git/': The requested URL returned error: 403`;
    const redacted = redactUrlCredentials(msg, token);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain("https://***@github.com/acme/repo.git/");
    // Defensive: userinfo masked even without the exact credential value.
    expect(redactUrlCredentials("fatal: 'https://user:secret@host/x.git'", null)).toBe(
      "fatal: 'https://***@host/x.git'",
    );
    // Plain URLs without credentials are untouched.
    expect(redactUrlCredentials("fatal: 'https://github.com/x.git'", null)).toBe(
      "fatal: 'https://github.com/x.git'",
    );
  });
});

describe("§22 #13 — least-privilege support agent", () => {
  it("customer-support session manifest has Front only: no github, no gmail, no repos, no env", async () => {
    const p = await newProject(ctx);
    const support = await agentByName(ctx, p.id, "customer-support");
    const task = await createTask(ctx, p.id, { name: "support", assigneeAgentId: support.id });

    const script = [
      { kind: "tool", tool: "front.list_conversations", args: {} },
      { kind: "tool", tool: "front.read_conversation", args: { id: "demo-support-1" } },
      { kind: "tool", tool: "github.list_repos", args: {} },
      { kind: "tool", tool: "gmail.list", args: {} },
      { kind: "tool", tool: "fs.read", args: { path: "/wiki/secret.md" } },
      { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
    ];
    const { session } = await runScriptedSession(ctx, {
      projectId: p.id,
      agentId: support.id,
      taskId: task.id,
      script,
    });

    const m = session.manifest;
    // Session manifest: no GitHub, no Gmail, no repo grants, no env names.
    expect(m.mcpConnections).toEqual(expect.arrayContaining(["agentos", "inbox", "front"]));
    expect(m.mcpConnections).not.toContain("github");
    expect(m.repos).toHaveLength(0);
    expect(m.envNames).toHaveLength(0);
    // Front works; github/gmail unknown; wiki read denied (no grant).
    expect(session.toolCallLog[0]?.error).toBeFalsy();
    expect(session.toolCallLog[1]?.error).toBeFalsy();
    expect(session.toolCallLog[2]?.error).toContain("unknown tool");
    expect(session.toolCallLog[3]?.error).toContain("unknown tool");
    // No r2-fs mounted either — the filesystem tools simply do not exist.
    expect(session.toolCallLog[4]?.error).toContain("unknown tool");
  });
});
