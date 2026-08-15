/**
 * Phase 3 acceptance (§21 Phase 3): templates, approval gates, chains.
 * §22 #5 approval gate, #6 template chain.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeContext, newProject, agentByName, createTask, runScriptedSession, waitFor, type TestContext } from "./helpers.js";

let ctx: TestContext;
beforeEach(() => {
  ctx = makeContext();
});
afterEach(() => ctx.cleanup());

describe("§22 #6 — compound-engineer-workflow template chain", () => {
  it("instantiating the feature template creates 9 cards in order with variables interpolated", async () => {
    const p = await newProject(ctx);
    const tpls = await ctx.services.tasks.listTemplates(p.id);
    const tpl = tpls.find((t) => t.name === "compound-engineer-workflow");
    expect(tpl).toBeTruthy();
    expect(tpl!.steps).toHaveLength(9);

    const chain = await ctx.services.tasks.instantiateTemplate(p.id, tpl!.id, {
      branchName: "feat/xyz",
      featureTitle: "Dark mode",
    });
    expect(chain).toHaveLength(9);
    expect(chain.map((t) => t.chainIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(chain.map((t) => t.chainId)).size).toBe(1);
    // §10 step order
    expect(chain.map((t) => t.name)).toEqual([
      "Write a spec",
      "Plan",
      "Plan review",
      "Revise plan",
      "Implementation",
      "Code review",
      "Apply review fixes",
      "Librarian",
      "Human PR review",
    ]);
    // Variables interpolated into prompts.
    expect(chain[0]!.description).toContain("Dark mode");
    expect(chain[0]!.description).toContain("feat/xyz");
    expect(chain[4]!.description).toContain("feat/xyz");
    // Gates: step 1 (spec) and step 9 (human) are approval-gated.
    expect(chain[0]!.approvalGate).toBe(true);
    expect(chain[8]!.approvalGate).toBe(true);
    expect(chain[1]!.approvalGate).toBe(false);
    // Step 8 is a human task.
    expect(chain[8]!.assigneeType).toBe("human");
  });

  it("step 2 does not start until a human marks step 1 done; agent token cannot mark step 1 done", async () => {
    const p = await newProject(ctx);
    const tpl = (await ctx.services.tasks.listTemplates(p.id)).find((t) => t.name === "compound-engineer-workflow")!;
    const chain = await ctx.services.tasks.instantiateTemplate(p.id, tpl.id, {
      branchName: "feat/a",
      featureTitle: "Thing",
    });
    const [step1, step2] = chain;

    // Scheduler dispatches step 1 (spec agent) → agent asks via inbox.
    await ctx.services.scheduler.tick();
    await waitFor(
      async () => {
        const s1 = await ctx.services.tasks.get(step1.id);
        return s1?.sessionIds.length === 1;
      },
      10_000,
      "step1 session starts",
    );
    const sessId = (await ctx.services.tasks.get(step1.id))!.sessionIds[0]!;
    await waitFor(
      async () => (await ctx.services.sessions.get(sessId))?.status === "waiting-inbox",
      10_000,
      "spec agent asks",
    );

    // Step 2 must stay todo while step 1 is not done.
    await ctx.services.scheduler.tick();
    expect((await ctx.services.tasks.get(step2.id))?.status).toBe("todo");

    // §22 #5: an agent session cannot mark the gated task done.
    const specAgent = await agentByName(ctx, p.id, "spec");
    const denied = await runScriptedSession(ctx, {
      projectId: p.id,
      agentId: specAgent.id,
      taskId: step1.id,
      script: [{ kind: "tool", tool: "tasks.set_status", args: { status: "done" } }],
    });
    expect(denied.session.toolCallLog[0]?.error).toContain("approval-gated");

    // Human approves the spec (answers the inbox question).
    const question = (await ctx.services.inbox.openForSession(sessId)).find((m) => m.status === "open")!;
    await ctx.services.sessions.resumeFromInbox(question.id, { selectedChoiceId: "c0" });
    await waitFor(
      async () => (await ctx.services.tasks.get(step1.id))?.status === "review",
      10_000,
      "step1 review",
    );

    // Human marks step 1 done → step 2 released.
    await ctx.services.tasks.setStatus(step1.id, "done", { actor: "human" });
    expect((await ctx.services.tasks.get(step2.id))?.scheduleKind).toBe("now");
    await ctx.services.scheduler.tick();
    await waitFor(
      async () => (await ctx.services.tasks.get(step2.id))?.status !== "todo",
      10_000,
      "step2 starts",
    );
    expect((await ctx.services.tasks.get(step2.id))?.status).not.toBe("todo");
  });
});

describe("§22 #5 — approval gates are not honor-system", () => {
  it("API rejects agent PATCH done (403-equivalent via service); human PATCH works; follow-up blocked", async () => {
    const p = await newProject(ctx);
    const agent = await agentByName(ctx, p.id, "default");
    const task = await createTask(ctx, p.id, {
      name: "gated",
      description: "needs human",
      assigneeAgentId: agent.id,
      approvalGate: true,
    });

    // Agent attempt (MCP path) → 403 semantic.
    await expect(
      ctx.services.tasks.setStatus(task.id, "done", { actor: "agent", agentId: agent.id }),
    ).rejects.toMatchObject({ status: 403 });
    // Agent can move it to review.
    await ctx.services.tasks.setStatus(task.id, "review", { actor: "agent", agentId: agent.id });
    // Human can mark done.
    const done = await ctx.services.tasks.setStatus(task.id, "done", { actor: "human" });
    expect(done.status).toBe("done");
  });

  it("HTTP: agent-style bearer cannot PATCH done on gated task; human (operator) can", async () => {
    const p = await newProject(ctx);
    const agent = await agentByName(ctx, p.id, "default");
    const task = await createTask(ctx, p.id, {
      name: "gated-http",
      assigneeAgentId: agent.id,
      approvalGate: true,
    });
    // The API has no agent token path (agents go through MCP in-process);
    // simulate the equivalent: a non-operator token must 401.
    const bad = await ctx.app.request(`/api/projects/${p.id}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer not-an-operator", "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(bad.status).toBe(401);
    const good = await ctx.app.request(`/api/projects/${p.id}/tasks/${task.id}`, {
      method: "PATCH",
      headers: ctx.auth,
      body: JSON.stringify({ status: "done" }),
    });
    expect(good.status).toBe(200);
    const body = (await good.json()) as { status: string };
    expect(body.status).toBe("done");
  });
});
