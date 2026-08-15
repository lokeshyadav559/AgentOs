/**
 * AgentOS domain model.
 *
 * Mirrors §19 "Data model sketches" of agentos-blueprint.md. Names may vary;
 * fields and relationships cannot be dropped. All entity rows are stored in
 * SQLite via Drizzle (see src/db/schema.ts); this file is the canonical
 * TypeScript shape used across API, MCP, runners and CLI.
 */
import { z } from "zod";

export const uuid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const TaskStatus = z.enum(["todo", "doing", "review", "done"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const AssigneeType = z.enum(["agent", "human"]);
export type AssigneeType = z.infer<typeof AssigneeType>;

export const ScheduleKind = z.enum(["now", "at", "cron"]);
export type ScheduleKind = z.infer<typeof ScheduleKind>;

export const RunnerPreference = z.enum(["cloud", "local", "inherit"]);
export type RunnerPreference = z.infer<typeof RunnerPreference>;

export const GoalRunnerPreference = z.enum(["cloud", "local", "auto"]);
export type GoalRunnerPreference = z.infer<typeof GoalRunnerPreference>;

export const GoalStatus = z.enum([
  "active",
  "paused",
  "completed",
  "stopped-spend",
  "stopped-time",
  "stopped-stuck",
]);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const Networking = z.enum(["open", "limited"]);
export type Networking = z.infer<typeof Networking>;

export const SkillKind = z.enum(["prompt", "file"]);
export type SkillKind = z.infer<typeof SkillKind>;

export const SecretPurpose = z.enum(["mcp", "repo", "env", "webhook"]);
export type SecretPurpose = z.infer<typeof SecretPurpose>;

export const GitPermission = z.enum(["git-read", "git-write"]);
export type GitPermission = z.infer<typeof GitPermission>;

export const SessionStatus = z.enum([
  "requested",
  "starting",
  "running",
  "waiting-inbox",
  "committing",
  "destroyed",
  "failed",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const RunnerKind = z.enum(["cloud", "local", "deepseek"]);
export type RunnerKind = z.infer<typeof RunnerKind>;

export const InboxKind = z.enum(["text", "multiple-choice"]);
export type InboxKind = z.infer<typeof InboxKind>;

export const InboxFrom = z.enum(["agent", "human"]);
export type InboxFrom = z.infer<typeof InboxFrom>;

export const InboxStatus = z.enum(["open", "answered", "closed"]);
export type InboxStatus = z.infer<typeof InboxStatus>;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  slug: string;
  /** Canonical agentos.yml text; DB is a projection of it. */
  yaml: string | null;
  createdAt: string;
}

export interface RepoGrant {
  repoId: string;
  mountPath: string;
  permissions: GitPermission;
}

export interface FilesystemGrant {
  folderPath: string;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
}

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  title: string;
  model: string;
  foundationalPrompt: string;
  rolePrompt: string;
  skillIds: string[];
  mcpConnectionIds: string[];
  repoAccess: RepoGrant[];
  filesystemGrants: FilesystemGrant[];
  collaborationList: string[];
  environmentId: string | null;
  runnerPreference: RunnerPreference;
  inboxAccess: boolean;
  /** Allow the AgentOS MCP to mark this task done. Gate checked server-side too. */
  createdAt: string;
}

export interface Environment {
  id: string;
  projectId: string;
  name: string;
  networking: Networking;
  allowedHosts: string[];
  /** Env secret ref names injected into sessions using this environment (§5.8). */
  envNames: string[];
}

export interface Skill {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  kind: SkillKind;
  body: string | null;
  /** For kind=file: a filesystem path within the project's R2-ish file store. */
  filePath: string | null;
}

export interface McpConnection {
  id: string;
  projectId: string;
  name: string;
  /** Transport config; may reference credentialSecretId. */
  config: Record<string, unknown>;
  credentialSecretId: string | null;
}

export interface Repo {
  id: string;
  projectId: string;
  name: string;
  remoteUrl: string;
  mountPath: string;
  credentialSecretId: string | null;
  defaultBranch: string;
}

export interface SecretRef {
  id: string;
  projectId: string;
  name: string;
  /** Reference into the secret provider (stand-in: local encrypted vault). */
  providerRef: string;
  purpose: SecretPurpose;
}

export interface TaskActivity {
  at: string;
  actor: string; // agent name / "human" / "system"
  message: string;
}

export interface Task {
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: TaskStatus;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  attachmentIds: string[];
  approvalGate: boolean;
  /** Follow-up chain linkage (template instantiation). */
  chainId: string | null;
  chainIndex: number | null;
  scheduleKind: ScheduleKind;
  runAt: string | null;
  cron: string | null;
  timezone: string | null;
  templateId: string | null;
  activity: TaskActivity[];
  sessionIds: string[];
  createdAt: string;
}

export interface TemplateStep {
  name: string;
  /** Agent name, or "human" for a manual step (assigneeType=human). */
  agentName: string;
  prompt: string;
  approvalGate: boolean;
}

export interface TaskTemplate {
  id: string;
  projectId: string;
  name: string;
  description: string;
  variables: string[];
  steps: TemplateStep[];
}

export interface DoDItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Goal {
  id: string;
  projectId: string;
  title: string;
  spec: string;
  definitionOfDone: DoDItem[];
  dodApproved: boolean;
  status: GoalStatus;
  spendCapUsd: number | null;
  spendUsd: number;
  maxDurationMinutes: number | null;
  stuckThreshold: number;
  runnerPreference: GoalRunnerPreference;
  progressLog: string;
  startedAt: string | null;
  sessionIds: string[];
  createdAt: string;
}

export interface Trigger {
  id: string;
  projectId: string;
  name: string;
  webhookSecretId: string | null;
  webhookSecret: string | null;
  agentId: string;
  /** Template for the task description; `{{payload}}` is replaced. */
  jobPrompt: string;
}

export interface Automation {
  id: string;
  projectId: string;
  name: string;
  cron: string;
  timezone: string;
  agentId: string;
  taskTemplateId: string | null;
  taskBody: string | null;
}

export interface InboxChoice {
  id: string;
  label: string;
}

export interface InboxMessage {
  id: string;
  from: InboxFrom;
  agentId: string | null;
  sessionId: string | null;
  taskId: string | null;
  goalId: string | null;
  kind: InboxKind;
  body: string;
  choices: InboxChoice[];
  selectedChoiceId: string | null;
  status: InboxStatus;
  createdAt: string;
}

export interface ToolCallLogEntry {
  ts: string;
  name: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown> | string | null;
  error?: string | null;
}

export interface Session {
  id: string;
  projectId: string;
  agentId: string;
  taskId: string | null;
  goalId: string | null;
  runner: RunnerKind;
  status: SessionStatus;
  runtimeHandle: string | null;
  toolCallLog: ToolCallLogEntry[];
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  commitShas: string[];
  /** Manifest snapshot: what this session was allowed (ACL audit trail). */
  manifest: SessionManifest | null;
  summary: string | null;
}

export interface FileObject {
  id: string;
  projectId: string;
  path: string;
  bucketKey: string;
  mime: string;
  size: number;
  updatedAt: string;
}

export interface ActivityEvent {
  id: string;
  projectId: string | null;
  at: string;
  type:
    | "task"
    | "goal"
    | "session"
    | "inbox"
    | "trigger"
    | "automation"
    | "system";
  actor: string;
  message: string;
  taskId?: string | null;
  goalId?: string | null;
  sessionId?: string | null;
}

// ---------------------------------------------------------------------------
// Session manifest (the least-privilege envelope handed to a runner)
// ---------------------------------------------------------------------------

export interface SessionManifest {
  sessionId: string;
  projectId: string;
  agent: {
    id: string;
    name: string;
    title: string;
    model: string;
    foundationalPrompt: string;
    rolePrompt: string;
    skills: { name: string; slug: string; kind: SkillKind; body: string | null }[];
  };
  task: {
    id: string;
    name: string;
    description: string;
    status: TaskStatus;
    approvalGate: boolean;
    attachments: FileObject[];
  } | null;
  goal: {
    id: string;
    title: string;
    spec: string;
    /** Definition of done (checkboxes) — what "done" means for this goal. */
    definitionOfDone: string[];
    /** Append-only progress log from every specialist session so far. */
    progressLog: string;
  } | null;
  /** MCP connection names granted to this session. */
  mcpConnections: string[];
  /** FileObject ids / paths the session may read as attachments. */
  filesystemGrants: FilesystemGrant[];
  repos: RepoGrant[];
  environment: { networking: Networking; allowedHosts: string[] } | null;
  collaborationList: string[];
  inboxAccess: boolean;
  envNames: string[];
  runnerPreference: RunnerPreference | GoalRunnerPreference;
}

// ---------------------------------------------------------------------------
// Zod DTOs (API + CLI + YAML share these)
// ---------------------------------------------------------------------------

export const filesystemGrantSchema = z.object({
  folderPath: z.string(),
  canRead: z.boolean(),
  canWrite: z.boolean(),
  canDelete: z.boolean(),
});

export const repoGrantSchema = z.object({
  repoId: z.string(),
  mountPath: z.string(),
  permissions: GitPermission,
});

export const agentSchema = z.object({
  id: z.string().optional(),
  projectId: z.string().optional(),
  name: z.string(),
  title: z.string(),
  model: z.string(),
  foundationalPrompt: z.string().optional(),
  rolePrompt: z.string(),
  skillIds: z.array(z.string()).default([]),
  mcpConnectionIds: z.array(z.string()).default([]),
  repoAccess: z.array(repoGrantSchema).default([]),
  filesystemGrants: z.array(filesystemGrantSchema).default([]),
  collaborationList: z.array(z.string()).default([]),
  environmentId: z.string().nullable().optional(),
  runnerPreference: RunnerPreference.default("inherit"),
  inboxAccess: z.boolean().default(false),
});

export const environmentSchema = z.object({
  id: z.string().optional(),
  projectId: z.string().optional(),
  name: z.string(),
  networking: Networking.default("limited"),
  allowedHosts: z.array(z.string()).default([]),
  envNames: z.array(z.string()).default([]),
});

export const skillSchema = z.object({
  id: z.string().optional(),
  projectId: z.string().optional(),
  name: z.string(),
  slug: z.string(),
  kind: SkillKind.default("prompt"),
  body: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
});

export const mcpConnectionSchema = z.object({
  id: z.string().optional(),
  projectId: z.string().optional(),
  name: z.string(),
  config: z.record(z.string(), z.unknown()).default({}),
  credentialSecretId: z.string().nullable().optional(),
});

export const repoSchema = z.object({
  id: z.string().optional(),
  projectId: z.string().optional(),
  name: z.string(),
  remoteUrl: z.string(),
  mountPath: z.string(),
  credentialSecretId: z.string().nullable().optional(),
  defaultBranch: z.string().default("main"),
});

export const secretRefSchema = z.object({
  id: z.string().optional(),
  projectId: z.string().optional(),
  name: z.string(),
  providerRef: z.string().optional(),
  purpose: SecretPurpose,
  /** Plaintext value to store in the vault (never persisted raw). */
  value: z.string().optional(),
});

export const templateStepSchema = z.object({
  name: z.string(),
  agentName: z.string(),
  prompt: z.string().default(""),
  approvalGate: z.boolean().default(false),
});

export const taskTemplateSchema = z.object({
  id: z.string().optional(),
  projectId: z.string().optional(),
  name: z.string(),
  description: z.string().default(""),
  variables: z.array(z.string()).default([]),
  steps: z.array(templateStepSchema).default([]),
});

export const taskCreateSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  assigneeAgentId: z.string().nullable().optional(),
  assigneeType: AssigneeType.default("agent"),
  attachmentIds: z.array(z.string()).default([]),
  approvalGate: z.boolean().default(false),
  scheduleKind: ScheduleKind.default("now"),
  runAt: z.string().nullable().optional(),
  cron: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  templateId: z.string().nullable().optional(),
  variables: z.record(z.string(), z.string()).optional(), // for template instantiation
  chainId: z.string().nullable().optional(),
  chainIndex: z.number().nullable().optional(),
});

export const goalCreateSchema = z.object({
  title: z.string(),
  spec: z.string(),
  definitionOfDone: z
    .array(z.string())
    .optional()
    .describe("Optional pre-written DoD checkboxes (texts)."),
  spendCapUsd: z.number().nullable().optional(),
  maxDurationMinutes: z.number().nullable().optional(),
  runnerPreference: GoalRunnerPreference.default("auto"),
  stuckThreshold: z.number().default(19),
});

export const triggerCreateSchema = z.object({
  name: z.string(),
  agentId: z.string(),
  jobPrompt: z.string().default("New inbound event:\n{{payload}}"),
});

export const automationCreateSchema = z.object({
  name: z.string(),
  cron: z.string(),
  timezone: z.string().default("UTC"),
  agentId: z.string(),
  taskTemplateId: z.string().nullable().optional(),
  taskBody: z.string().nullable().optional(),
});

export const inboxReplySchema = z.object({
  body: z.string().optional(),
  selectedChoiceId: z.string().optional(),
});

export const skillCreateSchema = z.object({
  name: z.string(),
  slug: z.string(),
  kind: SkillKind.default("prompt"),
  body: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
});

export const agentUpdateSchema = agentSchema.partial().extend({ name: z.string() });
