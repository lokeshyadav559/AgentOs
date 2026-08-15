/**
 * §22 #14 — orchestrator spawn list / collaboration list.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeContext, newProject, agentByName, createTask, runScriptedSession, type TestContext } from "./helpers.js";

let ctx: TestContext;
beforeEach(() => {
  ctx = makeContext();
});
afterEach(() => ctx.cleanup());

describe("§22 #14 — orchestrator spawn list", () => {
  it("MCP collaborators.spawn cannot spawn an agent not on the collaboration list", async () => {
    const p = await newProject(ctx);
    // default agent has NO collaboration list.
    const agent = await agentByName(ctx, p.id, "default");
    const task = await createTask(ctx, p.id, { name: "spawn-blocked", assigneeAgentId: agent.id });

    const script = [
      { kind: "tool", tool: "collaborators.spawn", args: { agentName: "senior-dev", brief: "do work" } },
      { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
    ];
    const { session } = await runScriptedSession(ctx, {
      projectId: p.id,
      agentId: agent.id,
      taskId: task.id,
      script,
    });
    expect(session.toolCallLog[0]?.error).toContain("not on the collaboration list");
    // No subtask was created.
    const tasks = await ctx.services.tasks.list(p.id);
    expect(tasks.filter((t) => t.name.startsWith("Collaborator"))).toHaveLength(0);
  });

  it("review-coordinator CAN spawn its four listed reviewers", async () => {
    const p = await newProject(ctx);
    const coordinator = await agentByName(ctx, p.id, "review-coordinator");
    expect(coordinator.collaborationList).toEqual(
      expect.arrayContaining(["feasibility", "scope-guardian", "coherence", "plan-risk"]),
    );
    const task = await createTask(ctx, p.id, { name: "review", assigneeAgentId: coordinator.id });

    const script = [
      { kind: "tool", tool: "collaborators.spawn", args: { agentName: "feasibility", brief: "review" } },
      { kind: "tool", tool: "collaborators.spawn", args: { agentName: "plan-risk", brief: "review" } },
      { kind: "tool", tool: "collaborators.spawn", args: { agentName: "senior-dev", brief: "not allowed" } },
      { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
    ];
    const { session } = await runScriptedSession(ctx, {
      projectId: p.id,
      agentId: coordinator.id,
      taskId: task.id,
      script,
    });
    expect(session.toolCallLog[0]?.error).toBeFalsy();
    expect(session.toolCallLog[1]?.error).toBeFalsy();
    expect(session.toolCallLog[2]?.error).toContain("not on the collaboration list");

    const tasks = await ctx.services.tasks.list(p.id);
    const collabs = tasks.filter((t) => t.name.startsWith("Collaborator"));
    expect(collabs.map((t) => t.name)).toEqual(["Collaborator: feasibility", "Collaborator: plan-risk"]);
  });

  it("orchestrator only picks specialists from the project allow list", async () => {
    const p = await newProject(ctx);
    const g = await ctx.services.goals.create({
      projectId: p.id,
      title: "t",
      spec: "work",
      definitionOfDone: ["a", "b"],
      spendCapUsd: 10,
    });
    await ctx.services.goals.approveDoD(g.id);
    const agent = await agentByName(ctx, p.id, "plan");
    const d = await ctx.services.goals.orchestrate(g.id, {
      allowList: [{ id: agent.id, name: agent.name }],
    });
    expect(d.action).toBe("continue");
    expect(d.nextAgentId).toBe(agent.id);
    expect(d.nextAgentName).toBe("plan");
  });
});
