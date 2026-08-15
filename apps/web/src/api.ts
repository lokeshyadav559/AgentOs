/**
 * Typed API client for the AgentOS control plane. Mirrors the domain DTOs
 * from the server (src/domain/types.ts).
 */

export type TaskStatus = "todo" | "doing" | "review" | "done";
export type GoalStatus = "active" | "paused" | "completed" | "stopped-spend" | "stopped-time" | "stopped-stuck";
export type SessionStatus = "requested" | "starting" | "running" | "waiting-inbox" | "committing" | "destroyed" | "failed";

export interface Project { id: string; name: string; slug: string; yaml: string | null; createdAt: string }
export interface RepoGrant { repoId: string; mountPath: string; permissions: "git-read" | "git-write" }
export interface FsGrant { folderPath: string; canRead: boolean; canWrite: boolean; canDelete: boolean }
export interface Agent {
  id: string; projectId: string; name: string; title: string; model: string;
  foundationalPrompt: string; rolePrompt: string;
  skillIds: string[]; mcpConnectionIds: string[]; repoAccess: RepoGrant[]; filesystemGrants: FsGrant[];
  collaborationList: string[]; environmentId: string | null;
  runnerPreference: "cloud" | "local" | "inherit"; inboxAccess: boolean; createdAt: string;
}
export interface Skill { id: string; projectId: string; name: string; slug: string; kind: "prompt" | "file"; body: string | null; filePath: string | null }
export interface McpConnection { id: string; projectId: string; name: string; config: Record<string, unknown>; credentialSecretId: string | null }
export interface Repo { id: string; projectId: string; name: string; remoteUrl: string; mountPath: string; credentialSecretId: string | null; defaultBranch: string }
export interface Environment { id: string; projectId: string; name: string; networking: "open" | "limited"; allowedHosts: string[]; envNames: string[] }
export interface SecretRef { id: string; projectId: string; name: string; providerRef: string; purpose: "mcp" | "repo" | "env" | "webhook" }
export interface TaskActivity { at: string; actor: string; message: string }
export interface Task {
  id: string; projectId: string; name: string; description: string; status: TaskStatus;
  assigneeType: "agent" | "human"; assigneeAgentId: string | null; attachmentIds: string[];
  approvalGate: boolean; chainId: string | null; chainIndex: number | null;
  scheduleKind: "now" | "at" | "cron"; runAt: string | null; cron: string | null; timezone: string | null;
  templateId: string | null; activity: TaskActivity[]; sessionIds: string[]; createdAt: string;
}
export interface TemplateStep { name: string; agentName: string; prompt: string; approvalGate: boolean }
export interface TaskTemplate { id: string; projectId: string; name: string; description: string; variables: string[]; steps: TemplateStep[] }
export interface DoDItem { id: string; text: string; done: boolean }
export interface Goal {
  id: string; projectId: string; title: string; spec: string; definitionOfDone: DoDItem[];
  dodApproved: boolean; status: GoalStatus; spendCapUsd: number | null; spendUsd: number;
  maxDurationMinutes: number | null; stuckThreshold: number; runnerPreference: "cloud" | "local" | "auto";
  progressLog: string; startedAt: string | null; sessionIds: string[]; createdAt: string;
}
export interface Trigger { id: string; projectId: string; name: string; webhookSecretId: string | null; webhookSecret: string | null; agentId: string; jobPrompt: string }
export interface Automation { id: string; projectId: string; name: string; cron: string; timezone: string; agentId: string; taskTemplateId: string | null; taskBody: string | null }
export interface InboxChoice { id: string; label: string }
export interface InboxMessage {
  id: string; from: "agent" | "human"; agentId: string | null; sessionId: string | null;
  taskId: string | null; goalId: string | null; kind: "text" | "multiple-choice"; body: string;
  choices: InboxChoice[]; selectedChoiceId: string | null; status: "open" | "answered" | "closed"; createdAt: string;
}
export interface ToolCallLogEntry { ts: string; name: string; input: Record<string, unknown>; output?: unknown; error?: string | null }
export interface Session {
  id: string; projectId: string; agentId: string; taskId: string | null; goalId: string | null;
  runner: "cloud" | "local" | "deepseek"; status: SessionStatus; runtimeHandle: string | null;
  toolCallLog: ToolCallLogEntry[]; startedAt: string; endedAt: string | null; costUsd: number | null;
  commitShas: string[]; manifest: unknown | null; summary: string | null;
}
export interface FileEntry { path: string; type: "dir" | "file"; size: number; updatedAt: string | null }
export interface FileObject { id: string; projectId: string; path: string; bucketKey: string; mime: string; size: number; updatedAt: string }
export interface ActivityEvent { id: string; projectId: string | null; at: string; type: string; actor: string; message: string; taskId?: string | null; goalId?: string | null; sessionId?: string | null }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: () => void): void { onUnauthorized = fn; }

class Api {
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !path.endsWith("/login")) {
      onUnauthorized?.();
      throw new ApiError(401, "unauthorized");
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string } & T;
    if (!res.ok) throw new ApiError(res.status, (json as { error?: string }).error ?? `${res.status}`);
    return json as T;
  }

  login(token: string): Promise<{ ok: boolean }> { return this.req("POST", "/api/login", { token }); }
  logout(): Promise<{ ok: boolean }> { return this.req("POST", "/api/logout"); }
  me(): Promise<{ operator: boolean }> { return this.req("GET", "/api/me"); }
  adminConfig(): Promise<{ localRunnerEnabled: boolean; hasApiKey: boolean; hasDeepseekKey: boolean; cloudBusy: boolean; port: number; publicUrl: string }> {
    return this.req("GET", "/api/admin/config");
  }

  projects(): Promise<Project[]> { return this.req("GET", "/api/projects"); }
  createProject(name: string, slug?: string): Promise<Project> { return this.req("POST", "/api/projects", { name, slug }); }

  agents(pid: string): Promise<Agent[]> { return this.req("GET", `/api/projects/${pid}/agents`); }
  createAgent(pid: string, body: Partial<Agent> & { name: string }): Promise<Agent> { return this.req("POST", `/api/projects/${pid}/agents`, body); }
  updateAgent(pid: string, name: string, body: Partial<Agent>): Promise<Agent> { return this.req("PUT", `/api/projects/${pid}/agents/${name}`, body); }

  skills(pid: string): Promise<Skill[]> { return this.req("GET", `/api/projects/${pid}/skills`); }
  createSkill(pid: string, body: { name: string; slug: string; kind: "prompt" | "file"; body?: string | null; filePath?: string | null }): Promise<Skill> {
    return this.req("POST", `/api/projects/${pid}/skills`, body);
  }

  mcps(pid: string): Promise<McpConnection[]> { return this.req("GET", `/api/projects/${pid}/mcps`); }
  createMcp(pid: string, body: { name: string; config?: Record<string, unknown>; credentialSecretId?: string | null }): Promise<McpConnection> {
    return this.req("POST", `/api/projects/${pid}/mcps`, body);
  }
  repos(pid: string): Promise<Repo[]> { return this.req("GET", `/api/projects/${pid}/repos`); }
  createRepo(pid: string, body: Partial<Repo> & { name: string; remoteUrl: string; mountPath: string }): Promise<Repo> {
    return this.req("POST", `/api/projects/${pid}/repos`, body);
  }
  environments(pid: string): Promise<Environment[]> { return this.req("GET", `/api/projects/${pid}/environments`); }
  createEnvironment(pid: string, body: Partial<Environment> & { name: string }): Promise<Environment> {
    return this.req("POST", `/api/projects/${pid}/environments`, body);
  }
  secrets(pid: string): Promise<SecretRef[]> { return this.req("GET", `/api/projects/${pid}/secrets`); }
  createSecret(pid: string, body: { name: string; purpose: SecretRef["purpose"]; value?: string }): Promise<SecretRef> {
    return this.req("POST", `/api/projects/${pid}/secrets`, body);
  }
  deleteSecret(pid: string, id: string): Promise<{ ok: boolean }> { return this.req("DELETE", `/api/projects/${pid}/secrets/${id}`); }

  files(pid: string, path: string): Promise<{ path: string; entries: FileEntry[] }> {
    return this.req("GET", `/api/projects/${pid}/files?path=${encodeURIComponent(path)}`);
  }
  fileContent(pid: string, path: string): Promise<{ path: string; mime: string; size: number; text: string | null; base64: string | null }> {
    return this.req("GET", `/api/projects/${pid}/files/content?path=${encodeURIComponent(path)}`);
  }
  writeFile(pid: string, path: string, content: string): Promise<FileObject> {
    return this.req("PUT", `/api/projects/${pid}/files/content`, { path, content });
  }
  deleteFile(pid: string, path: string): Promise<{ ok: boolean }> {
    return this.req("DELETE", `/api/projects/${pid}/files/content?path=${encodeURIComponent(path)}`);
  }

  tasks(pid: string): Promise<Task[]> { return this.req("GET", `/api/projects/${pid}/tasks`); }
  task(pid: string, id: string): Promise<Task> { return this.req("GET", `/api/projects/${pid}/tasks/${id}`); }
  createTask(pid: string, body: Record<string, unknown>): Promise<Task> { return this.req("POST", `/api/projects/${pid}/tasks`, body); }
  setTaskStatus(pid: string, id: string, status: TaskStatus): Promise<Task> {
    return this.req("PATCH", `/api/projects/${pid}/tasks/${id}`, { status });
  }
  runTask(pid: string, id: string): Promise<{ ok: boolean; sessionId: string }> {
    return this.req("POST", `/api/projects/${pid}/tasks/${id}/run`);
  }
  templates(pid: string): Promise<TaskTemplate[]> { return this.req("GET", `/api/projects/${pid}/templates`); }
  instantiateTemplate(pid: string, id: string, variables: Record<string, string>): Promise<Task[]> {
    return this.req("POST", `/api/projects/${pid}/templates/${id}/instantiate`, { variables });
  }

  goals(pid: string): Promise<Goal[]> { return this.req("GET", `/api/projects/${pid}/goals`); }
  goal(pid: string, id: string): Promise<Goal> { return this.req("GET", `/api/projects/${pid}/goals/${id}`); }
  createGoal(pid: string, body: Record<string, unknown>): Promise<Goal> { return this.req("POST", `/api/projects/${pid}/goals`, body); }
  approveDod(pid: string, id: string): Promise<Goal> { return this.req("POST", `/api/projects/${pid}/goals/${id}/approve-dod`); }
  pauseGoal(pid: string, id: string): Promise<Goal> { return this.req("POST", `/api/projects/${pid}/goals/${id}/pause`); }
  resumeGoal(pid: string, id: string): Promise<Goal> { return this.req("POST", `/api/projects/${pid}/goals/${id}/resume`); }

  inbox(): Promise<InboxMessage[]> { return this.req("GET", "/api/inbox"); }
  reply(id: string, body: { body?: string; selectedChoiceId?: string }): Promise<{ ok: boolean }> {
    return this.req("POST", `/api/inbox/${id}/reply`, body);
  }

  sessions(projectId?: string): Promise<Session[]> {
    return this.req("GET", `/api/sessions${projectId ? `?projectId=${projectId}` : ""}`);
  }
  session(id: string): Promise<Session> { return this.req("GET", `/api/sessions/${id}`); }
  sessionLive(id: string): EventSource { return new EventSource(`/api/sessions/${id}/live`); }

  activity(): Promise<ActivityEvent[]> { return this.req("GET", "/api/activity"); }

  triggers(pid: string): Promise<Trigger[]> { return this.req("GET", `/api/projects/${pid}/triggers`); }
  createTrigger(pid: string, body: { name: string; agentId: string; jobPrompt?: string }): Promise<Trigger> {
    return this.req("POST", `/api/projects/${pid}/triggers`, body);
  }
  rotateTrigger(pid: string, id: string): Promise<Trigger> { return this.req("POST", `/api/projects/${pid}/triggers/${id}/rotate`); }
  bugfixChain(pid: string, id: string, body: { branchName: string; featureTitle: string; context?: string }): Promise<Task[]> {
    return this.req("POST", `/api/projects/${pid}/triggers/${id}/bugfix-chain`, body);
  }
  automations(pid: string): Promise<Automation[]> { return this.req("GET", `/api/projects/${pid}/automations`); }
  createAutomation(pid: string, body: Partial<Automation> & { name: string; cron: string; agentId: string }): Promise<Automation> {
    return this.req("POST", `/api/projects/${pid}/automations`, body);
  }

  pushVapid(): Promise<{ publicKey: string; subject: string }> { return this.req("GET", "/api/push/vapid"); }
  subscribePush(endpoint: string, keys: { p256dh: string; auth: string }): Promise<{ ok: boolean }> {
    return this.req("POST", "/api/push/subscribe", { endpoint, keys });
  }
  unsubscribePush(endpoint: string): Promise<{ ok: boolean }> {
    return this.req("POST", "/api/push/unsubscribe", { endpoint });
  }
}

export const api = new Api();
