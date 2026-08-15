/**
 * Drizzle schema for the AgentOS control-plane database.
 *
 * SQLite is used here instead of the blueprint's suggested Postgres because
 * this build environment has no Postgres server; the relationships and
 * fields match §19 exactly (arrays/objects stored as JSON columns).
 * NOTE (assumption, per blueprint §3.4): swap `sqliteTable` for `pgTable`
 * and re-run migrations to move to Postgres — no model changes needed.
 */
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { TaskStatus, AssigneeType, ScheduleKind, RunnerPreference, GoalStatus, GoalRunnerPreference, Networking, SkillKind, SecretPurpose, GitPermission, SessionStatus, RunnerKind, InboxFrom, InboxKind, InboxStatus, RepoGrant, FilesystemGrant, TaskActivity, TemplateStep, DoDItem, InboxChoice, ToolCallLogEntry, SessionManifest, ActivityEvent, FileObject } from "../domain/types.js";

const json = <T>(col: string) => text(col, { mode: "json" }).$type<T>();
const bool = (col: string) => integer(col, { mode: "boolean" });

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  yaml: text("yaml"),
  createdAt: text("created_at").notNull(),
});

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    title: text("title").notNull(),
    model: text("model").notNull(),
    foundationalPrompt: text("foundational_prompt").notNull(),
    rolePrompt: text("role_prompt").notNull(),
    skillIds: json<string[]>("skill_ids").notNull().$defaultFn(() => []),
    mcpConnectionIds: json<string[]>("mcp_connection_ids").notNull().$defaultFn(() => []),
    repoAccess: json<RepoGrant[]>("repo_access").notNull().$defaultFn(() => []),
    filesystemGrants: json<FilesystemGrant[]>("filesystem_grants").notNull().$defaultFn(() => []),
    collaborationList: json<string[]>("collaboration_list").notNull().$defaultFn(() => []),
    environmentId: text("environment_id"),
    runnerPreference: text("runner_preference").$type<RunnerPreference>().notNull().default("inherit"),
    inboxAccess: bool("inbox_access").notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("agents_project_name_idx").on(t.projectId, t.name)],
);

export const environments = sqliteTable("environments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  networking: text("networking").$type<Networking>().notNull().default("limited"),
  allowedHosts: json<string[]>("allowed_hosts").notNull().$defaultFn(() => []),
  envNames: json<string[]>("env_names").notNull().$defaultFn(() => []),
});

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  kind: text("kind").$type<SkillKind>().notNull().default("prompt"),
  body: text("body"),
  filePath: text("file_path"),
});

export const mcpConnections = sqliteTable("mcp_connections", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  config: json<Record<string, unknown>>("config").notNull().$defaultFn(() => ({})),
  credentialSecretId: text("credential_secret_id"),
});

export const repos = sqliteTable("repos", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  remoteUrl: text("remote_url").notNull(),
  mountPath: text("mount_path").notNull(),
  credentialSecretId: text("credential_secret_id"),
  defaultBranch: text("default_branch").notNull().default("main"),
});

/** Secret REFS. Values live in the encrypted local vault (Google Secret Manager stand-in). */
export const secrets = sqliteTable("secrets", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  providerRef: text("provider_ref").notNull(),
  purpose: text("purpose").$type<SecretPurpose>().notNull(),
  valueEnc: text("value_enc"), // AES-256-GCM ciphertext (vault stand-in)
  createdAt: text("created_at").notNull(),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<TaskStatus>().notNull().default("todo"),
    assigneeType: text("assignee_type").$type<AssigneeType>().notNull().default("agent"),
    assigneeAgentId: text("assignee_agent_id"),
    attachmentIds: json<string[]>("attachment_ids").notNull().$defaultFn(() => []),
    approvalGate: bool("approval_gate").notNull().default(false),
    chainId: text("chain_id"),
    chainIndex: integer("chain_index"),
    scheduleKind: text("schedule_kind").$type<ScheduleKind>().notNull().default("now"),
    runAt: text("run_at"),
    cron: text("cron"),
    timezone: text("timezone"),
    templateId: text("template_id"),
    activity: json<TaskActivity[]>("activity").notNull().$defaultFn(() => []),
    sessionIds: json<string[]>("session_ids").notNull().$defaultFn(() => []),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("tasks_status_idx").on(t.status), index("tasks_chain_idx").on(t.chainId, t.chainIndex)],
);

export const taskTemplates = sqliteTable("task_templates", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  variables: json<string[]>("variables").notNull().$defaultFn(() => []),
  steps: json<TemplateStep[]>("steps").notNull().$defaultFn(() => []),
});

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  spec: text("spec").notNull(),
  definitionOfDone: json<DoDItem[]>("definition_of_done").notNull().$defaultFn(() => []),
  dodApproved: bool("dod_approved").notNull().default(false),
  status: text("status").$type<GoalStatus>().notNull().default("active"),
  spendCapUsd: real("spend_cap_usd"),
  spendUsd: real("spend_usd").notNull().default(0),
  maxDurationMinutes: integer("max_duration_minutes"),
  stuckThreshold: integer("stuck_threshold").notNull().default(19),
  runnerPreference: text("runner_preference").$type<GoalRunnerPreference>().notNull().default("auto"),
  progressLog: text("progress_log").notNull().default(""),
  startedAt: text("started_at"),
  sessionIds: json<string[]>("session_ids").notNull().$defaultFn(() => []),
  createdAt: text("created_at").notNull(),
});

export const triggers = sqliteTable("triggers", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  webhookSecretId: text("webhook_secret_id"),
  /** Encrypted at rest (vault stand-in), same as secret values. */
  webhookSecretEnc: text("webhook_secret_enc"),
  agentId: text("agent_id").notNull(),
  jobPrompt: text("job_prompt").notNull().default("New inbound event:\n{{payload}}"),
});

export const automations = sqliteTable("automations", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  cron: text("cron").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  agentId: text("agent_id").notNull(),
  taskTemplateId: text("task_template_id"),
  taskBody: text("task_body"),
});

export const inboxMessages = sqliteTable("inbox_messages", {
  id: text("id").primaryKey(),
  from: text("from").$type<InboxFrom>().notNull(),
  agentId: text("agent_id"),
  sessionId: text("session_id"),
  taskId: text("task_id"),
  goalId: text("goal_id"),
  kind: text("kind").$type<InboxKind>().notNull().default("text"),
  body: text("body").notNull(),
  choices: json<InboxChoice[]>("choices").notNull().$defaultFn(() => []),
  selectedChoiceId: text("selected_choice_id"),
  status: text("status").$type<InboxStatus>().notNull().default("open"),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    agentId: text("agent_id").notNull(),
    taskId: text("task_id"),
    goalId: text("goal_id"),
    runner: text("runner").$type<RunnerKind>().notNull(),
    status: text("status").$type<SessionStatus>().notNull().default("requested"),
    runtimeHandle: text("runtime_handle"),
    toolCallLog: json<ToolCallLogEntry[]>("tool_call_log").notNull().$defaultFn(() => []),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    costUsd: real("cost_usd"),
    commitShas: json<string[]>("commit_shas").notNull().$defaultFn(() => []),
    manifest: text("manifest", { mode: "json" }).$type<SessionManifest | null>(),
    summary: text("summary"),
  },
  (t) => [index("sessions_status_idx").on(t.status)],
);

export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    bucketKey: text("bucket_key").notNull(),
    mime: text("mime").notNull().default("application/octet-stream"),
    size: integer("size").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("files_project_path_idx").on(t.projectId, t.path)],
);

export const activityEvents = sqliteTable("activity_events", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  at: text("at").notNull(),
  type: text("type").$type<ActivityEvent["type"]>().notNull().default("system"),
  actor: text("actor").notNull(),
  message: text("message").notNull(),
  taskId: text("task_id"),
  goalId: text("goal_id"),
  sessionId: text("session_id"),
});

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  endpoint: text("endpoint").notNull().unique(),
  keys: json<{ p256dh: string; auth: string }>("keys").notNull(),
  createdAt: text("created_at").notNull(),
});

export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** File rows + resolved content descriptor used by fs MCP / file browser. */
export interface FileRow extends FileObject {}
