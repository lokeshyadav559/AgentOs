/**
 * Triggers (§14): inbound webhooks spawn a scoped job for a scoped agent.
 * Each trigger has a public URL + webhook secret; the signature is verified
 * with HMAC-SHA256 over the raw body. The payload is sanitized (truncated,
 * headers/secrets never dumped) before interpolation into the job prompt.
 */
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { triggers, agents, secrets, taskTemplates } from "../db/schema.js";
import type { DB } from "../db/client.js";
import { hmac, safeEqual } from "../config.js";
import { HttpError } from "../api/errors.js";
import { interpolate } from "./tasks.js";
import type { Services } from "./registry.js";
import type { Trigger, Task } from "../domain/types.js";

export class TriggerService {
  constructor(
    private db: DB,
    private services: Services,
  ) {}

  async create(input: {
    projectId: string;
    name: string;
    agentId: string;
    jobPrompt?: string;
  }): Promise<Trigger> {
    const agent = await this.db.select().from(agents).where(eq(agents.id, input.agentId)).get();
    if (!agent) throw new HttpError(404, "agent not found");
    const id = randomUUID();
    const secret = randomUUID().replace(/-/g, "");
    const secretRef = await this.services.secrets.createRef(
      input.projectId,
      `webhook:${input.name}`,
      "webhook",
      secret,
    );
    const row: Trigger = {
      id,
      projectId: input.projectId,
      name: input.name,
      webhookSecretId: secretRef.id,
      webhookSecret: secret,
      agentId: input.agentId,
      jobPrompt: input.jobPrompt ?? "New inbound event:\n{{payload}}",
    };
    await this.db
      .insert(triggers)
      .values({
        id,
        projectId: input.projectId,
        name: input.name,
        webhookSecretId: secretRef.id,
        webhookSecretEnc: this.services.secrets.encrypt(secret),
        agentId: input.agentId,
        jobPrompt: row.jobPrompt,
      })
      .run();
    return row;
  }

  async list(projectId: string): Promise<Trigger[]> {
    const rows = await this.db.select().from(triggers).where(eq(triggers.projectId, projectId)).all();
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      webhookSecretId: r.webhookSecretId,
      webhookSecret: r.webhookSecretEnc ? this.services.secrets.decrypt(r.webhookSecretEnc) : null,
      agentId: r.agentId,
      jobPrompt: r.jobPrompt,
    }));
  }

  /** Rotate the webhook secret. */
  async rotateSecret(triggerId: string): Promise<Trigger> {
    const t = await this.db.select().from(triggers).where(eq(triggers.id, triggerId)).get();
    if (!t) throw new HttpError(404, "trigger not found");
    const secret = randomUUID().replace(/-/g, "");
    await this.db
      .update(triggers)
      .set({ webhookSecretEnc: this.services.secrets.encrypt(secret) })
      .where(eq(triggers.id, triggerId))
      .run();
    if (t.webhookSecretId) await this.services.secrets.setValue(t.webhookSecretId, secret);
    return { ...t, webhookSecret: secret } as Trigger;
  }

  async getSecret(triggerId: string): Promise<string> {
    const t = await this.db.select().from(triggers).where(eq(triggers.id, triggerId)).get();
    if (!t || !t.webhookSecretEnc) throw new HttpError(404, "trigger not found");
    return this.services.secrets.decrypt(t.webhookSecretEnc);
  }

  /** Verify `x-agentos-signature` (HMAC-SHA256 hex of the raw body). */
  verify(secret: string, rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = hmac(secret, rawBody);
    return safeEqual(expected, signature);
  }

  /** §14: valid webhook → sanitized task + immediate session for the agent. */
  async fire(triggerId: string, rawBody: string, payload: unknown): Promise<Task> {
    const t = await this.db.select().from(triggers).where(eq(triggers.id, triggerId)).get();
    if (!t) throw new HttpError(404, "trigger not found");
    const agent = await this.db.select().from(agents).where(eq(agents.id, t.agentId)).get();
    if (!agent) throw new HttpError(404, "trigger agent not found");

    const sanitized = sanitizePayload(payload);
    const description = interpolate(t.jobPrompt, {
      payload: sanitized,
      eventId: randomUUID().slice(0, 8),
    });

    const task = await this.services.tasks.create(t.projectId, {
      name: `${t.name} · ${new Date().toISOString().slice(11, 19)}`,
      description,
      assigneeAgentId: agent.id,
      scheduleKind: "now",
    });
    await this.services.activity.emit({
      projectId: t.projectId,
      type: "trigger",
      actor: t.name,
      message: `webhook fired → task "${task.name}" (${agent.name})`,
      taskId: task.id,
    });
    const session = await this.services.sessions.request({
      projectId: t.projectId,
      agentId: agent.id,
      taskId: task.id,
    });
    void this.services.sessions.start(session.id).catch((e) => {
      void this.services.activity.emit({
        projectId: t.projectId,
        type: "trigger",
        actor: t.name,
        message: `trigger session start failed: ${e instanceof Error ? e.message : e}`,
        taskId: task.id,
      });
    });
    return task;
  }

  /**
   * §10/§14: after the human approves a diagnostic report, start the fix
   * chain: implement → plan → plan review → fix → E2E → human merge.
   * Reuses the same agents; not a second product.
   */
  async startBugFixChain(input: {
    projectId: string;
    branchName: string;
    featureTitle: string;
    context?: string;
  }): Promise<Task[]> {
    const tpl = (
      await this.services.db
        .select()
        .from(taskTemplates)
        .where(
          and(
            eq(taskTemplates.projectId, input.projectId),
            eq(taskTemplates.name, "bugfix-chain"),
          ),
        )
        .get()
    );
    if (!tpl) throw new HttpError(400, "bugfix-chain template not seeded for this project");
    return this.services.tasks.instantiateTemplate(input.projectId, tpl.id, {
      branchName: input.branchName,
      featureTitle: input.featureTitle,
      bugContext: input.context ?? "",
    });
  }
}

/** Sanitize a webhook payload for the prompt: truncate, drop header-ish keys. */
function sanitizePayload(payload: unknown, depth = 0): string {
  if (depth > 4) return "[truncated]";
  if (typeof payload === "string") return payload.length > 4000 ? payload.slice(0, 4000) + "…" : payload;
  if (Array.isArray(payload)) return `[${payload.map((p) => sanitizePayload(p, depth + 1)).join(", ")}]`;
  if (payload && typeof payload === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      if (/(secret|token|authorization|password|key|signature|header)/.test(lk)) continue;
      out[k] = sanitizePayload(v, depth + 1);
    }
    const json = JSON.stringify(out);
    return json.length > 4000 ? json.slice(0, 4000) + "…" : json;
  }
  return String(payload);
}
