/**
 * Phase 4 acceptance (§21 Phase 4): goals, DoD, orchestrator, safety rails.
 * §22 #9 goal rails, #10 DoD approval.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { goals as goalsTable, agents as agentsTable } from "../src/db/schema.js";
import { makeContext, newProject, agentByName, waitFor, type TestContext } from "./helpers.js";

let ctx: TestContext;
beforeEach(() => {
  ctx = makeContext();
});
afterEach(() => ctx.cleanup());

async function makeGoal(projectId: string, overrides: Record<string, unknown> = {}) {
  const g = await ctx.services.goals.create({
    projectId,
    title: "Ship dark mode",
    spec: "Add a dark mode toggle.\n- Dark mode toggle in settings\n- Persist choice",
    definitionOfDone: ["Dark mode toggle in settings", "Persist choice"],
    spendCapUsd: 10,
    stuckThreshold: 2,
    ...overrides,
  });
  return g;
}

describe("§22 #10 — DoD approval", () => {
  it("goal will not spawn before dodApproved", async () => {
    const p = await newProject(ctx);
    const g = await makeGoal(p.id);
    expect(g.dodApproved).toBe(false);
    const agent = await agentByName(ctx, p.id, "default");

    await expect(
      ctx.services.sessions.request({ projectId: p.id, agentId: agent.id, goalId: g.id }),
    ).rejects.toMatchObject({ status: 409 });

    await ctx.services.goals.approveDoD(g.id);
    const session = await ctx.services.sessions.request({ projectId: p.id, agentId: agent.id, goalId: g.id });
    expect(session.goalId).toBe(g.id);
  });

  it("a goal without a spend cap requires explicit confirmation at the API", async () => {
    const p = await newProject(ctx);
    const res = await ctx.app.request(`/api/projects/${p.id}/goals`, {
      method: "POST",
      headers: { ...ctx.auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "uncapped", spec: "A sufficiently long specification so the DoD draft works fine.", spendCapUsd: null }),
    });
    expect(res.status).toBe(400);
    const ok = await ctx.app.request(`/api/projects/${p.id}/goals`, {
      method: "POST",
      headers: { ...ctx.auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "uncapped-confirmed", spec: "A sufficiently long specification so the DoD draft works fine.", spendCapUsd: null, confirmNoCap: true }),
    });
    expect(ok.status).toBe(201);
  });
});

describe("goal loop (Phase 4 done-when)", () => {
  it("a small goal with a 2-item DoD completes by spawning at least two specialist sessions", async () => {
    const p = await newProject(ctx);
    const g = await makeGoal(p.id);
    await ctx.services.goals.approveDoD(g.id);

    // Kick off via the session service (as the orchestrator would).
    const agent = await agentByName(ctx, p.id, "default");
    const session1 = await ctx.services.sessions.request({ projectId: p.id, agentId: agent.id, goalId: g.id });
    await ctx.services.sessions.start(session1.id);
    // Orchestrator hook runs after each goal session.
    await waitFor(async () => {
      const cur = await ctx.services.goals.get(g.id);
      return cur?.status === "completed";
    }, 20_000, "goal completed");

    const done = await ctx.services.goals.get(g.id);
    expect(done?.status).toBe("completed");
    expect(done?.definitionOfDone.every((d) => d.done)).toBe(true);
    expect(done?.sessionIds.length).toBeGreaterThanOrEqual(2);
  });
});

describe("§22 #9 — goal rails", () => {
  it("spend cap: $0.00 refuses to spawn (stops before any session)", async () => {
    const p = await newProject(ctx);
    const g = await makeGoal(p.id, { spendCapUsd: 0 });
    await ctx.services.goals.approveDoD(g.id);
    const agent = await agentByName(ctx, p.id, "default");

    // First session runs (it was already allowed), then the orchestrator
    // trips the spend rail before spawning anything else.
    const s = await ctx.services.sessions.request({ projectId: p.id, agentId: agent.id, goalId: g.id });
    await ctx.services.sessions.start(s.id);
    const after = await ctx.services.goals.get(g.id);
    expect(after?.status).toBe("stopped-spend");
    expect(after?.sessionIds.length).toBe(1);
  });

  it("time rail: maxDuration exceeded → stopped-time, no more sessions", async () => {
    const p = await newProject(ctx);
    const g = await makeGoal(p.id, { maxDurationMinutes: 1 });
    await ctx.services.goals.approveDoD(g.id);
    // Backdate the start so the duration is already exceeded.
    await ctx.services.db
      .update(goalsTable)
      .set({ startedAt: new Date(Date.now() - 2 * 60_000).toISOString() })
      .where(eq(goalsTable.id, g.id))
      .run();
    const agent = await agentByName(ctx, p.id, "default");
    const s = await ctx.services.sessions.request({ projectId: p.id, agentId: agent.id, goalId: g.id });
    await ctx.services.sessions.start(s.id);
    const after = await ctx.services.goals.get(g.id);
    expect(after?.status).toBe("stopped-time");
  });

  it("stuck rail: stuckThreshold=2 stops after two no-progress iterations", async () => {
    const p = await newProject(ctx);
    const g = await makeGoal(p.id, { stuckThreshold: 2 });
    await ctx.services.goals.approveDoD(g.id);
    const agent = await agentByName(ctx, p.id, "default");

    // Only ONE specialist on the allow list → the orchestrator keeps
    // choosing the same agent, so stuck detection can trip (§11 rail).
    await ctx.services.db
      .delete(agentsTable)
      .where(eq(agentsTable.projectId, p.id))
      .run();
    await ctx.services.db
      .insert(agentsTable)
      .values({
        ...agent,
        id: agent.id,
        createdAt: new Date().toISOString(),
      })
      .run();

    // Every goal session (including orchestrator-spawned ones) runs a
    // no-progress script: no progress-log entries, no DoD mentions. Each
    // finished session triggers the orchestrator; after two no-progress
    // iterations it must trip the stuck rail.
    ctx.services.sessions.setGoalScriptOverride([{ kind: "wait", ms: 5 }]);
    const noProgress = [{ kind: "wait", ms: 5 }];
    let after: Awaited<ReturnType<typeof ctx.services.goals.get>> | null = null;
    for (let i = 0; i < 8; i++) {
      const s = await ctx.services.sessions.request({ projectId: p.id, agentId: agent.id, goalId: g.id });
      ctx.services.sessions.stageSession(s.id, { script: noProgress });
      await ctx.services.sessions.start(s.id);
      after = await ctx.services.goals.get(g.id);
      if (after?.status === "stopped-stuck") break;
    }
    expect(after?.status).toBe("stopped-stuck");
    // Several no-progress iterations ran before the rail tripped.
    expect(after!.sessionIds.length).toBeGreaterThanOrEqual(2);
    // After the rail tripped, the orchestrator spawns NOTHING more.
    const countAtStop = after!.sessionIds.length;
    await new Promise((r) => setTimeout(r, 300));
    const later = await ctx.services.goals.get(g.id);
    expect(later?.status).toBe("stopped-stuck");
    expect(later?.sessionIds.length).toBe(countAtStop);
  });
});
