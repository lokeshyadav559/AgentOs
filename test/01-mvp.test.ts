/**
 * Phase 1 acceptance (§21 Phase 1): one agent, one task, one session.
 * §22 #1 (session destroy / reclone) is covered here at the lifecycle level.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { repos as reposTable, agents as agentsTable } from "../src/db/schema.js";
import { makeContext, newProject, agentByName, createTask, waitFor, type TestContext } from "./helpers.js";

let ctx: TestContext;
beforeEach(() => {
  ctx = makeContext();
});
afterEach(() => ctx.cleanup());

describe("Phase 1 — MVP lifecycle", () => {
  it("create task → agent session starts → MCP updates task → session destroyed → card done", async () => {
    const p = await newProject(ctx);
    const agent = await agentByName(ctx, p.id, "default");
    const task = await createTask(ctx, p.id, {
      name: "hello",
      description: "do the thing",
      assigneeAgentId: agent.id,
    });

    // Scheduler dispatches the task.
    await ctx.services.scheduler.tick();
    await waitFor(async () => (await ctx.services.tasks.get(task.id))?.status === "done", 10_000, "task done");

    const done = await ctx.services.tasks.get(task.id);
    expect(done?.status).toBe("done");
    expect(done?.sessionIds.length).toBe(1);
    expect(done?.activity.some((a) => a.message.includes("status → doing"))).toBe(true);

    const session = await ctx.services.sessions.get(done!.sessionIds[0]!);
    expect(session?.status).toBe("destroyed");
    expect(session?.toolCallLog.length).toBeGreaterThan(0);
    expect(session?.toolCallLog.some((t) => t.name === "tasks.set_status")).toBe(true);
    expect(session?.manifest?.mcpConnections).toContain("agentos");
    // Everything the agent wrote went through the fs MCP → file store.
    const files = await ctx.services.files.list(p.id, "/agents/default");
    expect(files.some((f) => f.type === "file")).toBe(true);
  });

  it("§22 #1 session destroy: no runner handle remains; work dir (container stand-in) is gone; next session reclones fresh", async () => {
    // Local git repo fixture (bare) to mount.
    const repoDir = path.join(ctx.config.dataDir, "fixture-repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: repoDir });

    const p = await newProject(ctx);
    const repo = await ctx.services.db
      .insert(reposTable)
      .values({
        id: crypto.randomUUID(),
        projectId: p.id,
        name: "app",
        remoteUrl: repoDir,
        mountPath: "/workspace/app",
        credentialSecretId: null,
        defaultBranch: "main",
      })
      .returning()
      .get();

    // Agent with git-READ repo access: local workspace changes can never
    // leak into the next session (nothing is committed, so the repo stays
    // pristine and every session must re-clone).
    const agent = await agentByName(ctx, p.id, "senior-dev");
    await ctx.services.db
      .update(agentsTable)
      .set({ repoAccess: [{ repoId: repo.id, mountPath: "/workspace/app", permissions: "git-read" }] })
      .where(eq(agentsTable.id, agent.id))
      .run();

    // Session 1: while running, the mount exists (fresh clone). Then dirty it.
    const t1 = await createTask(ctx, p.id, { name: "run1", assigneeAgentId: agent.id });
    const s1 = await ctx.services.sessions.request({ projectId: p.id, agentId: agent.id, taskId: t1.id });
    ctx.services.sessions.stageSession(s1.id, {
      script: [
        { kind: "wait", ms: 250 },
        { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
      ],
    });
    const startPromise = ctx.services.sessions.start(s1.id);
    await waitFor(
      async () => {
        const s = await ctx.services.sessions.get(s1.id);
        return s?.status === "running";
      },
      5000,
      "session running",
    );
    // Mount exists during the run (fresh clone from the fixture repo).
    const mount1 = path.join(ctx.config.workDir, s1.id, "workspace/app");
    await waitFor(() => Promise.resolve(existsSync(mount1)), 5000, "mount clone");
    expect(readFileSync(path.join(mount1, "README.md"), "utf8")).toContain("fixture");
    // Dirty the workspace — this must NOT leak into the next session.
    writeFileSync(path.join(mount1, "dirty.txt"), "uncommitted junk");
    await startPromise;

    const after1 = await ctx.services.sessions.get(s1.id);
    expect(after1?.status).toBe("destroyed");
    // Container destroyed: work dir removed.
    expect(existsSync(path.join(ctx.config.workDir, s1.id))).toBe(false);
    // git-read → nothing committed.
    expect(after1?.commitShas.length).toBe(0);

    // Session 2: a NEW session dir, recloned from the repo HEAD.
    const t2 = await createTask(ctx, p.id, { name: "run2", assigneeAgentId: agent.id });
    const s2 = await ctx.services.sessions.request({ projectId: p.id, agentId: agent.id, taskId: t2.id });
    ctx.services.sessions.stageSession(s2.id, {
      script: [
        { kind: "wait", ms: 250 },
        { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
      ],
    });
    const p2 = ctx.services.sessions.start(s2.id);
    await waitFor(
      async () => {
        const s = await ctx.services.sessions.get(s2.id);
        return s?.status === "running";
      },
      5000,
      "session2 running",
    );
    const mount2 = path.join(ctx.config.workDir, s2.id, "workspace/app");
    await waitFor(() => Promise.resolve(existsSync(mount2)), 5000, "mount2 clone");
    // Fresh clone: the uncommitted dirty file from session 1 is NOT present —
    // the workspace was thrown away and re-cloned, not reused.
    expect(existsSync(path.join(mount2, "dirty.txt"))).toBe(false);
    expect(readFileSync(path.join(mount2, "README.md"), "utf8")).toContain("fixture");
    await p2;
    const after2 = await ctx.services.sessions.get(s2.id);
    expect(after2?.status).toBe("destroyed");
    expect(after2?.commitShas.length).toBe(0);
  });
});
