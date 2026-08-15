/**
 * AgentOS control-plane API (§20). Single operator; session cookie for the
 * UI, bearer for the CLI. The public webhook receiver lives here too.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { agents, environments, skills, mcpConnections, repos as reposTable, secrets, taskTemplates, triggers as triggersTable, automations, projects } from "../db/schema.js";
import type { Config } from "../config.js";
import type { Services } from "../services/registry.js";
import { HttpError } from "./errors.js";
import { authMiddleware, clearSessionCookie, requireOperator, setSessionCookie } from "./auth.js";
import { safeEqual } from "../config.js";
import {
  taskCreateSchema,
  goalCreateSchema,
  triggerCreateSchema,
  automationCreateSchema,
  agentUpdateSchema,
  skillCreateSchema,
  secretRefSchema,
  repoSchema,
  environmentSchema,
  mcpConnectionSchema,
  TaskStatus,
} from "../domain/types.js";

export function createApp(config: Config, services: Services): Hono {
  const app = new Hono();
  const { db, tasks, files, goals, inbox, sessions, activity, push, secrets: secretSvc, scheduler, triggers } = services;

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------
  app.get("/api/health", (c) => c.json({ ok: true, version: "0.1.0" }));
  app.post("/api/login", async (c) => {
    const { token } = z.object({ token: z.string() }).parse(await c.req.json().catch(() => ({})));
    if (!safeEqual(token, config.operatorToken)) {
      throw new HttpError(401, "invalid operator token");
    }
    setSessionCookie(c, config);
    return c.json({ ok: true });
  });
  app.post("/api/logout", async (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true });
  });
  app.get("/api/push/vapid", (c) =>
    c.json({ publicKey: config.vapid.publicKey, subject: config.vapid.subject }),
  );

  /** §14: public webhook receiver. HMAC-SHA256 of the raw body. */
  app.post("/hooks/:triggerId", async (c) => {
    const triggerId = c.req.param("triggerId");
    const rawBody = await c.req.text();
    const signature = c.req.header("x-agentos-signature") ?? c.req.header("x-webhook-signature");
    const secret = await triggers.getSecret(triggerId).catch(() => null);
    if (!secret || !triggers.verify(secret, rawBody, signature)) {
      return c.json({ error: "invalid signature" }, 401);
    }
    let payload: unknown;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      payload = rawBody;
    }
    const task = await triggers.fire(triggerId, rawBody, payload);
    return c.json({ ok: true, taskId: task.id }, 201);
  });

  // -------------------------------------------------------------------------
  // Operator auth from here on
  // -------------------------------------------------------------------------
  app.use("/api/*", authMiddleware(config));
  app.use("/internal/*", authMiddleware(config));

  app.get("/api/me", (c) => c.json({ operator: true }));

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  app.post("/api/projects", async (c) => {
    const body = z.object({ name: z.string().min(1), slug: z.string().optional() }).parse(await c.req.json());
    const p = await services.projects.create(body);
    await activity.emit({ projectId: p.id, type: "system", actor: "operator", message: `project "${p.name}" created` });
    return c.json(p, 201);
  });
  app.get("/api/projects", async (c) => c.json(await services.projects.list()));
  app.get("/api/projects/:id", async (c) => {
    const p = await services.projects.get(c.req.param("id"));
    if (!p) throw new HttpError(404, "project not found");
    return c.json(p);
  });
  app.put("/api/projects/:id/yaml", async (c) => {
    const { yaml } = z.object({ yaml: z.string() }).parse(await c.req.json());
    await services.projects.setYaml(c.req.param("id"), yaml);
    return c.json({ ok: true });
  });
  app.get("/api/projects/:id/yaml", async (c) => {
    const p = await services.projects.get(c.req.param("id"));
    if (!p) throw new HttpError(404, "project not found");
    return c.json({ yaml: p.yaml ?? "" });
  });

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------
  app.get("/api/projects/:id/agents", async (c) => {
    const rows = await db.select().from(agents).where(eq(agents.projectId, c.req.param("id"))).all();
    return c.json(rows);
  });
  app.post("/api/projects/:id/agents", async (c) => {
    const projectId = c.req.param("id");
    const body = agentUpdateSchema.omit({ name: true }).extend({ name: z.string() }).parse(await c.req.json());
    const id = crypto.randomUUID();
    await db
      .insert(agents)
      .values({
        id,
        projectId,
        name: body.name,
        title: body.title ?? body.name,
        model: body.model ?? "claude-opus-4",
        foundationalPrompt: body.foundationalPrompt ?? "",
        rolePrompt: body.rolePrompt ?? "",
        skillIds: body.skillIds ?? [],
        mcpConnectionIds: body.mcpConnectionIds ?? [],
        repoAccess: body.repoAccess ?? [],
        filesystemGrants: body.filesystemGrants ?? [],
        collaborationList: body.collaborationList ?? [],
        environmentId: body.environmentId ?? null,
        runnerPreference: body.runnerPreference ?? "inherit",
        inboxAccess: body.inboxAccess ?? false,
        createdAt: new Date().toISOString(),
      })
      .run();
    const row = await db.select().from(agents).where(eq(agents.id, id)).get();
    return c.json(row, 201);
  });
  app.put("/api/projects/:id/agents/:name", async (c) => {
    const projectId = c.req.param("id");
    const name = c.req.param("name");
    const body = agentUpdateSchema.parse(await c.req.json());
    const existing = await db.select().from(agents).where(eq(agents.name, name)).get();
    if (!existing || existing.projectId !== projectId) throw new HttpError(404, "agent not found");
    await db
      .update(agents)
      .set({
        ...(body.title !== undefined && { title: body.title }),
        ...(body.model !== undefined && { model: body.model }),
        ...(body.rolePrompt !== undefined && { rolePrompt: body.rolePrompt }),
        ...(body.foundationalPrompt !== undefined && { foundationalPrompt: body.foundationalPrompt }),
        ...(body.skillIds !== undefined && { skillIds: body.skillIds }),
        ...(body.mcpConnectionIds !== undefined && { mcpConnectionIds: body.mcpConnectionIds }),
        ...(body.repoAccess !== undefined && { repoAccess: body.repoAccess }),
        ...(body.filesystemGrants !== undefined && { filesystemGrants: body.filesystemGrants }),
        ...(body.collaborationList !== undefined && { collaborationList: body.collaborationList }),
        ...(body.environmentId !== undefined && { environmentId: body.environmentId }),
        ...(body.runnerPreference !== undefined && { runnerPreference: body.runnerPreference }),
        ...(body.inboxAccess !== undefined && { inboxAccess: body.inboxAccess }),
      })
      .where(eq(agents.id, existing.id))
      .run();
    const row = await db.select().from(agents).where(eq(agents.id, existing.id)).get();
    return c.json(row);
  });

  // -------------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------------
  app.get("/api/projects/:id/skills", async (c) => {
    const rows = await db.select().from(skills).where(eq(skills.projectId, c.req.param("id"))).all();
    return c.json(rows);
  });
  app.post("/api/projects/:id/skills", async (c) => {
    const projectId = c.req.param("id");
    const body = skillCreateSchema.parse(await c.req.json());
    const id = crypto.randomUUID();
    await db.insert(skills).values({ id, projectId, ...body }).run();
    const row = await db.select().from(skills).where(eq(skills.id, id)).get();
    return c.json(row, 201);
  });

  // -------------------------------------------------------------------------
  // MCP connections / repos / environments / secrets
  // -------------------------------------------------------------------------
  app.get("/api/projects/:id/mcps", async (c) => {
    const rows = await db.select().from(mcpConnections).where(eq(mcpConnections.projectId, c.req.param("id"))).all();
    return c.json(rows);
  });
  app.post("/api/projects/:id/mcps", async (c) => {
    const projectId = c.req.param("id");
    const body = mcpConnectionSchema.omit({ id: true, projectId: true }).parse(await c.req.json());
    const id = crypto.randomUUID();
    await db.insert(mcpConnections).values({ id, projectId, ...body }).run();
    return c.json({ id, projectId, ...body }, 201);
  });
  app.get("/api/projects/:id/repos", async (c) => {
    const rows = await db.select().from(reposTable).where(eq(reposTable.projectId, c.req.param("id"))).all();
    return c.json(rows);
  });
  app.post("/api/projects/:id/repos", async (c) => {
    const projectId = c.req.param("id");
    const body = repoSchema.omit({ id: true, projectId: true }).parse(await c.req.json());
    const id = crypto.randomUUID();
    await db.insert(reposTable).values({ id, projectId, ...body }).run();
    return c.json({ id, projectId, ...body }, 201);
  });
  app.get("/api/projects/:id/environments", async (c) => {
    const rows = await db.select().from(environments).where(eq(environments.projectId, c.req.param("id"))).all();
    return c.json(rows);
  });
  app.post("/api/projects/:id/environments", async (c) => {
    const projectId = c.req.param("id");
    const body = environmentSchema.omit({ id: true, projectId: true }).parse(await c.req.json());
    const id = crypto.randomUUID();
    await db.insert(environments).values({ id, projectId, ...body }).run();
    return c.json({ id, projectId, ...body }, 201);
  });
  app.get("/api/projects/:id/secrets", async (c) => c.json(await secretSvc.list(c.req.param("id"))));
  app.post("/api/projects/:id/secrets", async (c) => {
    const projectId = c.req.param("id");
    const body = secretRefSchema.omit({ id: true, projectId: true, providerRef: true }).parse(await c.req.json());
    const ref = await secretSvc.createRef(projectId, body.name, body.purpose, body.value as string | undefined);
    return c.json(ref, 201);
  });
  app.delete("/api/projects/:id/secrets/:secretId", async (c) => {
    await secretSvc.delete(c.req.param("secretId"));
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Files (R2 stand-in browser, §7/§18.3)
  // -------------------------------------------------------------------------
  app.get("/api/projects/:id/files", async (c) => {
    const path = c.req.query("path") ?? "/";
    const entries = await files.list(c.req.param("id"), path);
    return c.json({ path, entries });
  });
  app.get("/api/projects/:id/files/content", async (c) => {
    const path = c.req.query("path");
    if (!path) throw new HttpError(400, "path query required");
    const { file, content } = await files.read(c.req.param("id"), path);
    const isText = /^(text\/|application\/(json|yaml|xml|javascript|typescript)|image\/svg)/.test(file.mime);
    return c.json({ path: file.path, mime: file.mime, size: file.size, text: isText ? content.toString("utf8") : null, base64: !isText ? content.toString("base64") : null });
  });
  app.put("/api/projects/:id/files/content", async (c) => {
    const projectId = c.req.param("id");
    const body = z.object({ path: z.string(), content: z.string(), mime: z.string().optional() }).parse(await c.req.json());
    const f = await files.write(projectId, body.path, body.content, body.mime);
    return c.json(f, 201);
  });
  app.delete("/api/projects/:id/files/content", async (c) => {
    const path = c.req.query("path");
    if (!path) throw new HttpError(400, "path query required");
    await files.delete(c.req.param("id"), path);
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Tasks / templates (§9/§10)
  // -------------------------------------------------------------------------
  app.get("/api/projects/:id/tasks", async (c) => c.json(await tasks.list(c.req.param("id"))));
  app.get("/api/projects/:id/tasks/:taskId", async (c) => {
    const t = await tasks.get(c.req.param("taskId"));
    if (!t) throw new HttpError(404, "task not found");
    return c.json(t);
  });
  app.post("/api/projects/:id/tasks", async (c) => {
    const projectId = c.req.param("id");
    const body = taskCreateSchema.parse(await c.req.json());
    const t = await tasks.create(projectId, body);
    await activity.emit({ projectId, type: "task", actor: "operator", message: `task "${t.name}" created`, taskId: t.id });
    return c.json(t, 201);
  });
  /** Human status change. Agents CANNOT do this — the MCP path enforces gates. */
  app.patch("/api/projects/:id/tasks/:taskId", async (c) => {
    const body = z.object({ status: TaskStatus, note: z.string().optional() }).parse(await c.req.json());
    const t = await tasks.setStatus(c.req.param("taskId"), body.status, { actor: "human", note: body.note });
    await activity.emit({ projectId: t.projectId, type: "task", actor: "human", message: `task "${t.name}" → ${t.status}`, taskId: t.id });
    return c.json(t);
  });
  app.post("/api/projects/:id/tasks/:taskId/run", async (c) => {
    const t = await tasks.get(c.req.param("taskId"));
    if (!t) throw new HttpError(404, "task not found");
    if (!t.assigneeAgentId) throw new HttpError(400, "task has no agent assignee");
    const session = await sessions.request({ projectId: t.projectId, agentId: t.assigneeAgentId, taskId: t.id });
    void sessions.start(session.id).catch((e) => {
      void activity.emit({ projectId: t.projectId, type: "task", actor: "operator", message: `run failed: ${e instanceof Error ? e.message : e}`, taskId: t.id });
    });
    return c.json({ ok: true, sessionId: session.id }, 202);
  });
  app.get("/api/projects/:id/templates", async (c) => c.json(await tasks.listTemplates(c.req.param("id"))));
  app.post("/api/projects/:id/templates/:templateId/instantiate", async (c) => {
    const projectId = c.req.param("id");
    const body = z.object({ variables: z.record(z.string(), z.string()).default({}) }).parse(await c.req.json());
    const chain = await tasks.instantiateTemplate(projectId, c.req.param("templateId"), body.variables);
    await activity.emit({ projectId, type: "task", actor: "operator", message: `template instantiated → ${chain.length} tasks` });
    return c.json(chain, 201);
  });

  // -------------------------------------------------------------------------
  // Goals (§11)
  // -------------------------------------------------------------------------
  app.get("/api/projects/:id/goals", async (c) => c.json(await goals.list(c.req.param("id"))));
  app.get("/api/projects/:id/goals/:goalId", async (c) => {
    const g = await goals.get(c.req.param("goalId"));
    if (!g) throw new HttpError(404, "goal not found");
    return c.json(g);
  });
  app.post("/api/projects/:id/goals", async (c) => {
    const projectId = c.req.param("id");
    const body = goalCreateSchema.parse(await c.req.json());
    if (body.spendCapUsd === null || body.spendCapUsd === undefined) {
      // §11: a goal without a spend cap requires explicit human confirmation.
      const { confirmNoCap } = z.object({ confirmNoCap: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({ confirmNoCap: false })));
      if (!confirmNoCap) {
        throw new HttpError(400, "a spend cap is required (or pass confirmNoCap: true to run uncapped)");
      }
    }
    const g = await goals.create({ projectId, ...body });
    await activity.emit({ projectId, type: "goal", actor: "operator", message: `goal "${g.title}" created (${g.definitionOfDone.length} DoD items)`, goalId: g.id });
    return c.json(g, 201);
  });
  app.post("/api/projects/:id/goals/:goalId/approve-dod", async (c) => {
    const g = await goals.approveDoD(c.req.param("goalId"));
    await activity.emit({ projectId: g.projectId, type: "goal", actor: "human", message: `DoD approved for "${g.title}" — loop starting`, goalId: g.id });
    // §11.3: approval starts the loop (orchestrator spawns the first specialist).
    void sessions.startGoalLoop(g.id).catch((e) => {
      void activity.emit({
        projectId: g.projectId,
        type: "goal",
        actor: "orchestrator",
        message: `loop start failed: ${e instanceof Error ? e.message : e}`,
        goalId: g.id,
      });
    });
    return c.json(g);
  });
  app.post("/api/projects/:id/goals/:goalId/pause", async (c) => {
    const g = await goals.setStatus(c.req.param("goalId"), "paused");
    return c.json(g);
  });
  app.post("/api/projects/:id/goals/:goalId/resume", async (c) => {
    const g = await goals.setStatus(c.req.param("goalId"), "active");
    return c.json(g);
  });

  // -------------------------------------------------------------------------
  // Inbox (§12)
  // -------------------------------------------------------------------------
  app.get("/api/inbox", async (c) => c.json(await inbox.list()));
  app.post("/api/inbox/:id/reply", async (c) => {
    const body = z.object({ body: z.string().optional(), selectedChoiceId: z.string().optional() }).parse(await c.req.json());
    const msg = await inbox.get(c.req.param("id"));
    if (!msg) throw new HttpError(404, "message not found");
    await sessions.resumeFromInbox(msg.id, body);
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Sessions (§6/§13)
  // -------------------------------------------------------------------------
  app.get("/api/sessions", async (c) => c.json(await sessions.list(c.req.query("projectId") ?? undefined)));
  app.get("/api/sessions/:id", async (c) => {
    const s = await sessions.get(c.req.param("id"));
    if (!s) throw new HttpError(404, "session not found");
    return c.json(s);
  });
  /** §13 live viewer: SSE stream of tool calls + status changes. */
  app.get("/api/sessions/:id/live", async (c) => {
    const sessionId = c.req.param("id");
    const s = await sessions.get(sessionId);
    if (!s) throw new HttpError(404, "session not found");
    return streamSSE(c, async (stream) => {
      const unsub = sessions.subscribe(sessionId, (e) => {
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e.data) });
      });
      await stream.writeSSE({ event: "status", data: JSON.stringify({ status: s.status }) });
      stream.onAbort(() => unsub());
      while (true) {
        await stream.sleep(30_000);
        await stream.writeSSE({ event: "ping", data: "{}" });
      }
    });
  });

  // -------------------------------------------------------------------------
  // Activity feed (§13)
  // -------------------------------------------------------------------------
  app.get("/api/activity", async (c) => c.json(await activity.list()));

  // -------------------------------------------------------------------------
  // Triggers / automations (§14/§15)
  // -------------------------------------------------------------------------
  app.get("/api/projects/:id/triggers", async (c) => c.json(await triggers.list(c.req.param("id"))));
  app.post("/api/projects/:id/triggers", async (c) => {
    const projectId = c.req.param("id");
    const body = triggerCreateSchema.parse(await c.req.json());
    const t = await triggers.create({ projectId, ...body });
    return c.json(t, 201);
  });
  app.post("/api/projects/:id/triggers/:triggerId/rotate", async (c) => {
    const t = await triggers.rotateSecret(c.req.param("triggerId"));
    return c.json(t);
  });
  /** §14: human-approved bug report → fix chain (implement → plan → review → fix → E2E → merge). */
  app.post("/api/projects/:id/triggers/:triggerId/bugfix-chain", async (c) => {
    const projectId = c.req.param("id");
    const body = z
      .object({ branchName: z.string().min(1), featureTitle: z.string().min(1), context: z.string().optional() })
      .parse(await c.req.json());
    const chain = await triggers.startBugFixChain({ projectId, ...body });
    await activity.emit({ projectId, type: "trigger", actor: "human", message: `bug fix chain started (${chain.length} steps)` });
    return c.json(chain, 201);
  });
  app.get("/api/projects/:id/automations", async (c) => {
    const rows = await db.select().from(automations).where(eq(automations.projectId, c.req.param("id"))).all();
    return c.json(rows);
  });
  app.post("/api/projects/:id/automations", async (c) => {
    const projectId = c.req.param("id");
    const body = automationCreateSchema.parse(await c.req.json());
    const id = crypto.randomUUID();
    await db.insert(automations).values({ id, projectId, ...body }).run();
    return c.json({ id, projectId, ...body }, 201);
  });

  // -------------------------------------------------------------------------
  // Push subscriptions (PWA)
  // -------------------------------------------------------------------------
  app.post("/api/push/subscribe", async (c) => {
    const body = z.object({ endpoint: z.string(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).parse(await c.req.json());
    await push.subscribe(body.endpoint, body.keys);
    return c.json({ ok: true });
  });
  app.post("/api/push/unsubscribe", async (c) => {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(await c.req.json());
    await push.unsubscribe(endpoint);
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Admin / demo
  // -------------------------------------------------------------------------
  app.get("/api/admin/config", (c) =>
    c.json({
      localRunnerEnabled: config.localRunnerEnabled,
      hasApiKey: !!config.anthropicApiKey,
      hasDeepseekKey: !!config.deepseekApiKey,
      cloudBusy: scheduler.isCloudBusy(),
      port: config.port,
      publicUrl: config.publicUrl,
    }),
  );
  app.post("/api/admin/cloud-busy", async (c) => {
    const { busy } = z.object({ busy: z.boolean() }).parse(await c.req.json());
    scheduler.setCloudBusy(busy);
    return c.json({ ok: true });
  });
  app.post("/api/admin/scheduler/tick", async (c) => {
    await scheduler.tick();
    return c.json({ ok: true });
  });

  // Error handler
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, details: err.details }, err.status as 400);
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: "invalid input", details: err.issues }, 400);
    }
    console.error("[api]", err);
    return c.json({ error: err instanceof Error ? err.message : "internal error" }, 500);
  });

  return app;
}
