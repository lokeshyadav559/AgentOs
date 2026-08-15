/**
 * §22 #7 inbox resume, #8 multiple-choice rendering/storage (§12).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeContext, newProject, agentByName, createTask, runScriptedSession, waitFor, type TestContext } from "./helpers.js";

let ctx: TestContext;
beforeEach(() => {
  ctx = makeContext();
});
afterEach(() => ctx.cleanup());

describe("§22 #7 — inbox resume", () => {
  it("waiting-inbox + reply → session continues with the answer in context", async () => {
    const p = await newProject(ctx);
    const agent = await agentByName(ctx, p.id, "default");
    const task = await createTask(ctx, p.id, { name: "ask-me", assigneeAgentId: agent.id });

    const script = [
      { kind: "ask", body: "Proceed?", choices: ["Yes", "No"],
        onReply: {
          c0: [
            { kind: "tool", tool: "tasks.append_activity", args: { message: "human said YES" } },
            { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
          ],
          c1: [
            { kind: "tool", tool: "tasks.append_activity", args: { message: "human said NO" } },
            { kind: "tool", tool: "tasks.set_status", args: { status: "done" } },
          ],
        } },
    ];
    const session = await ctx.services.sessions.request({
      projectId: p.id, agentId: agent.id, taskId: task.id,
    });
    ctx.services.sessions.stageSession(session.id, { script });
    const running = ctx.services.sessions.start(session.id);

    // Agent asks; session pauses.
    await waitFor(async () => {
      const s = await ctx.services.sessions.get(session.id);
      return s?.status === "waiting-inbox";
    }, 10_000, "waiting-inbox");

    const open = await ctx.services.inbox.openForSession(session.id);
    const question = open.find((m) => m.kind === "multiple-choice" && m.status === "open");
    expect(question).toBeTruthy();
    expect(question!.choices.map((c) => c.label)).toEqual(["Yes", "No"]);

    // Human answers "Yes" via the resume path (API-equivalent).
    await ctx.services.sessions.resumeFromInbox(question!.id, { selectedChoiceId: "c0" });

    const outcome = await running;
    expect(outcome.status).toBe("ok");
    const done = await ctx.services.tasks.get(task.id);
    expect(done?.status).toBe("done");
    // The answer was in context: the agent logged which choice arrived.
    expect(done?.activity.some((a) => a.message.includes("human said YES"))).toBe(true);
  });
});

describe("§22 #8 — multiple-choice messages", () => {
  it("message with choices renders and stores selectedChoiceId", async () => {
    const p = await newProject(ctx);
    const agent = await agentByName(ctx, p.id, "default");
    const task = await createTask(ctx, p.id, { name: "choices", assigneeAgentId: agent.id });

    const script = [
      { kind: "ask", body: "Pick one", choices: ["A", "B"],
        onReply: { c0: [], c1: [] },
        default: [{ kind: "tool", tool: "tasks.set_status", args: { status: "done" } }] },
    ];
    const session = await ctx.services.sessions.request({
      projectId: p.id, agentId: agent.id, taskId: task.id,
    });
    ctx.services.sessions.stageSession(session.id, { script });
    const running = ctx.services.sessions.start(session.id);
    await waitFor(async () => {
      const s = await ctx.services.sessions.get(session.id);
      return s?.status === "waiting-inbox";
    }, 10_000, "waiting-inbox");

    const question = (await ctx.services.inbox.openForSession(session.id)).find((m) => m.kind === "multiple-choice")!;
    expect(question.choices).toHaveLength(2);
    expect(question.status).toBe("open");
    expect(question.selectedChoiceId).toBeNull();

    // Reply with a choice id.
    await ctx.services.sessions.resumeFromInbox(question.id, { selectedChoiceId: "c1" });
    await running;

    const stored = await ctx.services.inbox.get(question.id);
    expect(stored?.status).toBe("answered");
    expect(stored?.selectedChoiceId).toBe("c1");
    // The human reply message exists in the thread.
    const thread = await ctx.services.inbox.openForSession(session.id);
    expect(thread.some((m) => m.from === "human" && m.body.includes("B"))).toBe(true);
  });
});
