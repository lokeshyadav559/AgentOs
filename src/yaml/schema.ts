/**
 * agentos.yml — YAML-as-code for a project (§17).
 *
 * Every project has an AgentOS YAML file that mimics the online UI: agents,
 * skills, templates, MCP connections, repos, environments, prompts. The DB
 * is a projection; the YAML is canonical on disk / in git.
 *
 * Reconstructed prompts pushed via YAML carry the reconstruction notice.
 */
import YAML from "yaml";
import { z } from "zod";
import type {
  Agent,
  Environment,
  Skill,
  McpConnection,
  Repo,
  TaskTemplate,
  Project,
} from "../domain/types.js";
import { RECONSTRUCTED_NOTICE } from "../prompts/prompts.js";

export const yamlGrantSchema = z.object({
  folderPath: z.string(),
  canRead: z.boolean().default(true),
  canWrite: z.boolean().default(false),
  canDelete: z.boolean().default(false),
});

export const yamlRepoGrantSchema = z.object({
  repoId: z.string(),
  mount: z.string(),
  permissions: z.enum(["git-read", "git-write"]).default("git-read"),
});

export const yamlAgentSchema = z.object({
  title: z.string().optional(),
  model: z.string().optional(),
  skills: z.array(z.string()).default([]),
  mcp: z.array(z.string()).default([]),
  repos: z.array(yamlRepoGrantSchema).default([]),
  grants: z.array(yamlGrantSchema).default([]),
  collaboration: z.array(z.string()).default([]),
  environment: z.string().nullable().optional(),
  runner: z.enum(["cloud", "local", "inherit"]).optional(),
  inbox: z.boolean().optional(),
  prompt: z.string().optional(),
});

export const yamlSkillSchema = z.object({
  name: z.string().optional(),
  kind: z.enum(["prompt", "file"]).default("prompt"),
  body: z.string().optional(),
  filePath: z.string().nullable().optional(),
});

export const yamlEnvironmentSchema = z.object({
  networking: z.enum(["open", "limited"]).default("limited"),
  allowedHosts: z.array(z.string()).default([]),
  envNames: z.array(z.string()).default([]),
});

export const yamlMcpSchema = z.object({
  provider: z.string().optional(),
  url: z.string().optional(),
  credential: z.string().nullable().optional(),
});

export const yamlRepoSchema = z.object({
  remoteUrl: z.string(),
  mount: z.string(),
  credential: z.string().nullable().optional(),
  defaultBranch: z.string().default("main"),
});

export const yamlStepSchema = z.object({
  name: z.string(),
  agent: z.string(),
  approvalGate: z.boolean().default(false),
  prompt: z.string().optional(),
});

export const yamlTemplateSchema = z.object({
  variables: z.array(z.string()).default([]),
  steps: z.array(yamlStepSchema),
  description: z.string().optional(),
});

export const agentosYamlSchema = z.object({
  project: z.string().min(1),
  agents: z.record(z.string(), yamlAgentSchema).default({}),
  skills: z.record(z.string(), yamlSkillSchema).default({}),
  environments: z.record(z.string(), yamlEnvironmentSchema).default({}),
  mcp: z.record(z.string(), yamlMcpSchema).default({}),
  repos: z.record(z.string(), yamlRepoSchema).default({}),
  templates: z.record(z.string(), yamlTemplateSchema).default({}),
});

export type AgentosYaml = z.infer<typeof agentosYamlSchema>;

export function parseAgentosYaml(text: string): AgentosYaml {
  const doc = YAML.parse(text) ?? {};
  return agentosYamlSchema.parse(doc);
}

export function renderAgentosYaml(doc: AgentosYaml): string {
  return YAML.stringify(doc, { indent: 2, lineWidth: 120 });
}

/**
 * DB → YAML document (pull). Deterministic ordering so round-trips are
 * stable. `project` is the project name (slug stays DB-side).
 */
export async function projectToYaml(input: {
  project: Project;
  agents: Agent[];
  skills: Skill[];
  environments: Environment[];
  mcp: McpConnection[];
  repos: Repo[];
  templates: TaskTemplate[];
}): Promise<AgentosYaml> {
  const agentsOut: Record<string, unknown> = {};
  // Agents reference environments by NAME in YAML (stable, human-meaningful);
  // the DB stores the row id, so map back for the round-trip to be identity.
  const envNameById = new Map(input.environments.map((e) => [e.id, e.name]));
  for (const a of [...input.agents].sort((x, y) => x.name.localeCompare(y.name))) {
    agentsOut[a.name] = {
      title: a.title,
      model: a.model,
      skills: a.skillIds,
      mcp: a.mcpConnectionIds,
      repos: a.repoAccess.map((r) => ({ repoId: r.repoId, mount: r.mountPath, permissions: r.permissions })),
      grants: a.filesystemGrants,
      collaboration: a.collaborationList,
      environment: a.environmentId ? (envNameById.get(a.environmentId) ?? null) : null,
      runner: a.runnerPreference,
      inbox: a.inboxAccess || undefined,
      prompt: a.rolePrompt,
    };
  }
  const skillsOut: Record<string, unknown> = {};
  for (const s of [...input.skills].sort((x, y) => x.slug.localeCompare(y.slug))) {
    skillsOut[s.slug] = {
      name: s.name,
      kind: s.kind,
      body: s.body ?? undefined,
      filePath: s.filePath ?? undefined,
    };
  }
  const envOut: Record<string, unknown> = {};
  for (const e of [...input.environments].sort((x, y) => x.name.localeCompare(y.name))) {
    envOut[e.name] = {
      networking: e.networking,
      allowedHosts: e.allowedHosts,
      envNames: e.envNames,
    };
  }
  const mcpOut: Record<string, unknown> = {};
  for (const m of [...input.mcp].sort((x, y) => x.name.localeCompare(y.name))) {
    mcpOut[m.name] = {
      provider: (m.config.provider as string | undefined) ?? undefined,
      url: (m.config.url as string | undefined) ?? undefined,
      credential: m.credentialSecretId ?? undefined,
    };
  }
  const reposOut: Record<string, unknown> = {};
  for (const r of [...input.repos].sort((x, y) => x.name.localeCompare(y.name))) {
    reposOut[r.name] = {
      remoteUrl: r.remoteUrl,
      mount: r.mountPath,
      credential: r.credentialSecretId ?? undefined,
      defaultBranch: r.defaultBranch,
    };
  }
  const templatesOut: Record<string, unknown> = {};
  for (const t of [...input.templates].sort((x, y) => x.name.localeCompare(y.name))) {
    templatesOut[t.name] = {
      description: t.description || undefined,
      variables: t.variables,
      steps: t.steps.map((s) => ({
        name: s.name,
        agent: s.agentName,
        approvalGate: s.approvalGate,
        prompt: s.prompt || undefined,
      })),
    };
  }
  return {
    project: input.project.name,
    agents: agentsOut as AgentosYaml["agents"],
    skills: skillsOut as AgentosYaml["skills"],
    environments: envOut as AgentosYaml["environments"],
    mcp: mcpOut as AgentosYaml["mcp"],
    repos: reposOut as AgentosYaml["repos"],
    templates: templatesOut as AgentosYaml["templates"],
  };
}

/**
 * Strip the legacy reconstruction label from prompts on YAML push.
 * The label is a docs/code matter — agent-facing prompts never carry it.
 */
export function stripPromptNotice(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  if (prompt.startsWith(RECONSTRUCTED_NOTICE)) {
    return prompt.slice(RECONSTRUCTED_NOTICE.length).replace(/^\n+/, "");
  }
  return prompt;
}
