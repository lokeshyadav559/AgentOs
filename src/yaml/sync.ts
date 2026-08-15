/**
 * YAML sync service: push (YAML → DB projection) and pull (DB → YAML).
 * §17 + §22 #12 (push then pull is identity modulo whitespace).
 */
import { eq } from "drizzle-orm";
import { agents, environments, skills, mcpConnections, repos, taskTemplates } from "../db/schema.js";
import type { DB } from "../db/client.js";
import type { AgentosYaml } from "./schema.js";
import { stripPromptNotice } from "./schema.js";
import { FOUNDATIONAL_PROMPT } from "../prompts/prompts.js";
import type { Agent, Environment, Skill, McpConnection, Repo, TaskTemplate } from "../domain/types.js";
import { HttpError } from "../api/errors.js";

export class YamlSyncService {
  constructor(private db: DB) {}

  /**
   * Push a parsed YAML document into the DB projection (upsert by name/slug).
   * Unknown keys are ignored; this is a one-way projection, not a mirror —
   * the YAML remains canonical.
   */
  async push(projectId: string, doc: AgentosYaml): Promise<void> {
    // Environments
    const envRows = await this.db.select().from(environments).where(eq(environments.projectId, projectId)).all();
    for (const [name, e] of Object.entries(doc.environments)) {
      const existing = envRows.find((r) => r.name === name);
      const row: Omit<Environment, "id"> = {
        projectId,
        name,
        networking: e.networking,
        allowedHosts: e.allowedHosts,
        envNames: e.envNames,
      };
      if (existing) {
        await this.db.update(environments).set(row).where(eq(environments.id, existing.id)).run();
      } else {
        await this.db.insert(environments).values({ ...row, id: crypto.randomUUID() }).run();
      }
    }

    // MCP connections
    const mcpRows = await this.db.select().from(mcpConnections).where(eq(mcpConnections.projectId, projectId)).all();
    for (const [name, m] of Object.entries(doc.mcp)) {
      const existing = mcpRows.find((r) => r.name === name);
      const row: Omit<McpConnection, "id"> = {
        projectId,
        name,
        config: { provider: m.provider, url: m.url },
        credentialSecretId: m.credential ?? null,
      };
      if (existing) {
        await this.db.update(mcpConnections).set(row).where(eq(mcpConnections.id, existing.id)).run();
      } else {
        await this.db.insert(mcpConnections).values({ ...row, id: crypto.randomUUID() }).run();
      }
    }

    // Repos
    const repoRows = await this.db.select().from(repos).where(eq(repos.projectId, projectId)).all();
    for (const [name, r] of Object.entries(doc.repos)) {
      const existing = repoRows.find((x) => x.name === name);
      const row: Omit<Repo, "id"> = {
        projectId,
        name,
        remoteUrl: r.remoteUrl,
        mountPath: r.mount,
        credentialSecretId: r.credential ?? null,
        defaultBranch: r.defaultBranch,
      };
      if (existing) {
        await this.db.update(repos).set(row).where(eq(repos.id, existing.id)).run();
      } else {
        await this.db.insert(repos).values({ ...row, id: crypto.randomUUID() }).run();
      }
    }

    // Skills
    const skillRows = await this.db.select().from(skills).where(eq(skills.projectId, projectId)).all();
    for (const [slug, s] of Object.entries(doc.skills)) {
      const existing = skillRows.find((x) => x.slug === slug);
      const row: Omit<Skill, "id"> = {
        projectId,
        name: s.name ?? slug,
        slug,
        kind: s.kind,
        body: s.body ?? null,
        filePath: s.filePath ?? null,
      };
      if (existing) {
        await this.db.update(skills).set(row).where(eq(skills.id, existing.id)).run();
      } else {
        await this.db.insert(skills).values({ ...row, id: crypto.randomUUID() }).run();
      }
    }

    // Agents (upsert by name; prompts carry the reconstruction notice)
    const agentRows = await this.db.select().from(agents).where(eq(agents.projectId, projectId)).all();
    for (const [name, a] of Object.entries(doc.agents)) {
      const existing = agentRows.find((x) => x.name === name);
      const row: Omit<Agent, "id" | "createdAt"> = {
        projectId,
        name,
        title: a.title ?? name,
        model: a.model ?? "claude-opus-4",
        foundationalPrompt: FOUNDATIONAL_PROMPT,
        rolePrompt: stripPromptNotice(a.prompt) ?? "",
        skillIds: a.skills,
        mcpConnectionIds: a.mcp,
        repoAccess: a.repos.map((r) => ({ repoId: r.repoId, mountPath: r.mount, permissions: r.permissions })),
        filesystemGrants: a.grants,
        collaborationList: a.collaboration,
        environmentId: a.environment ? (envRows.find((e) => e.name === a.environment)?.id ?? null) : null,
        runnerPreference: a.runner ?? "inherit",
        inboxAccess: a.inbox ?? false,
      };
      if (existing) {
        await this.db.update(agents).set(row).where(eq(agents.id, existing.id)).run();
      } else {
        await this.db.insert(agents).values({ ...row, id: crypto.randomUUID(), createdAt: new Date().toISOString() }).run();
      }
    }

    // Templates (upsert by name)
    const tplRows = await this.db.select().from(taskTemplates).where(eq(taskTemplates.projectId, projectId)).all();
    for (const [name, t] of Object.entries(doc.templates)) {
      const existing = tplRows.find((x) => x.name === name);
      const row: Omit<TaskTemplate, "id"> = {
        projectId,
        name,
        description: t.description ?? "",
        variables: t.variables,
        steps: t.steps.map((s) => ({
          name: s.name,
          agentName: s.agent,
          prompt: stripPromptNotice(s.prompt) ?? "",
          approvalGate: s.approvalGate,
        })),
      };
      if (existing) {
        await this.db.update(taskTemplates).set(row).where(eq(taskTemplates.id, existing.id)).run();
      } else {
        await this.db.insert(taskTemplates).values({ ...row, id: crypto.randomUUID() }).run();
      }
    }
  }
}
