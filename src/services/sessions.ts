/**
 * Session service — the ephemeral session lifecycle (§6).
 *
 * requested → provision (container stand-in: fresh work dir + repo clones)
 * → inject env (secret store, listed keys only) → attach allowed MCPs
 * (servers built from the manifest) → run agent (tool calls streamed to the
 * live viewer) → waiting-inbox on questions (resume with the answer) →
 * commit if git-write granted → cleanup → destroy → status destroyed.
 * Failures still destroy. Nothing survives except git commits and R2-style
 * writes through the MCP.
 *
 * "Container" stand-in: each session gets its own `data/work/<sessionId>/`
 * directory which is deleted at the end — the same throwaway semantics.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { eq, and, or, inArray } from "drizzle-orm";
import { sessions, agents, skills, environments, repos as reposTable, secrets, mcpConnections } from "../db/schema.js";
import type { DB } from "../db/client.js";
import type { Config } from "../config.js";
import type {
  Session,
  SessionManifest,
  ToolCallLogEntry,
  InboxMessage,
  Task,
  RunnerKind,
} from "../domain/types.js";
import { buildSessionManifest, normalizePath } from "../acl/grants.js";
import type { McpRuntime } from "../mcp/context.js";
import { chooseRunner, type RunnerChoice } from "../runners/routing.js";
import { SimulatedRunner } from "../runners/simulated.js";
import { LocalVmRunner } from "../runners/local.js";
import type { RunnerHandle, SessionOutcome } from "../runners/types.js";
import { defaultScriptFor, type AgentScript } from "../runners/script.js";
import { HttpError } from "../api/errors.js";
import type { Services } from "./registry.js";

export interface SessionEvent {
  type: "status" | "tool_call" | "note";
  sessionId: string;
  at: string;
  data: unknown;
}

export interface RequestSessionInput {
  projectId: string;
  agentId: string;
  taskId?: string | null;
  goalId?: string | null;
  runner?: RunnerKind;
  script?: AgentScript;
  /** Force the simulated backend even for cloud preference (tests). */
  forceSimulated?: boolean;
}

/**
 * Redact credentials from text before it is persisted anywhere (activity
 * feed / DB). `git clone` failure messages echo the clone URL, which carries
 * the injected repo credential — a raw token must never reach the DB or UI.
 * Masks the exact credential value and, defensively, any https URL userinfo.
 */
export function redactUrlCredentials(text: string, credential?: string | null): string {
  let out = text;
  if (credential) out = out.split(credential).join("***");
  return out.replace(/(https?:\/\/)[^@\s/]+@/g, "$1***@");
}

export class SessionService {
  private live = new Map<string, Set<(e: SessionEvent) => void>>();
  private answerResolvers = new Map<
    string,
    { resolve: (a: { body?: string; selectedChoiceId?: string; label?: string } | null) => void }
  >();
  private running = new Map<string, RunnerHandle>();
  private activeSessions = new Set<string>();
  private activeTaskIds = new Set<string>();
  private lastAnswers = new Map<string, { body?: string; selectedChoiceId?: string; label?: string }>();

  constructor(
    private db: DB,
    private config: Config,
    private services: Services,
  ) {}

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async get(sessionId: string): Promise<Session | null> {
    const row = await this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!row) return null;
    return { ...row, toolCallLog: row.toolCallLog ?? [], commitShas: row.commitShas ?? [] };
  }

  async list(projectId?: string): Promise<Session[]> {
    const rows = projectId
      ? await this.db.select().from(sessions).where(eq(sessions.projectId, projectId)).all()
      : await this.db.select().from(sessions).all();
    return rows
      .map((r) => ({ ...r, toolCallLog: r.toolCallLog ?? [], commitShas: r.commitShas ?? [] }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  isRunning(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /** True while any session for this task is mid-flight. */
  isTaskRunning(taskId: string): boolean {
    return this.activeTaskIds.has(taskId);
  }

  subscribe(sessionId: string, cb: (e: SessionEvent) => void): () => void {
    let set = this.live.get(sessionId);
    if (!set) {
      set = new Set();
      this.live.set(sessionId, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  private emit(sessionId: string, type: SessionEvent["type"], data: unknown): void {
    const e: SessionEvent = { sessionId, type, at: new Date().toISOString(), data };
    for (const cb of this.live.get(sessionId) ?? []) cb(e);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Create the session row (status `requested`). No runtime yet. */
  async request(input: RequestSessionInput): Promise<Session> {
    const agent = await this.db.select().from(agents).where(eq(agents.id, input.agentId)).get();
    if (!agent) throw new HttpError(404, "agent not found");

    if (input.taskId) {
      const task = await this.services.tasks.get(input.taskId);
      if (!task) throw new HttpError(404, "task not found");
      if (task.assigneeAgentId && task.assigneeAgentId !== agent.id) {
        throw new HttpError(403, "task is assigned to another agent");
      }
    }
    if (input.goalId) {
      const goal = await this.services.goals.get(input.goalId);
      if (!goal) throw new HttpError(404, "goal not found");
      if (!goal.dodApproved) {
        throw new HttpError(409, "goal definition of done is not approved yet");
      }
    }

    const now = new Date().toISOString();
    const row: Session = {
      id: randomUUID(),
      projectId: input.projectId,
      agentId: agent.id,
      taskId: input.taskId ?? null,
      goalId: input.goalId ?? null,
      runner: input.runner ?? "cloud",
      status: "requested",
      runtimeHandle: null,
      toolCallLog: [],
      startedAt: now,
      endedAt: null,
      costUsd: null,
      commitShas: [],
      manifest: null,
      summary: null,
    };
    await this.db.insert(sessions).values(row).run();
    if (input.taskId) await this.services.tasks.addSession(input.taskId, row.id);
    if (input.goalId) await this.services.goals.addSession(input.goalId, row.id);
    return row;
  }

  /** Run the full lifecycle for a requested session. */
  async start(sessionId: string): Promise<SessionOutcome> {
    if (this.activeSessions.has(sessionId)) {
      throw new HttpError(409, "session already active");
    }
    this.activeSessions.add(sessionId);
    const s0 = await this.get(sessionId);
    if (s0?.taskId) this.activeTaskIds.add(s0.taskId);
    try {
      return await this.runLifecycle(sessionId);
    } finally {
      const s1 = await this.get(sessionId);
      if (s1?.taskId) this.activeTaskIds.delete(s1.taskId);
      this.activeSessions.delete(sessionId);
    }
  }

  private async runLifecycle(sessionId: string): Promise<SessionOutcome> {
    const session = await this.get(sessionId);
    if (!session) throw new HttpError(404, "session not found");
    const agent = await this.db.select().from(agents).where(eq(agents.id, session.agentId)).get();
    if (!agent) throw new HttpError(404, "agent not found");

    const task = session.taskId ? await this.services.tasks.get(session.taskId) : null;
    const goal = session.goalId ? await this.services.goals.get(session.goalId) : null;

    // --- Build the session manifest (the only envelope the agent gets) -------
    // Skills resolve by id OR slug: seeded projects store namespaced ids in
    // agent.skillIds while YAML-pushed projects store plain slugs (the DB row
    // id is a uuid there). All listed skills attach, in declared order.
    const skillRows = agent.skillIds.length
      ? await this.db
          .select()
          .from(skills)
          .where(
            and(
              eq(skills.projectId, session.projectId),
              or(inArray(skills.id, agent.skillIds), inArray(skills.slug, agent.skillIds)),
            ),
          )
          .all()
      : [];
    const skillByKey = new Map<string, (typeof skillRows)[number]>();
    for (const s of skillRows) {
      skillByKey.set(s.id, s);
      skillByKey.set(s.slug, s);
    }
    const orderedSkills = agent.skillIds
      .map((k) => skillByKey.get(k))
      .filter((s): s is (typeof skillRows)[number] => !!s);
    // MCP connections: the manifest names them (the agent-facing contract).
    const mcpNameById = new Map(
      (
        await this.db
          .select()
          .from(mcpConnections)
          .where(eq(mcpConnections.projectId, session.projectId))
          .all()
      ).map((m) => [m.id, m.name]),
    );
    const mcpConnectionNames = agent.mcpConnectionIds
      .map((id) => mcpNameById.get(id) ?? id)
      .filter((name) => ["agentos", "inbox", "r2-fs", "front", "github"].includes(name));
    const envRow = agent.environmentId
      ? await this.db.select().from(environments).where(eq(environments.id, agent.environmentId)).get()
      : null;
    const envNames = envRow?.envNames ?? [];
    const attachments = task?.attachmentIds.length
      ? (await Promise.all(task.attachmentIds.map((id) => this.services.files.getById(id)))).filter(
          (f): f is NonNullable<typeof f> => f !== null,
        )
      : [];

    const manifest: SessionManifest = buildSessionManifest({
      projectId: session.projectId,
      sessionId,
      agent,
      skills: orderedSkills,
      envNames,
      environment: envRow
        ? { networking: envRow.networking, allowedHosts: envRow.allowedHosts }
        : null,
      task: task
        ? {
            id: task.id,
            name: task.name,
            description: task.description,
            status: task.status,
            approvalGate: task.approvalGate,
            attachments,
          }
        : null,
      goal: goal
        ? {
            id: goal.id,
            title: goal.title,
            spec: goal.spec,
            definitionOfDone: goal.definitionOfDone.map((d) => d.text),
            progressLog: goal.progressLog,
          }
        : null,
      attachments,
      mcpConnectionNames,
    });

    // --- Runner routing (§16) -------------------------------------------------
    const forced = this.pendingRunners.get(sessionId);
    let choice: RunnerChoice = forced
      ? {
          kind: forced,
          runner: forced === "cloud" ? new SimulatedRunner() : new LocalVmRunner(),
          note: "runner forced for tests",
        }
      : chooseRunner({
          agentPreference: agent.runnerPreference,
          goalPreference: goal?.runnerPreference ?? null,
          cloudBusy: this.services.scheduler.isCloudBusy(),
          model: agent.model,
          anthropicApiKey: this.config.anthropicApiKey,
          deepseekApiKey: this.config.deepseekApiKey,
          deepseekBaseUrl: this.config.deepseekBaseUrl,
        });
    this.pendingRunners.delete(sessionId);

    // --- Env injection from the secret store (listed names only, §5.8) -------
    const env: Record<string, string> = {};
    if (envNames.length) {
      const refs = await this.db.select().from(secrets).where(eq(secrets.projectId, session.projectId)).all();
      for (const name of envNames) {
        const ref = refs.find((r) => r.name === name && r.purpose === "env");
        if (!ref) continue;
        const value = await this.services.secrets.getValue(ref.id);
        if (value !== null) env[name] = value;
      }
    }

    await this.db
      .update(sessions)
      .set({ status: "starting", runner: choice.kind, manifest })
      .where(eq(sessions.id, sessionId))
      .run();
    this.emit(sessionId, "status", { status: "starting", runner: choice.kind });
    await this.services.activity.emit({
      projectId: session.projectId,
      type: "session",
      actor: agent.name,
      message: `session started (${choice.kind}: ${choice.note})`,
      sessionId,
      taskId: task?.id ?? null,
      goalId: goal?.id ?? null,
    });

    // --- Provision: fresh work dir + repo clones (container stand-in) --------
    const workDir = path.join(this.config.workDir, sessionId);
    rmSync(workDir, { recursive: true, force: true });
    const mounts = await this.cloneRepos(session.projectId, workDir, manifest);

    // --- Runtime context ------------------------------------------------------
    const runtime: McpRuntime = this.makeRuntime(sessionId, manifest, task);

    // --- Script (deterministic engines only) ---------------------------------
    let script: AgentScript | undefined;
    if (choice.runner.kind === "simulated" || choice.runner.kind === "local") {
      script = this.pendingScripts.get(sessionId) ?? undefined;
      if (!script) {
        if (goal && this.goalScriptOverride) {
          script = this.goalScriptOverride;
        } else {
          const dodItem = goal?.definitionOfDone.find((d) => !d.done)?.text;
          script = defaultScriptFor(manifest, dodItem);
        }
      }
      this.pendingScripts.delete(sessionId);
    }

    const handle = await choice.runner.provision({
      sessionId,
      manifest,
      runtime,
      script,
      cwd: workDir,
    });
    this.running.set(sessionId, handle);
    await this.db
      .update(sessions)
      .set({ status: "running", runtimeHandle: `${choice.runner.kind}@${handle.runner}` })
      .where(eq(sessions.id, sessionId))
      .run();
    this.emit(sessionId, "status", { status: "running" });

    let outcome: SessionOutcome;
    try {
      outcome = await handle.done;
    } catch (err) {
      outcome = {
        status: "failed",
        summary: null,
        costUsd: null,
        commitShas: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // --- Commit step (git-write granted, work produced) -----------------------
    const commitShas: string[] = [];
    if (outcome.status === "ok") {
      for (const m of mounts) {
        if (m.permissions === "git-write") {
          try {
            const sha = this.commitRepo(m.dir);
            if (sha) commitShas.push(sha);
          } catch (err) {
            outcome = {
              ...outcome,
              status: "failed",
              error: `commit failed in ${m.mountPath}: ${err instanceof Error ? err.message : err}`,
            };
          }
        }
      }
    }
    outcome = { ...outcome, commitShas };

    // --- Cleanup + destroy (failures still destroy, §6) -----------------------
    try {
      await handle.destroy();
    } catch {
      /* ignore destroy errors */
    }
    this.running.delete(sessionId);
    rmSync(workDir, { recursive: true, force: true });
    this.answerResolvers.delete(sessionId);

    await this.db
      .update(sessions)
      .set({
        status: "destroyed",
        endedAt: new Date().toISOString(),
        costUsd: outcome.costUsd,
        commitShas,
        summary: outcome.summary ?? outcome.error,
      })
      .where(eq(sessions.id, sessionId))
      .run();
    this.emit(sessionId, "status", {
      status: "destroyed",
      outcome: { status: outcome.status, error: outcome.error, commitShas },
    });
    await this.services.activity.emit({
      projectId: session.projectId,
      type: "session",
      actor: agent.name,
      message:
        outcome.status === "ok"
          ? `session destroyed after success${commitShas.length ? ` (commits: ${commitShas.join(", ")})` : ""}`
          : `session failed: ${outcome.error}`,
      sessionId,
      taskId: task?.id ?? null,
      goalId: goal?.id ?? null,
    });

    // --- Post-session follow-ups ---------------------------------------------
    if (goal) {
      if (outcome.costUsd) await this.services.goals.addSpend(goal.id, outcome.costUsd);
      await this.orchestrateGoal(goal.id);
    }
    if (task && outcome.status === "ok" && task.status !== "done") {
      // Noop: agents mark status through the MCP. Just notify if done was set.
    }
    if (task) {
      const now = await this.services.tasks.get(task.id);
      if (now?.status === "done") {
        await this.services.push.notify("Task done", `${task.name} finished`, `/inbox`);
      }
    }

    return outcome;
  }

  private pendingScripts = new Map<string, AgentScript>();
  private pendingRunners = new Map<string, RunnerKind>();

  /** Attach an explicit script + runner override before start (tests). */
  stageSession(sessionId: string, opts: { script?: AgentScript; runner?: RunnerKind }): void {
    if (opts.script) this.pendingScripts.set(sessionId, opts.script);
    if (opts.runner) this.pendingRunners.set(sessionId, opts.runner);
  }

  /**
   * Override the default GOAL script for sessions without a staged one
   * (test seam: lets acceptance tests control orchestrator-spawned sessions).
   */
  private goalScriptOverride: AgentScript | null = null;
  setGoalScriptOverride(script: AgentScript | null): void {
    this.goalScriptOverride = script;
  }

  private makeRuntime(sessionId: string, manifest: SessionManifest, task: Task | null): McpRuntime {
    const self = this;
    let pendingAnswer: { body?: string; selectedChoiceId?: string; label?: string } | null = null;
    return {
      sessionId,
      manifest,
      services: this.services,
      async recordToolCall(entry: ToolCallLogEntry) {
        const s = await self.get(sessionId);
        if (!s) return;
        const toolCallLog = [...s.toolCallLog, entry].slice(-2000);
        await self.db.update(sessions).set({ toolCallLog }).where(eq(sessions.id, sessionId)).run();
        self.emit(sessionId, "tool_call", entry);
      },
      async onInboxQuestion(msg: InboxMessage) {
        await self.db
          .update(sessions)
          .set({ status: "waiting-inbox" })
          .where(eq(sessions.id, sessionId))
          .run();
        self.emit(sessionId, "status", { status: "waiting-inbox" });
        await self.services.activity.emit({
          projectId: manifest.projectId,
          type: "inbox",
          actor: manifest.agent.name,
          message: `asked the human: ${msg.body.slice(0, 120)}`,
          sessionId,
          taskId: manifest.task?.id ?? null,
          goalId: manifest.goal?.id ?? null,
        });
        await self.services.push.notify(
          "AgentOS needs you",
          `${manifest.agent.name}: ${msg.body.slice(0, 120)}`,
          "/inbox",
        );
      },
      async onInboxNote(msg: InboxMessage) {
        await self.services.activity.emit({
          projectId: manifest.projectId,
          type: "inbox",
          actor: manifest.agent.name,
          message: `messaged the human: ${msg.body.slice(0, 120)}`,
          sessionId,
          taskId: manifest.task?.id ?? null,
          goalId: manifest.goal?.id ?? null,
        });
        await self.services.push.notify(
          "AgentOS message",
          `${manifest.agent.name}: ${msg.body.slice(0, 120)}`,
          "/inbox",
        );
      },
      async spawnCollaborator(agentName: string, brief: string) {
        const collab = await self.services.db
          .select()
          .from(agents)
          .where(eq(agents.name, agentName))
          .get();
        if (!collab) throw new Error(`unknown collaborator agent "${agentName}"`);
        return self.services.tasks.spawnCollaborator({
          projectId: manifest.projectId,
          agentId: collab.id,
          agentName,
          brief,
          parentTaskId: manifest.task?.id ?? null,
          parentSessionId: sessionId,
        });
      },
      answer() {
        return pendingAnswer;
      },
      waitForAnswer() {
        return new Promise((resolve) => {
          self.answerResolvers.set(sessionId, { resolve });
        });
      },
      injectAnswer(answer) {
        pendingAnswer = answer;
        self.answerResolvers.get(sessionId)?.resolve(answer);
        self.answerResolvers.delete(sessionId);
      },
      cancelWait() {
        self.answerResolvers.get(sessionId)?.resolve(null);
        self.answerResolvers.delete(sessionId);
      },
    };
  }

  /** §12: human reply resumes the waiting session with the answer in context. */
  async resumeFromInbox(messageId: string, reply: { body?: string; selectedChoiceId?: string }): Promise<void> {
    const msg = await this.services.inbox.get(messageId);
    if (!msg) throw new HttpError(404, "message not found");
    const label = msg.choices.find((c) => c.id === reply.selectedChoiceId)?.label;
    const updated = await this.services.inbox.reply(messageId, reply);
    const sessionId = updated.sessionId;
    if (!sessionId) return;
    const session = await this.get(sessionId);
    if (!session) return;
    const handle = this.running.get(sessionId);
    if (handle && session.status === "waiting-inbox") {
      await handle.injectReply({ ...reply, label });
      await this.db.update(sessions).set({ status: "running" }).where(eq(sessions.id, sessionId)).run();
      this.emit(sessionId, "status", { status: "running", resumedWith: label ?? reply.body });
      await this.services.activity.emit({
        projectId: session.projectId,
        type: "inbox",
        actor: "human",
        message: `answered: ${label ?? reply.body}`,
        sessionId,
        taskId: session.taskId,
        goalId: session.goalId,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Git: clone at provision (fresh per session), commit at teardown (§6)
  // -------------------------------------------------------------------------

  private async cloneRepos(
    projectId: string,
    workDir: string,
    manifest: SessionManifest,
  ): Promise<{ mountPath: string; permissions: "git-read" | "git-write"; dir: string }[]> {
    const mounts: { mountPath: string; permissions: "git-read" | "git-write"; dir: string }[] = [];
    for (const grant of manifest.repos) {
      const repo = await this.db.select().from(reposTable).where(eq(reposTable.id, grant.repoId)).get();
      if (!repo) continue;
      let remote = repo.remoteUrl;
      let credential: string | null = null;
      if (repo.credentialSecretId) {
        credential = await this.services.secrets.getValue(repo.credentialSecretId);
        if (credential && /^https:\/\//.test(remote)) {
          remote = remote.replace(/^https:\/\//, `https://${credential}@`);
        }
      }
      const mountPath = normalizePath(grant.mountPath);
      if (!mountPath) {
        // An operator misconfiguration must not clone outside the per-session
        // work dir (the cleanup rmSync only covers that dir).
        await this.services.activity.emit({
          projectId,
          type: "session",
          actor: manifest.agent.name,
          message: `repo clone skipped for ${repo.name}: invalid mountPath ${grant.mountPath} (escape denied)`,
        });
        continue;
      }
      const dir = path.join(workDir, mountPath.replace(/^\//, ""));
      try {
        execFileSync("git", ["clone", "--depth", "1", "--branch", repo.defaultBranch, remote, dir], {
          stdio: "pipe",
          timeout: 60_000,
        });
        mounts.push({ mountPath: grant.mountPath, permissions: grant.permissions, dir });
      } catch (err) {
        // git echoes the clone URL (which carries the injected credential) in
        // its error message — redact before it is persisted to the activity
        // feed (§5.9: never store raw credentials).
        const raw = err instanceof Error ? err.message : String(err);
        await this.services.activity.emit({
          projectId,
          type: "session",
          actor: manifest.agent.name,
          message: `repo clone skipped/failed for ${repo.name}: ${redactUrlCredentials(raw, credential)}`,
        });
      }
    }
    return mounts;
  }

  private commitRepo(dir: string): string | null {
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
    const diff = execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: dir, stdio: "pipe" });
    void diff;
    const hasChanges = (() => {
      try {
        execFileSync("git", ["diff", "--cached", "--exit-code"], { cwd: dir, stdio: "pipe" });
        return false;
      } catch {
        return true;
      }
    })();
    if (!hasChanges) return null;
    execFileSync(
      "git",
      ["-c", "user.name=AgentOS", "-c", "user.email=agentos@local", "commit", "-m", "AgentOS session work"],
      { cwd: dir, stdio: "pipe" },
    );
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, stdio: "pipe" }).toString().trim();
  }

  // -------------------------------------------------------------------------
  // Goal orchestrator hook (§11.6)
  // -------------------------------------------------------------------------

  /** §11.3: after the human approves the DoD, the loop starts immediately. */
  async startGoalLoop(goalId: string): Promise<void> {
    const goal = await this.services.goals.get(goalId);
    if (!goal) throw new HttpError(404, "goal not found");
    if (!goal.dodApproved) throw new HttpError(409, "definition of done is not approved yet");
    if (goal.status !== "active") throw new HttpError(409, `goal is ${goal.status}`);
    const projectAgents = await this.services.db
      .select()
      .from(agents)
      .where(eq(agents.projectId, goal.projectId))
      .all();
    const allowList = projectAgents
      .filter((a) => a.name !== "customer-support" && a.name !== "linkedin-content")
      .map((a) => ({ id: a.id, name: a.name }));
    const decision = await this.services.goals.orchestrate(goalId, { allowList });
    if (decision.action === "continue" && decision.nextAgentId) {
      const session = await this.request({
        projectId: goal.projectId,
        agentId: decision.nextAgentId,
        goalId,
      });
      void this.start(session.id).catch((err) => {
        void this.services.activity.emit({
          projectId: goal.projectId,
          type: "goal",
          actor: "orchestrator",
          message: `goal session failed to start: ${err instanceof Error ? err.message : err}`,
          goalId,
        });
      });
    }
  }

  private async orchestrateGoal(goalId: string): Promise<void> {
    const goal = await this.services.goals.get(goalId);
    if (!goal) return;
    const projectAgents = await this.services.db.select().from(agents).where(eq(agents.projectId, goal.projectId)).all();
    const allowList = projectAgents
      .filter((a) => a.name !== "customer-support" && a.name !== "linkedin-content")
      .map((a) => ({ id: a.id, name: a.name }));
    const decision = await this.services.goals.orchestrate(goalId, { allowList });
    await this.services.activity.emit({
      projectId: goal.projectId,
      type: "goal",
      actor: "orchestrator",
      message: `orchestrator: ${decision.action} — ${decision.summary}`,
      goalId,
    });
    if (decision.action === "continue" && decision.nextAgentId) {
      const session = await this.request({
        projectId: goal.projectId,
        agentId: decision.nextAgentId,
        goalId,
      });
      // Continue the loop after the current async stack unwinds.
      setImmediate(() => {
        this.start(session.id).catch((err) => {
          void this.services.activity.emit({
            projectId: goal.projectId,
            type: "goal",
            actor: "orchestrator",
            message: `goal session failed to start: ${err instanceof Error ? err.message : err}`,
            goalId,
          });
        });
      });
    }
  }

  /** Live-viewer backfill: tool log for a finished session. */
  async toolLog(sessionId: string): Promise<ToolCallLogEntry[]> {
    const s = await this.get(sessionId);
    return s?.toolCallLog ?? [];
  }
}
