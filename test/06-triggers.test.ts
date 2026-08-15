/**
 * Phase 5 acceptance (§21 Phase 5): webhook triggers + automations.
 * §22 #11 webhook auth.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { automations as automationsTable } from "../src/db/schema.js";
import { makeContext, newProject, agentByName, waitFor, type TestContext } from "./helpers.js";
import { hmac } from "../src/config.js";

let ctx: TestContext;
beforeEach(() => {
  ctx = makeContext();
});
afterEach(() => ctx.cleanup());

describe("§22 #11 — webhook auth", () => {
  it("bad secret → 401; good secret → task + session for the scoped agent", async () => {
    const p = await newProject(ctx);
    const support = await agentByName(ctx, p.id, "customer-support");
    const trigger = await ctx.services.triggers.create({
      projectId: p.id,
      name: "support-inbound",
      agentId: support.id,
      jobPrompt: "Support conversation:\n{{payload}}",
    });

    const body = JSON.stringify({ conversation: { id: "c1", messages: ["hi", "need help"] } });

    // Bad signature → 401.
    const bad = await ctx.app.request(`/hooks/${trigger.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentos-signature": "deadbeef" },
      body,
    });
    expect(bad.status).toBe(401);

    // Good signature → 201 + task.
    const sig = hmac(trigger.webhookSecret!, body);
    const good = await ctx.app.request(`/hooks/${trigger.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentos-signature": sig },
      body,
    });
    expect(good.status).toBe(201);
    const { taskId } = (await good.json()) as { taskId: string };

    // Task exists, assigned to the scoped agent, and the payload is in it.
    const task = await ctx.services.tasks.get(taskId);
    expect(task).toBeTruthy();
    expect(task?.assigneeAgentId).toBe(support.id);
    expect(task?.description).toContain("c1");

    // Session runs (scheduler tick) and the support agent does its job.
    await ctx.services.scheduler.tick();
    await waitFor(async () => (await ctx.services.tasks.get(taskId))?.status === "done", 15_000, "support task done");
    const done = await ctx.services.tasks.get(taskId);
    expect(done?.sessionIds.length).toBe(1);
    const session = await ctx.services.sessions.get(done!.sessionIds[0]!);
    expect(session?.manifest?.mcpConnections).toContain("front");
    expect(session?.manifest?.mcpConnections).not.toContain("github");
  });

  it("bug-report approval starts the fix chain (implement → plan → plan review → fix → E2E → human merge)", async () => {
    const p = await newProject(ctx);
    const chain = await ctx.services.triggers.startBugFixChain({
      projectId: p.id,
      branchName: "fix/123",
      featureTitle: "Webhook validation bug",
      context: "Missing validation on the payload path",
    });
    expect(chain.map((t) => t.name)).toEqual([
      "Implement fix",
      "Plan",
      "Plan review",
      "Apply review fixes",
      "E2E verification",
      "Human merge",
    ]);
    expect(chain[0]!.description).toContain("fix/123");
    expect(chain[0]!.description).toContain("Missing validation");
    expect(chain[5]!.approvalGate).toBe(true);
    expect(chain[5]!.assigneeType).toBe("human");
  });
});

describe("Phase 5 done-when — cron automations fire on the test clock", () => {
  it("a cron automation creates a task when the clock matches", async () => {
    const p = await newProject(ctx);
    const agent = await agentByName(ctx, p.id, "linkedin-content");
    const automation = await ctx.services.db
      .insert(automationsTable)
      .values({
        id: crypto.randomUUID(),
        projectId: p.id,
        name: "weekly-linkedin",
        cron: "0 9 * * 1", // Monday 09:00 UTC
        timezone: "UTC",
        agentId: agent.id,
        taskTemplateId: null,
        taskBody: "Draft this week's LinkedIn post.",
      })
      .returning()
      .get();

    // Clock at Monday 09:00:00 UTC → fires.
    const monday = new Date("2026-01-05T09:00:00Z"); // a Monday
    // Move the fake clock by setting its internal time via advance.
    const current = ctx.clock.now();
    ctx.clock.advance(monday.getTime() - current.getTime());
    await ctx.services.scheduler.tick();

    const tasks = await ctx.services.tasks.list(p.id);
    const fired = tasks.find((t) => t.name === automation.name);
    expect(fired).toBeTruthy();
    expect(fired?.description).toContain("LinkedIn");

    // Not Monday → no fire.
    const tue = new Date("2026-01-06T09:00:00Z");
    ctx.clock.advance(tue.getTime() - ctx.clock.now().getTime());
    await ctx.services.scheduler.tick();
    expect((await ctx.services.tasks.list(p.id)).filter((t) => t.name === automation.name)).toHaveLength(1);
  });

  it("recurring cron task fires on the test clock", async () => {
    const p = await newProject(ctx);
    const agent = await agentByName(ctx, p.id, "default");
    const task = await ctx.services.tasks.create(p.id, {
      name: "monthly-summary",
      description: "Summarize the inbox",
      assigneeAgentId: agent.id,
      scheduleKind: "cron",
      cron: "0 8 1 * *", // first of month 08:00
      timezone: "UTC",
    });
    const first = new Date("2026-02-01T08:00:00Z");
    ctx.clock.advance(first.getTime() - ctx.clock.now().getTime());
    await ctx.services.scheduler.tick();
    const t1 = await ctx.services.tasks.get(task.id);
    expect(t1?.sessionIds.length).toBe(1);
    // Wait for the first run to finish (agent marks done).
    await waitFor(async () => (await ctx.services.tasks.get(task.id))?.status === "done", 10_000, "first cron run done");
    // Next month: the reset + re-fire happen on the matching tick.
    const mar = new Date("2026-03-01T08:00:00Z");
    ctx.clock.advance(mar.getTime() - ctx.clock.now().getTime());
    await ctx.services.scheduler.tick();
    await waitFor(async () => (await ctx.services.tasks.get(task.id))?.sessionIds.length === 2, 10_000, "second cron run");
    const t2 = await ctx.services.tasks.get(task.id);
    expect(t2?.sessionIds.length).toBe(2);
  });
});
