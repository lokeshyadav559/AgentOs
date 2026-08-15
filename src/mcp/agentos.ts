/**
 * AgentOS MCP — the control-plane tool set agents get (§4 "Built-in MCPs").
 * Read/write the current task, mark status (approval gates enforced), spawn
 * collaborators (collaboration list enforced), read goal context, append to
 * the goal progress log, read project metadata.
 */
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { agents, projects, goals as goalsTable, files } from "../db/schema.js";
import { createMcpServer, type McpRuntime } from "./context.js";
import type { McpServer } from "./context.js";
import { checkFsOp } from "../acl/grants.js";
import type { TaskStatus } from "../domain/types.js";

export function createAgentosMcpServer(): McpServer {
  return createMcpServer("agentos", [
    {
      name: "tasks.current",
      description: "Read the current task (or null when this session has no task).",
      inputSchema: z.object({}),
      handler: async (rt) => {
        if (!rt.manifest.task) return { task: null };
        const task = await rt.services.tasks.get(rt.manifest.task.id);
        if (!task) return { task: null };
        const attachments = await Promise.all(
          task.attachmentIds.map((id) => rt.services.files.getById(id)),
        );
        return {
          task: {
            id: task.id,
            name: task.name,
            description: task.description,
            status: task.status,
            approvalGate: task.approvalGate,
            activity: task.activity,
            attachments: attachments.filter(Boolean),
          },
        };
      },
    },
    {
      name: "tasks.append_activity",
      description:
        "Append a progress note to the current task's activity log. Use this as your running work plan: write the ordered steps and what 'done' means at the start, then keep it current and check items off as you go.",
      inputSchema: z.object({ message: z.string().min(1) }),
      handler: async (rt, { message }) => {
        const taskId = rt.manifest.task?.id;
        if (!taskId) throw new Error("this session has no task");
        const task = await rt.services.tasks.appendActivity(
          taskId,
          rt.manifest.agent.name,
          message,
        );
        return { ok: true, activity: task.activity };
      },
    },
    {
      name: "tasks.set_status",
      description:
        "Move the current task between todo/doing/review/done. Lifecycle: set 'doing' when you start, 'review' when your deliverable is ready for a human, 'done' only after your exit criteria are verified. 'done' is REFUSED when the task has an approval gate — only the human can mark those done; leave them in 'review' and inbox the human.",
      inputSchema: z.object({ status: z.enum(["todo", "doing", "review", "done"]) }),
      handler: async (rt, { status }) => {
        const taskId = rt.manifest.task?.id;
        if (!taskId) throw new Error("this session has no task");
        const task = await rt.services.tasks.setStatus(taskId, status as TaskStatus, {
          actor: "agent",
          agentId: rt.manifest.agent.id,
          sessionId: rt.sessionId,
        });
        return { ok: true, status: task.status, approvalGate: task.approvalGate };
      },
    },
    {
      name: "tasks.attach",
      description: "Attach a file (by virtual path) to the current task.",
      inputSchema: z.object({ filePath: z.string() }),
      handler: async (rt, { filePath }) => {
        const taskId = rt.manifest.task?.id;
        if (!taskId) throw new Error("this session has no task");
        // Attaching is a read of the file: enforce the agent's filesystem
        // ACL the same way fs.read does (§5.7 — least privilege everywhere).
        const fsOp = checkFsOp(rt.manifest.filesystemGrants, "read", filePath);
        if (!fsOp.ok) throw new Error(`attachment denied: ${fsOp.reason}`);
        const f = (
          await rt.services.db
            .select()
            .from(files)
            .where(and(eq(files.projectId, rt.manifest.projectId), eq(files.path, filePath)))
            .get()
        );
        if (!f) throw new Error(`file not found: ${filePath}`);
        const task = await rt.services.tasks.attachFile(taskId, f.id);
        return { ok: true, attachmentIds: task.attachmentIds };
      },
    },
    {
      name: "collaborators.spawn",
      description:
        "Spawn a collaborator subtask. Only agents on this agent's collaboration list may be spawned (§5.10). Give a tight brief: the artifact to produce, the deliverable you expect, and the exit criteria you will check — the collaborator has no other context.",
      inputSchema: z.object({ agentName: z.string(), brief: z.string().min(1) }),
      handler: async (rt, { agentName, brief }) => {
        const list = rt.manifest.collaborationList;
        if (!list.includes(agentName)) {
          throw new Error(
            `collaborator "${agentName}" is not on the collaboration list [${list.join(", ")}]`,
          );
        }
        const agent = await rt.services.db
          .select()
          .from(agents)
          .where(and(eq(agents.projectId, rt.manifest.projectId), eq(agents.name, agentName)))
          .get();
        if (!agent) throw new Error(`unknown agent "${agentName}"`);
        const task = await rt.services.tasks.spawnCollaborator({
          projectId: rt.manifest.projectId,
          agentId: agent.id,
          agentName,
          brief,
          parentTaskId: rt.manifest.task?.id ?? null,
          parentSessionId: rt.sessionId,
        });
        return { ok: true, taskId: task.id, name: task.name };
      },
    },
    {
      name: "goals.current",
      description: "Read the goal context (title, spec, definition of done) for this session.",
      inputSchema: z.object({}),
      handler: async (rt) => {
        if (!rt.manifest.goal) return { goal: null };
        const g = await rt.services.goals.get(rt.manifest.goal.id);
        if (!g) return { goal: null };
        return {
          goal: {
            id: g.id,
            title: g.title,
            spec: g.spec,
            definitionOfDone: g.definitionOfDone,
            progressLog: g.progressLog,
          },
        };
      },
    },
    {
      name: "goals.append_progress",
      description:
        "Append an entry to the goal's append-only progress log (a human-readable trail of what happened). Marking a definition-of-done item done is separate — use goals.complete_dod_item once the item is actually verified.",
      inputSchema: z.object({ entry: z.string().min(1) }),
      handler: async (rt, { entry }) => {
        if (!rt.manifest.goal) throw new Error("this session has no goal");
        const g = await rt.services.goals.appendProgress(rt.manifest.goal.id, entry);
        return { ok: true, progressLog: g.progressLog };
      },
    },
    {
      name: "goals.complete_dod_item",
      description:
        "Mark ONE definition-of-done item as satisfied after you have actually finished AND verified it. This is the only way an item becomes done — the orchestrator never infers completion from progress-log text. Pass the item text exactly as listed. The goal completes only when every item is marked this way.",
      inputSchema: z.object({ item: z.string().min(1) }),
      handler: async (rt, { item }) => {
        if (!rt.manifest.goal) throw new Error("this session has no goal");
        const g = await rt.services.goals.completeDoDItem(rt.manifest.goal.id, item);
        return { ok: true, definitionOfDone: g.definitionOfDone };
      },
    },
    {
      name: "projects.meta",
      description: "Read project metadata (name, slug). Never contains secrets.",
      inputSchema: z.object({}),
      handler: async (rt) => {
        const p = await rt.services.db
          .select()
          .from(projects)
          .where(eq(projects.id, rt.manifest.projectId))
          .get();
        if (!p) throw new Error("project not found");
        return { project: { id: p.id, name: p.name, slug: p.slug } };
      },
    },
  ]);
}
