/**
 * Default catalog provisioned for every new project: the named agents from
 * §8, the built-in MCP connections, default environments, the plan-mode
 * skill, and the `compound-engineer-workflow` template from §10.
 *
 * Reconstructed prompts come from src/prompts/prompts.ts (labeled there).
 */
import { randomUUID } from "node:crypto";
import {
  FOUNDATIONAL_PROMPT,
  ROLE_PROMPTS,
  PLAN_MODE_SKILL_BODY,
} from "../prompts/prompts.js";
import { DEFAULT_MODELS } from "../runners/models.js";
import type {
  Agent,
  Environment,
  Skill,
  McpConnection,
  TaskTemplate,
  TemplateStep,
  RunnerPreference,
} from "./types.js";

export interface ProjectDefaults {
  agents: Omit<Agent, "id" | "createdAt">[];
  environments: Omit<Environment, "id">[];
  skills: Omit<Skill, "id">[];
  mcpConnections: Omit<McpConnection, "id">[];
  templates: Omit<TaskTemplate, "id">[];
}

const plannerModel = DEFAULT_MODELS.planner;
const workerModel = DEFAULT_MODELS.worker;

/** Shared per-agent filesystem grants: own home folder + shared goal folder. */
const homeGrant = (slug: string) => ({
  folderPath: `/agents/${slug}`,
  canRead: true,
  canWrite: true,
  canDelete: true, // own home folder: delete allowed
});
const goalGrant = {
  folderPath: `/goals/`,
  canRead: true,
  canWrite: true,
  canDelete: false, // shared folder: write yes, delete still explicit (blueprint §7)
};
const wikiGrant = {
  folderPath: `/wiki`,
  canRead: true,
  canWrite: true,
  canDelete: false,
};

export function projectDefaults(projectId: string): ProjectDefaults {
  // These are environment NAMES — agent rows store them and ProjectService
  // resolves them against the seeded environments below (§5.5 network wall).
  const envNone = "limited-none";
  const envOpen = "open";

  const mcpAgentos = "agentos";
  const mcpInbox = "inbox";
  const mcpR2 = "r2-fs";
  const mcpGithub = "github";
  const mcpFront = "front";

  const environments: Omit<Environment, "id">[] = [
    {
      projectId,
      // Customer-support is "limited to Front" (§5.3): the wall must let the
      // support agent reach its one connection host and nothing else.
      name: "limited-none",
      networking: "limited",
      allowedHosts: ["api.front.com"],
      envNames: [],
    },
    {
      projectId,
      name: "open",
      networking: "open",
      allowedHosts: [],
      envNames: [],
    },
  ];

  const skills: Omit<Skill, "id">[] = [
    {
      projectId,
      name: "Plan mode",
      slug: "plan-mode",
      kind: "prompt",
      body: PLAN_MODE_SKILL_BODY,
      filePath: null,
    },
  ];

  const mcpConnections: Omit<McpConnection, "id">[] = [
    { projectId, name: "agentos", config: { builtin: true }, credentialSecretId: null },
    { projectId, name: "inbox", config: { builtin: true }, credentialSecretId: null },
    { projectId, name: "r2-fs", config: { builtin: true }, credentialSecretId: null },
    // External connections are configurable, not hardcoded product logic (§23).
    { projectId, name: "github", config: { provider: "github", url: "https://api.github.com" }, credentialSecretId: null },
    { projectId, name: "front", config: { provider: "front", url: "https://api.front.com" }, credentialSecretId: null },
  ];

  const agent = (
    name: string,
    title: string,
    model: string,
    opts: {
      role?: string;
      skills?: string[];
      mcp?: string[];
      repos?: Agent["repoAccess"];
      grants?: Agent["filesystemGrants"];
      collab?: string[];
      env?: string;
      runner?: RunnerPreference;
      inbox?: boolean;
    } = {},
  ): Omit<Agent, "id" | "createdAt"> => ({
    projectId,
    name,
    title,
    model,
    foundationalPrompt: FOUNDATIONAL_PROMPT,
    rolePrompt: opts.role ?? ROLE_PROMPTS[name] ?? ROLE_PROMPTS.default,
    skillIds: opts.skills ?? [],
    mcpConnectionIds: opts.mcp ?? [mcpAgentos, mcpInbox, mcpR2],
    repoAccess: opts.repos ?? [],
    filesystemGrants: opts.grants ?? [homeGrant(name), goalGrant],
    collaborationList: opts.collab ?? [],
    environmentId: opts.env ?? envNone,
    runnerPreference: opts.runner ?? "inherit",
    inboxAccess: opts.inbox ?? false,
  });

  const agents: Omit<Agent, "id" | "createdAt">[] = [
    agent("default", "Default workhorse", workerModel, { env: envOpen }),
    agent("plan", "Plan agent", plannerModel, {
      role: ROLE_PROMPTS.plan,
      skills: ["skill-plan-mode"],
      mcp: [mcpAgentos, mcpInbox, mcpR2],
      runner: "cloud",
    }),
    agent("spec", "Spec agent", plannerModel, {
      role: ROLE_PROMPTS.spec,
      runner: "cloud",
      inbox: true,
    }),
    agent("senior-dev", "Senior developer", workerModel, {
      role: ROLE_PROMPTS["senior-dev"],
      mcp: [mcpAgentos, mcpInbox, mcpR2, mcpGithub],
      env: envOpen,
    }),
    agent("implementation-plan-executioner", "Implementation plan executioner", workerModel, {
      role: ROLE_PROMPTS["implementation-plan-executioner"],
      mcp: [mcpAgentos, mcpInbox, mcpR2, mcpGithub],
      env: envOpen,
    }),
    agent("review-coordinator", "Review coordinator", plannerModel, {
      role: ROLE_PROMPTS["review-coordinator"],
      collab: ["feasibility", "scope-guardian", "coherence", "plan-risk"],
      runner: "cloud",
    }),
    agent("feasibility", "Feasibility reviewer", plannerModel, {
      role: ROLE_PROMPTS.feasibility,
      runner: "cloud",
    }),
    agent("scope-guardian", "Scope guardian", plannerModel, {
      role: ROLE_PROMPTS["scope-guardian"],
      runner: "cloud",
    }),
    agent("coherence", "Coherence reviewer", plannerModel, {
      role: ROLE_PROMPTS.coherence,
      runner: "cloud",
    }),
    agent("plan-risk", "Plan risk reviewer", plannerModel, {
      role: ROLE_PROMPTS["plan-risk"],
      runner: "cloud",
    }),
    agent("librarian", "Librarian", workerModel, {
      role: ROLE_PROMPTS.librarian,
      grants: [homeGrant("librarian"), wikiGrant],
      env: envOpen,
    }),
    // Optional-but-seeded extras named in §8.
    agent("customer-support", "Customer support", workerModel, {
      role: ROLE_PROMPTS["customer-support"],
      mcp: [mcpAgentos, mcpInbox, mcpFront], // Front only — no GitHub, no Gmail (§5.3)
      env: envNone,
      inbox: true,
    }),
    agent("diagnostic", "Bug diagnostic", workerModel, {
      role: ROLE_PROMPTS.diagnostic,
      mcp: [mcpAgentos, mcpInbox, mcpR2, mcpGithub],
      env: envOpen,
    }),
    agent("linkedin-content", "LinkedIn content", workerModel, {
      role: ROLE_PROMPTS["linkedin-content"],
      env: envNone,
    }),
  ];

  // Template steps: each step carries a tight brief — the deliverable and
  // the exit criteria — so the assigned agent knows what "done" means.

  const tpl: Omit<TaskTemplate, "id"> = {
    projectId,
    name: "compound-engineer-workflow",
    description:
      "~3-hour fully managed feature build (his words; actual runs ~5–6h): spec (human-gated) → plan → multi-agent plan review → revise → implement with E2E → code review → fixes → wiki → human PR review.",
    variables: ["branchName", "featureTitle"],
    steps: compoundEngineerSteps(),
  };

  return { agents, environments, skills, mcpConnections, templates: [tpl] };
}

export function newProjectId(): string {
  return randomUUID();
}

/**
 * §10 — compound-engineer-workflow steps (canonical prompts).
 * Shared by the default catalog and the prompt migration so both use the
 * exact same briefs. Each step keeps its {{variables}} for interpolation.
 */
export function compoundEngineerSteps(): TemplateStep[] {
  return [
    {
      name: "Write a spec",
      agentName: "spec",
      prompt:
        "Write a detailed feature specification for {{featureTitle}} (branch {{branchName}}). " +
        "Deliverable: a spec file attached to the task with context, requirements, acceptance criteria and an out-of-scope list. " +
        "Exit: the spec is attached and awaiting human approval — do not mark the task done.",
      approvalGate: true,
    },
    {
      name: "Plan",
      agentName: "plan",
      prompt:
        "Turn the approved spec for {{featureTitle}} (branch {{branchName}}) into a concrete, ordered implementation plan. " +
        "Deliverable: a plan file attached to the task. " +
        "Exit: the plan is attached and the task is finished. Do not implement.",
      approvalGate: false,
    },
    {
      name: "Plan review",
      agentName: "review-coordinator",
      prompt:
        "Spawn the plan-review specialists (feasibility, scope-guardian, coherence, plan-risk) for the plan of {{featureTitle}}. " +
        "Deliverable: a consolidated report with must-fix / should-fix items, attached to the task. " +
        "Exit: every specialist reported and the consolidation is attached. Do not fix anything yourself.",
      approvalGate: false,
    },
    {
      name: "Revise plan",
      agentName: "plan",
      prompt:
        "Revise the plan for {{featureTitle}} using the consolidated plan review (must-fix, then should-fix). " +
        "Deliverable: the revised plan attached to the task. " +
        "Exit: every must-fix is addressed in the revised plan and the task is finished.",
      approvalGate: false,
    },
    {
      name: "Implementation",
      agentName: "implementation-plan-executioner",
      prompt:
        "Implement {{featureTitle}} on branch {{branchName}} exactly per the revised plan. " +
        "Deliverable: a committed implementation. " +
        "Exit: all plan steps implemented, the repo's E2E tests run and surfaced issues fixed, work committed, task finished.",
      approvalGate: false,
    },
    {
      name: "Code review",
      agentName: "review-coordinator",
      prompt:
        "Spawn the code-review specialists for the implementation of {{featureTitle}} on branch {{branchName}}. " +
        "Deliverable: a consolidated report with must-fix / should-fix items, attached to the task. " +
        "Exit: every specialist reported and the consolidation is attached. Do not fix anything yourself.",
      approvalGate: false,
    },
    {
      name: "Apply review fixes",
      agentName: "senior-dev",
      prompt:
        "Apply the consolidated code-review fixes (must-fix, then should-fix) for {{featureTitle}} on branch {{branchName}}. " +
        "Deliverable: committed fixes. " +
        "Exit: must-fix items resolved, E2E re-run and passing, work committed, task finished.",
      approvalGate: false,
    },
    {
      name: "Librarian",
      agentName: "librarian",
      prompt:
        "Update the internal wiki to reflect how the codebase actually works after {{featureTitle}} on branch {{branchName}}. " +
        "Deliverable: wiki pages describing the post-change state. " +
        "Exit: wiki updated, task finished. Do not change product code.",
      approvalGate: false,
    },
    {
      name: "Human PR review",
      agentName: "human",
      prompt:
        "Review the PR for {{featureTitle}} on branch {{branchName}}; merge when satisfied.",
      approvalGate: true,
    },
  ];
}
