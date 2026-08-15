/**
 * Database client + idempotent migration.
 *
 * SQLite via better-sqlite3 (synchronous — fine for a single-operator
 * control plane). NOTE (assumption): Postgres + Prisma was the blueprint's
 * suggested stack; SQLite keeps the same model runnable in this environment.
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import type { Config } from "../config.js";

export type DB = BetterSQLite3Database<typeof schema>;
export { schema };

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    yaml TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, title TEXT NOT NULL, model TEXT NOT NULL,
    foundational_prompt TEXT NOT NULL, role_prompt TEXT NOT NULL,
    skill_ids TEXT NOT NULL DEFAULT '[]', mcp_connection_ids TEXT NOT NULL DEFAULT '[]',
    repo_access TEXT NOT NULL DEFAULT '[]', filesystem_grants TEXT NOT NULL DEFAULT '[]',
    collaboration_list TEXT NOT NULL DEFAULT '[]', environment_id TEXT,
    runner_preference TEXT NOT NULL DEFAULT 'inherit', inbox_access INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, name))`,
  `CREATE TABLE IF NOT EXISTS environments (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, networking TEXT NOT NULL DEFAULT 'limited',
    allowed_hosts TEXT NOT NULL DEFAULT '[]', env_names TEXT NOT NULL DEFAULT '[]')`,
  `CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, slug TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'prompt',
    body TEXT, file_path TEXT)`,
  `CREATE TABLE IF NOT EXISTS mcp_connections (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', credential_secret_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, remote_url TEXT NOT NULL, mount_path TEXT NOT NULL,
    credential_secret_id TEXT, default_branch TEXT NOT NULL DEFAULT 'main')`,
  `CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, provider_ref TEXT NOT NULL, purpose TEXT NOT NULL,
    value_enc TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    assignee_type TEXT NOT NULL DEFAULT 'agent', assignee_agent_id TEXT,
    attachment_ids TEXT NOT NULL DEFAULT '[]', approval_gate INTEGER NOT NULL DEFAULT 0,
    chain_id TEXT, chain_index INTEGER,
    schedule_kind TEXT NOT NULL DEFAULT 'now', run_at TEXT, cron TEXT, timezone TEXT,
    template_id TEXT, activity TEXT NOT NULL DEFAULT '[]',
    session_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status)`,
  `CREATE INDEX IF NOT EXISTS tasks_chain_idx ON tasks(chain_id, chain_index)`,
  `CREATE TABLE IF NOT EXISTS task_templates (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    variables TEXT NOT NULL DEFAULT '[]', steps TEXT NOT NULL DEFAULT '[]')`,
  `CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL, spec TEXT NOT NULL,
    definition_of_done TEXT NOT NULL DEFAULT '[]', dod_approved INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active', spend_cap_usd REAL, spend_usd REAL NOT NULL DEFAULT 0,
    max_duration_minutes INTEGER, stuck_threshold INTEGER NOT NULL DEFAULT 19,
    runner_preference TEXT NOT NULL DEFAULT 'auto', progress_log TEXT NOT NULL DEFAULT '',
    started_at TEXT, session_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, webhook_secret_id TEXT, webhook_secret_enc TEXT,
    agent_id TEXT NOT NULL, job_prompt TEXT NOT NULL DEFAULT 'New inbound event:\n{{payload}}')`,
  `CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, cron TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'UTC',
    agent_id TEXT NOT NULL, task_template_id TEXT, task_body TEXT)`,
  `CREATE TABLE IF NOT EXISTS inbox_messages (
    id TEXT PRIMARY KEY, "from" TEXT NOT NULL, agent_id TEXT, session_id TEXT,
    task_id TEXT, goal_id TEXT, kind TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL,
    choices TEXT NOT NULL DEFAULT '[]', selected_choice_id TEXT,
    status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    task_id TEXT, goal_id TEXT, runner TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested', runtime_handle TEXT,
    tool_call_log TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL, ended_at TEXT,
    cost_usd REAL, commit_shas TEXT NOT NULL DEFAULT '[]', manifest TEXT, summary TEXT)`,
  `CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status)`,
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL, bucket_key TEXT NOT NULL, mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    UNIQUE(project_id, path))`,
  `CREATE TABLE IF NOT EXISTS activity_events (
    id TEXT PRIMARY KEY, project_id TEXT, at TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'system',
    actor TEXT NOT NULL, message TEXT NOT NULL, task_id TEXT, goal_id TEXT, session_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE,
    keys TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export function openDb(path: string): DB {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export function migrate(db: DB): void {
  const sqlite = (db as unknown as { $client: Database.Database }).$client;
  sqlite.exec("BEGIN");
  try {
    for (const m of MIGRATIONS) sqlite.exec(m);
    sqlite.exec("COMMIT");
  } catch (e) {
    sqlite.exec("ROLLBACK");
    throw e;
  }
}

export function openMigratedDb(config: Config): DB {
  const db = openDb(config.dbPath);
  migrate(db);
  return db;
}
