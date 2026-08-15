/**
 * Scheduler: fires scheduled/recurring tasks and named cron automations
 * (§15). Also releases follow-up chain steps. A `Clock` abstraction lets
 * tests advance time and force ticks deterministically.
 *
 * Cron format: `minute hour day-of-month month day-of-week` (5 fields).
 * Supports `*`, numbers, lists, ranges and step values (e.g. `*`/`5`)
 * (enough for the blueprint's examples: weekly, first-of-month).
 */
import { eq, and } from "drizzle-orm";
import { tasks, automations, agents, taskTemplates } from "../db/schema.js";
import type { DB } from "../db/client.js";
import type { Services } from "./registry.js";
import type { Task } from "../domain/types.js";

export interface Clock {
  now(): Date;
}

export class RealClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class SchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private cloudBusy = false;
  private dueMarked = new Set<string>(); // taskIds already dispatched (until status changes)

  constructor(
    private db: DB,
    private services: Services,
    private clock: Clock = new RealClock(),
    private intervalMs = 1000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((e) => {
        void this.services.activity.emit({
          projectId: null,
          type: "system",
          actor: "scheduler",
          message: `tick error: ${e instanceof Error ? e.message : e}`,
        });
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isCloudBusy(): boolean {
    return this.cloudBusy;
  }

  setCloudBusy(busy: boolean): void {
    this.cloudBusy = busy;
  }

  /** Force a scan (tests use this with a fake clock). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.dispatchDueTasks();
      await this.fireAutomations();
    } finally {
      this.ticking = false;
    }
  }

  private async dispatchDueTasks(): Promise<void> {
    const all = await this.db.select().from(tasks).all();
    const now = this.clock.now();
    for (const row of all) {
      const task: Task = { ...row, activity: row.activity ?? [], attachmentIds: row.attachmentIds ?? [], sessionIds: row.sessionIds ?? [] };
      // Recurring cron tasks: after an agent finishes one run, reset to todo
      // so the next cron match fires again (§9.2 recurring). Falls through to
      // the dispatch check below so a match on this same tick still fires.
      if (task.status === "done" && task.scheduleKind === "cron") {
        await this.db
          .update(tasks)
          .set({
            status: "todo",
            activity: [
              ...task.activity,
              { at: now.toISOString(), actor: "scheduler", message: "recurring task reset for next run" },
            ],
          })
          .where(eq(tasks.id, task.id))
          .run();
        task.status = "todo";
      }
      if (task.status !== "todo") {
        this.dueMarked.delete(task.id);
        continue;
      }
      if (task.assigneeType !== "agent" || !task.assigneeAgentId) continue;
      if (this.dueMarked.has(task.id)) continue;
      if (this.services.sessions.isTaskRunning(task.id)) continue;
      if (task.chainId && task.chainIndex !== null && task.chainIndex > 0) {
        // Chain: blocked until the previous step is done (§9.4).
        const prev = all
          .filter((t) => t.chainId === task.chainId && t.chainIndex === task.chainIndex! - 1)
          .sort((a, b) => (a.chainIndex ?? 0) - (b.chainIndex ?? 0))[0];
        if (!prev || prev.status !== "done") continue;
      }
      let due = false;
      if (task.scheduleKind === "now") due = true;
      else if (task.scheduleKind === "at" && task.runAt) due = now >= new Date(task.runAt);
      else if (task.scheduleKind === "cron" && task.cron && task.timezone) {
        due = cronMatches(task.cron, toTZ(now, task.timezone));
      }
      if (!due) continue;
      // Recurring cron tasks re-fire on every matching minute; one-shot
      // tasks are marked so they dispatch exactly once.
      if (task.scheduleKind !== "cron") this.dueMarked.add(task.id);
      try {
        await this.services.activity.emit({
          projectId: task.projectId,
          type: "task",
          actor: "scheduler",
          message: `dispatching task "${task.name}" to agent`,
          taskId: task.id,
        });
        const session = await this.services.sessions.request({
          projectId: task.projectId,
          agentId: task.assigneeAgentId,
          taskId: task.id,
        });
        void this.services.sessions.start(session.id).catch((e) => {
          void this.services.activity.emit({
            projectId: task.projectId,
            type: "task",
            actor: "scheduler",
            message: `session start failed: ${e instanceof Error ? e.message : e}`,
            taskId: task.id,
          });
        });
      } catch (e) {
        this.dueMarked.delete(task.id);
        void this.services.activity.emit({
          projectId: task.projectId,
          type: "task",
          actor: "scheduler",
          message: `dispatch failed: ${e instanceof Error ? e.message : e}`,
          taskId: task.id,
        });
      }
    }
  }

  private async fireAutomations(): Promise<void> {
    const all = await this.db.select().from(automations).all();
    const now = this.clock.now();
    // Per-automation last-fire tracking: keep in memory for the process
    // lifetime; a fresh boot may re-fire within the same minute, which is
    // acceptable for a single-operator system (documented).
    for (const a of all) {
      if (a.cron && cronMatches(a.cron, toTZ(now, a.timezone))) {
        const last = this.lastFires.get(a.id);
        const key = nowKey(now);
        if (last === key) continue;
        this.lastFires.set(a.id, key);
        try {
          await this.fireAutomation(a.id);
        } catch (e) {
          void this.services.activity.emit({
            projectId: a.projectId,
            type: "automation",
            actor: "scheduler",
            message: `automation "${a.name}" failed: ${e instanceof Error ? e.message : e}`,
          });
        }
      }
    }
  }

  private lastFires = new Map<string, string>();

  private async fireAutomation(automationId: string): Promise<void> {
    const a = await this.db.select().from(automations).where(eq(automations.id, automationId)).get();
    if (!a) return;
    const agent = await this.db.select().from(agents).where(eq(agents.id, a.agentId)).get();
    if (!agent) throw new Error(`automation agent missing: ${a.agentId}`);

    let task: Task;
    if (a.taskTemplateId) {
      const tpl = await this.db.select().from(taskTemplates).where(eq(taskTemplates.id, a.taskTemplateId)).get();
      if (!tpl) throw new Error(`automation template missing: ${a.taskTemplateId}`);
      const chain = await this.services.tasks.instantiateTemplate(a.projectId, tpl.id, {
        branchName: `auto-${a.id.slice(0, 8)}`,
        featureTitle: a.name,
      });
      task = chain[0]!;
    } else {
      task = await this.services.tasks.create(a.projectId, {
        name: a.name,
        description: a.taskBody ?? `Automation "${a.name}" fired at ${this.clock.now().toISOString()}`,
        assigneeAgentId: agent.id,
        scheduleKind: "now",
      });
    }
    await this.services.activity.emit({
      projectId: a.projectId,
      type: "automation",
      actor: "scheduler",
      message: `automation "${a.name}" fired → task "${task.name}"`,
      taskId: task.id,
    });
  }

  /** Re-scan a single task immediately (used after human marks gated step done). */
  async pokeTask(taskId: string): Promise<void> {
    this.dueMarked.delete(taskId);
    await this.tick();
  }
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

function toTZ(d: Date, tz: string): Date {
  // SQLite has no TZ tables; approximate with the offset if the tz is a
  // fixed-offset form, else treat as UTC. Labeled approximation.
  const m = /^UTC([+-]\d{1,2})(?::?(\d{2}))?$/.exec(tz);
  if (m) {
    const off = Number(m[1]) * 60 + Number(m[2] ?? 0) * (Number(m[1]) < 0 ? -1 : 1);
    return new Date(d.getTime() + off * 60_000);
  }
  return d;
}

function nowKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}-${d.getUTCMinutes()}`;
}

/** 5-field cron matcher. */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`invalid cron: ${expr}`);
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, i));
  const m = date.getUTCMinutes();
  const h = date.getUTCHours();
  const d = date.getUTCDate();
  const mo = date.getUTCMonth() + 1;
  const w = date.getUTCDay();
  return minute(m) && hour(h) && dom(d) && month(mo) && dow(w);
}

function parseField(field: string, index: number): (v: number) => boolean {
  const range: [number, number] =
    index === 0 ? [0, 59] : index === 1 ? [0, 23] : index === 2 ? [1, 31] : index === 3 ? [1, 12] : [0, 6];
  const [lo, hi] = range;
  const values = new Set<number>();
  for (const part of field.split(",")) {
    let step = 1;
    let body = part;
    const stepIdx = part.indexOf("/");
    if (stepIdx >= 0) {
      step = Number(part.slice(stepIdx + 1));
      body = part.slice(0, stepIdx);
    }
    const add = (from: number, to: number) => {
      for (let v = from; v <= to; v += step) values.add(v);
    };
    if (body === "*") add(lo, hi);
    else if (body.includes("-")) {
      const [a, b] = body.split("-").map(Number);
      add(Math.max(a, lo), Math.min(b, hi));
    } else {
      values.add(Number(body));
    }
  }
  return (v: number) => values.has(v);
}
