/**
 * Task service: Kanban cards, approval gates, follow-up chains, template
 * instantiation, scheduling fields (§9).
 */
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { tasks, taskTemplates, agents, files } from "../db/schema.js";
import type { DB } from "../db/client.js";
import type { Task, TaskStatus, TaskTemplate, TaskActivity } from "../domain/types.js";
import { HttpError } from "../api/errors.js";

export interface CreateTaskInput {
  name: string;
  description?: string;
  assigneeAgentId?: string | null;
  assigneeType?: "agent" | "human";
  attachmentIds?: string[];
  approvalGate?: boolean;
  scheduleKind?: "now" | "at" | "cron";
  runAt?: string | null;
  cron?: string | null;
  timezone?: string | null;
  templateId?: string | null;
  chainId?: string | null;
  chainIndex?: number | null;
  variables?: Record<string, string>;
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (m, key: string) => {
    const v = vars[key];
    return v !== undefined ? v : m;
  });
}

export class TaskService {
  constructor(private db: DB) {}

  async get(taskId: string): Promise<Task | null> {
    const row = await this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row) return null;
    return {
      ...row,
      activity: row.activity ?? [],
      attachmentIds: row.attachmentIds ?? [],
      sessionIds: row.sessionIds ?? [],
    };
  }

  async list(projectId: string): Promise<Task[]> {
    const rows = await this.db.select().from(tasks).where(eq(tasks.projectId, projectId)).all();
    return rows
      .map((r) => ({ ...r, activity: r.activity ?? [], attachmentIds: r.attachmentIds ?? [], sessionIds: r.sessionIds ?? [] }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(projectId: string, input: CreateTaskInput): Promise<Task> {
    const now = new Date().toISOString();
    const row: Task = {
      id: randomUUID(),
      projectId,
      name: input.name,
      description: input.description ?? "",
      status: "todo",
      assigneeType: input.assigneeType ?? "agent",
      assigneeAgentId: input.assigneeAgentId ?? null,
      attachmentIds: input.attachmentIds ?? [],
      approvalGate: input.approvalGate ?? false,
      chainId: input.chainId ?? null,
      chainIndex: input.chainIndex ?? null,
      scheduleKind: input.scheduleKind ?? "now",
      runAt: input.runAt ?? null,
      cron: input.cron ?? null,
      timezone: input.timezone ?? null,
      templateId: input.templateId ?? null,
      activity: [],
      sessionIds: [],
      createdAt: now,
    };
    await this.db.insert(tasks).values(row).run();
    return row;
  }

  /**
   * Status transition with approval-gate enforcement (§9.3).
   * `actor: "agent"` may never set `done` on a gated task; only the human
   * (actor "human") may. This is enforced here in the control plane, and
   * again inside the AgentOS MCP for session tokens.
   */
  async setStatus(
    taskId: string,
    status: TaskStatus,
    opts: { actor: "human" | "agent"; agentId?: string; sessionId?: string; note?: string },
  ): Promise<Task> {
    const task = await this.get(taskId);
    if (!task) throw new HttpError(404, "task not found");

    if (opts.actor === "agent") {
      if (task.approvalGate && status === "done") {
        throw new HttpError(403, "approval-gated task: only the human can mark this done");
      }
      if (task.assigneeAgentId && opts.agentId && task.assigneeAgentId !== opts.agentId) {
        throw new HttpError(403, "task is assigned to another agent");
      }
    }

    await this.db
      .update(tasks)
      .set({ status, activity: [...task.activity, {
        at: new Date().toISOString(),
        actor: opts.actor === "agent" ? opts.agentId ?? "agent" : "human",
        message: `status → ${status}${opts.note ? ` (${opts.note})` : ""}`,
      } satisfies TaskActivity] })
      .where(eq(tasks.id, taskId))
      .run();

    const updated = await this.get(taskId);
    if (!updated) throw new HttpError(500, "task lost after update");

    if (status === "done") {
      await this.enqueueNextInChain(updated.chainId, updated.chainIndex);
    }
    return updated;
  }

  async appendActivity(taskId: string, actor: string, message: string): Promise<Task> {
    const task = await this.get(taskId);
    if (!task) throw new HttpError(404, "task not found");
    const entry: TaskActivity = { at: new Date().toISOString(), actor, message };
    await this.db
      .update(tasks)
      .set({ activity: [...task.activity, entry] })
      .where(eq(tasks.id, taskId))
      .run();
    return { ...task, activity: [...task.activity, entry] };
  }

  async attachFile(taskId: string, fileId: string): Promise<Task> {
    const task = await this.get(taskId);
    if (!task) throw new HttpError(404, "task not found");
    const f = await this.db.select().from(files).where(eq(files.id, fileId)).get();
    if (!f) throw new HttpError(404, "file not found");
    if (f.projectId !== task.projectId) throw new HttpError(403, "file belongs to another project");
    if (task.attachmentIds.includes(fileId)) return task;
    const attachmentIds = [...task.attachmentIds, fileId];
    await this.db.update(tasks).set({ attachmentIds }).where(eq(tasks.id, taskId)).run();
    return { ...task, attachmentIds };
  }

  async addSession(taskId: string, sessionId: string): Promise<void> {
    const task = await this.get(taskId);
    if (!task) return;
    const sessionIds = [...task.sessionIds, sessionId];
    await this.db.update(tasks).set({ sessionIds }).where(eq(tasks.id, taskId)).run();
  }

  async getTemplate(templateId: string): Promise<TaskTemplate | null> {
    const row = await this.db.select().from(taskTemplates).where(eq(taskTemplates.id, templateId)).get();
    return row ?? null;
  }

  async listTemplates(projectId: string): Promise<TaskTemplate[]> {
    return this.db.select().from(taskTemplates).where(eq(taskTemplates.projectId, projectId)).all();
  }

  /** §10: instantiate a template → chain of tasks; step N+1 blocked until N done. */
  async instantiateTemplate(
    projectId: string,
    templateId: string,
    variables: Record<string, string> = {},
  ): Promise<Task[]> {
    const tpl = await this.getTemplate(templateId);
    if (!tpl) throw new HttpError(404, "template not found");
    if (tpl.projectId !== projectId) throw new HttpError(403, "template belongs to another project");

    const chainId = randomUUID();
    const created: Task[] = [];
    for (let i = 0; i < tpl.steps.length; i++) {
      const step = tpl.steps[i]!;
      const agent =
        step.agentName === "human"
          ? null
          : await this.db
              .select()
              .from(agents)
              .where(and(eq(agents.projectId, projectId), eq(agents.name, step.agentName)))
              .get();
      if (step.agentName !== "human" && !agent) {
        throw new HttpError(400, `template step "${step.name}" names unknown agent "${step.agentName}"`);
      }
      const task = await this.create(projectId, {
        name: step.name,
        description: interpolate(step.prompt, { ...variables, taskName: step.name }),
        assigneeAgentId: agent?.id ?? null,
        assigneeType: step.agentName === "human" ? "human" : "agent",
        approvalGate: step.approvalGate,
        scheduleKind: i === 0 ? "now" : "at", // later steps: released by chain scheduler
        runAt: null,
        templateId,
        chainId,
        chainIndex: i,
        variables,
      });
      created.push(task);
    }
    return created;
  }

  /** §9.4: completing step N enqueues step N+1 (unblocks it for the scheduler). */
  async enqueueNextInChain(chainId: string | null, chainIndex: number | null): Promise<void> {
    if (!chainId || chainIndex === null) return;
    const chain = await this.db.select().from(tasks).where(eq(tasks.chainId, chainId)).all();
    const next = chain
      .filter((t) => t.chainIndex === chainIndex + 1)
      .sort((a, b) => (a.chainIndex ?? 0) - (b.chainIndex ?? 0))[0];
    if (next) {
      await this.db
        .update(tasks)
        .set({
          scheduleKind: "now",
          runAt: null,
          activity: [
            ...(next.activity ?? []),
            {
              at: new Date().toISOString(),
              actor: "system",
              message: "previous chain step done — task released",
            } satisfies TaskActivity,
          ],
        })
        .where(eq(tasks.id, next.id))
        .run();
    }
  }

  /** Spawn a collaborator subtask (§5.10 enforced at MCP layer). */
  async spawnCollaborator(input: {
    projectId: string;
    agentId: string;
    agentName: string;
    brief: string;
    parentTaskId: string | null;
    parentSessionId: string;
  }): Promise<Task> {
    const task = await this.create(input.projectId, {
      name: `Collaborator: ${input.agentName}`,
      description: input.brief,
      assigneeAgentId: input.agentId,
      scheduleKind: "now",
    });
    await this.appendActivity(task.id, input.agentName, `spawned by ${input.agentName} (${input.parentSessionId})`);
    if (input.parentTaskId) {
      const parent = await this.get(input.parentTaskId);
      if (parent) {
        await this.appendActivity(
          parent.id,
          input.agentName,
          `spawned collaborator subtask ${task.name} (${task.id})`,
        );
      }
    }
    return task;
  }

  async delete(taskId: string): Promise<void> {
    await this.db.delete(tasks).where(eq(tasks.id, taskId)).run();
  }
}
