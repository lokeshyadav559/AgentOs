/**
 * Project service: project CRUD + provisioning of the default catalog
 * (agents, environments, skills, MCP connections, templates).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, agents, environments, skills, mcpConnections, taskTemplates } from "../db/schema.js";
import type { DB } from "../db/client.js";
import { projectDefaults } from "../domain/defaults.js";
import type { Project } from "../domain/types.js";
import { HttpError } from "../api/errors.js";

export class ProjectService {
  constructor(private db: DB) {}

  async create(input: { name: string; slug?: string }): Promise<Project> {
    const slug = input.slug ?? slugify(input.name);
    const existing = await this.db.select().from(projects).where(eq(projects.slug, slug)).get();
    if (existing) throw new HttpError(409, `project slug "${slug}" already exists`);
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      slug,
      yaml: null,
      createdAt: now,
    };
    await this.db.insert(projects).values(project).run();
    await this.provisionDefaults(project.id);
    return project;
  }

  /** Seed the default catalog (§8/§10) for a fresh project. */
  async provisionDefaults(projectId: string): Promise<void> {
    const d = projectDefaults(projectId);
    for (const e of d.environments) {
      await this.db.insert(environments).values({ ...e, id: randomUUID() }).run();
    }
    const envByName = new Map(
      (await this.db.select().from(environments).where(eq(environments.projectId, projectId)).all()).map(
        (e) => [e.name, e.id],
      ),
    );
    for (const m of d.mcpConnections) {
      await this.db.insert(mcpConnections).values({ ...m, id: randomUUID() }).run();
    }
    const mcpByName = new Map(
      (await this.db.select().from(mcpConnections).where(eq(mcpConnections.projectId, projectId)).all()).map(
        (m) => [m.name, m.id],
      ),
    );
    for (const s of d.skills) {
      const id = s.slug === "plan-mode" ? `skill-plan-mode-${projectId.slice(0, 8)}` : randomUUID();
      await this.db.insert(skills).values({ ...s, id }).run();
    }
    for (const a of d.agents) {
      await this.db
        .insert(agents)
        .values({
          ...a,
          id: randomUUID(),
          skillIds: a.skillIds.map((id) => id.replace(/^skill-plan-mode$/, `skill-plan-mode-${projectId.slice(0, 8)}`)),
          mcpConnectionIds: a.mcpConnectionIds.map((id) => mcpByName.get(id) ?? id),
          environmentId: a.environmentId ? envByName.get(a.environmentId) ?? null : null,
          createdAt: new Date().toISOString(),
        })
        .run();
    }
    for (const t of d.templates) {
      await this.db.insert(taskTemplates).values({ ...t, id: randomUUID() }).run();
    }
    // Bug-fix chain template (§10): implement → plan → plan review → fix → E2E → human merge.
    await this.db
      .insert(taskTemplates)
      .values({
        id: randomUUID(),
        projectId,
        name: "bugfix-chain",
        description:
          "Post-approval bug fix chain (blueprint §10/§14): implement → plan → plan review → apply fixes → E2E → human merge.",
        variables: ["branchName", "featureTitle", "bugContext"],
        steps: [
          { name: "Implement fix", agentName: "implementation-plan-executioner", prompt: "Implement the fix for {{featureTitle}} on branch {{branchName}}.\nContext: {{bugContext}}", approvalGate: false },
          { name: "Plan", agentName: "plan", prompt: "Turn the fix into a concrete plan for {{featureTitle}} on branch {{branchName}}.", approvalGate: false },
          { name: "Plan review", agentName: "review-coordinator", prompt: "Review the fix plan ({{featureTitle}}, branch {{branchName}}) with the plan-review specialists; consolidate must-fix / should-fix.", approvalGate: false },
          { name: "Apply review fixes", agentName: "senior-dev", prompt: "Apply the consolidated review fixes for {{featureTitle}} on branch {{branchName}}. Commit.", approvalGate: false },
          { name: "E2E verification", agentName: "implementation-plan-executioner", prompt: "Run the repo's existing E2E tests for {{featureTitle}} on branch {{branchName}}; fix what they surface; commit.", approvalGate: false },
          { name: "Human merge", agentName: "human", prompt: "Review and merge the bug fix for {{featureTitle}} on branch {{branchName}}.", approvalGate: true },
        ],
      })
      .run();
  }

  async get(id: string): Promise<Project | null> {
    const row = await this.db.select().from(projects).where(eq(projects.id, id)).get();
    return row ?? null;
  }

  async list(): Promise<Project[]> {
    return this.db.select().from(projects).all();
  }

  async setYaml(id: string, yaml: string | null): Promise<void> {
    await this.db.update(projects).set({ yaml }).where(eq(projects.id, id)).run();
  }
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "project";
}
