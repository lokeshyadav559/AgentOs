/**
 * Test harness: in-memory control plane with simulated runner (no API key),
 * manual scheduler ticks, and a disposable data dir under ./data/test-*.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb, migrate } from "../src/db/client.js";
import { ProjectService } from "../src/services/projects.js";
import { TaskService } from "../src/services/tasks.js";
import { FileService } from "../src/services/files.js";
import { GoalService } from "../src/services/goals.js";
import { InboxService } from "../src/services/inbox.js";
import { SessionService } from "../src/services/sessions.js";
import { ActivityService } from "../src/services/activity.js";
import { PushService } from "../src/services/push.js";
import { SecretService } from "../src/services/secrets.js";
import { SchedulerService, type Clock } from "../src/services/scheduler.js";
import { TriggerService } from "../src/services/triggers.js";
import { YamlSyncService } from "../src/yaml/sync.js";
import type { Services } from "../src/services/registry.js";
import { createApp } from "../src/api/app.js";
import type { Agent, Task } from "../src/domain/types.js";

export interface TestContext {
  config: ReturnType<typeof loadConfig>;
  services: Services;
  app: ReturnType<typeof createApp>;
  auth: { authorization: string };
  clock: MutableClock;
  cleanup(): void;
}

export class MutableClock implements Clock {
  private t = new Date("2026-01-01T00:00:00Z");
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export function makeContext(): TestContext {
  mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  const dir = mkdtempSync(path.join(process.cwd(), "data", "test-"));
  const config = loadConfig({
    AGENTOS_DATA_DIR: dir,
    AGENTOS_OPERATOR_TOKEN: "test-operator-token",
    AGENTOS_SECRET: "test-hmac-secret",
  });
  const db = openDb(":memory:");
  migrate(db);

  const clock = new MutableClock();
  const services: Services = {
    db,
    config,
    projects: new ProjectService(db),
    tasks: new TaskService(db),
    files: new FileService(db, config),
    goals: new GoalService(db),
    inbox: new InboxService(db),
    activity: new ActivityService(db),
    push: new PushService(db, config),
    secrets: new SecretService(db, config.secret),
    sessions: undefined as unknown as SessionService,
    scheduler: undefined as unknown as SchedulerService,
    triggers: undefined as unknown as TriggerService,
  };
  services.scheduler = new SchedulerService(db, services, clock, 50);
  services.sessions = new SessionService(db, config, services);
  services.triggers = new TriggerService(db, services);

  const app = createApp(config, services);
  const auth = { authorization: `Bearer ${config.operatorToken}` };
  return {
    config,
    services,
    app,
    auth,
    clock,
    cleanup() {
      services.scheduler.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function newProject(ctx: TestContext, name = "test-project"): Promise<{ id: string; slug: string }> {
  const p = await ctx.services.projects.create({ name });
  return { id: p.id, slug: p.slug };
}

export async function agentByName(ctx: TestContext, projectId: string, name: string): Promise<Agent> {
  const a = await ctx.services.db.query.agents.findFirst({
    where: (t, { and, eq }) => and(eq(t.projectId, projectId), eq(t.name, name)),
  });
  if (!a) throw new Error(`agent ${name} not found`);
  return a as unknown as Agent;
}

export async function createTask(
  ctx: TestContext,
  projectId: string,
  opts: Partial<Parameters<TaskService["create"]>[1]> & { name: string },
): Promise<Task> {
  return ctx.services.tasks.create(projectId, opts);
}

export async function runTaskAndWait(
  ctx: TestContext,
  taskId: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  for (;;) {
    const t = await ctx.services.tasks.get(taskId);
    if (t && t.status === "done") return;
    if (Date.now() > deadline) throw new Error(`task ${taskId} did not reach done (status=${t?.status})`);
    await sleep(25);
  }
}

export async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stage + run a session with an explicit script, returning the session row. */
export async function runScriptedSession(
  ctx: TestContext,
  opts: { projectId: string; agentId: string; taskId?: string; goalId?: string; script: any[] },
): Promise<{ session: any; outcome: any }> {
  const session = await ctx.services.sessions.request({
    projectId: opts.projectId,
    agentId: opts.agentId,
    taskId: opts.taskId ?? null,
    goalId: opts.goalId ?? null,
  });
  ctx.services.sessions.stageSession(session.id, { script: opts.script });
  const outcome = await ctx.services.sessions.start(session.id);
  return { session: await ctx.services.sessions.get(session.id), outcome };
}

/** Wait for the scheduler to dispatch a task and its session to finish. */
export async function tickUntilTaskDone(ctx: TestContext, taskId: string, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    await ctx.services.scheduler.tick();
    const t = await ctx.services.tasks.get(taskId);
    if (t?.status === "done") return;
    await sleep(20);
  }
  const t = await ctx.services.tasks.get(taskId);
  throw new Error(`task did not complete via scheduler (status=${t?.status})`);
}
