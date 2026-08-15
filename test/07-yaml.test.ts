/**
 * Phase 6 acceptance (§21 Phase 6): YAML-as-code round-trip.
 * §22 #12 push then pull is identity (modulo whitespace).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { projects, agents, environments, skills, mcpConnections, repos, taskTemplates } from "../src/db/schema.js";
import { YamlSyncService } from "../src/yaml/sync.js";
import { makeContext, newProject, agentByName, createTask, runScriptedSession, type TestContext } from "./helpers.js";
import {
  parseAgentosYaml,
  renderAgentosYaml,
  projectToYaml,
  type AgentosYaml,
} from "../src/yaml/schema.js";

let ctx: TestContext;
beforeEach(() => {
  ctx = makeContext();
});
afterEach(() => ctx.cleanup());

async function pull(projectId: string): Promise<AgentosYaml> {
  const [proj] = await ctx.services.db.select().from(projects).where(eq(projects.id, projectId));
  const [agentsRows, envRows, skillRows, mcpRows, repoRows, tplRows] = await Promise.all([
    ctx.services.db.select().from(agents).where(eq(agents.projectId, projectId)).all(),
    ctx.services.db.select().from(environments).where(eq(environments.projectId, projectId)).all(),
    ctx.services.db.select().from(skills).where(eq(skills.projectId, projectId)).all(),
    ctx.services.db.select().from(mcpConnections).where(eq(mcpConnections.projectId, projectId)).all(),
    ctx.services.db.select().from(repos).where(eq(repos.projectId, projectId)).all(),
    ctx.services.db.select().from(taskTemplates).where(eq(taskTemplates.projectId, projectId)).all(),
  ]);
  return projectToYaml({
    project: proj!,
    agents: agentsRows as never[],
    skills: skillRows as never[],
    environments: envRows as never[],
    mcp: mcpRows as never[],
    repos: repoRows as never[],
    templates: tplRows as never[],
  });
}

describe("§22 #12 — YAML round-trip", () => {
  it("push then pull is identity (modulo whitespace)", async () => {
    const p = await newProject(ctx);
    const sync = new YamlSyncService(ctx.services.db);

    const before = await pull(p.id);
    const rendered = renderAgentosYaml(before);
    const pushed = parseAgentosYaml(rendered);
    await sync.push(p.id, pushed);
    const after = await pull(p.id);

    expect(after).toEqual(before);
    expect(renderAgentosYaml(after)).toBe(rendered);
  });

  it("the §17 example YAML pushes into the DB and pulls back with the same agents + template", async () => {
    const p = await newProject(ctx);
    const sync = new YamlSyncService(ctx.services.db);
    const example = parseAgentosYaml(`project: acme
agents:
  spec:
    title: Spec agent
    model: claude-opus-4
    skills: [inbox]
    mcp: [agentos, inbox, r2-fs]
    repos: []
    environment: limited-none
    runner: cloud
    prompt: |
      You are a spec agent. Produce a detailed specification.
  plan:
    title: Plan agent
    model: claude-opus-4
    skills: [plan-mode]
    mcp: [agentos, inbox, r2-fs]
    repos: []
    collaboration: []
    environment: limited-none
    runner: cloud
    prompt: |
      You are a plan agent. Turn an approved spec into a plan.
skills:
  plan-mode:
    kind: prompt
    body: |
      /plan — enter plan mode and produce an ordered implementation plan.
templates:
  compound-engineer-workflow:
    variables: [branchName]
    steps:
      - { name: Write a spec, agent: spec, approvalGate: true }
      - { name: Plan, agent: plan }
`);
    await sync.push(p.id, example);

    const agentsAfter = await ctx.services.db.select().from(agents).where(eq(agents.projectId, p.id)).all();
    const spec = agentsAfter.find((a) => a.name === "spec");
    expect(spec?.title).toBe("Spec agent");
    expect(spec?.model).toBe("claude-opus-4");
    expect(spec?.runnerPreference).toBe("cloud");
    // Pushed prompts are stored verbatim (label stripped, not injected).
    expect(spec?.rolePrompt).toContain("You are a spec agent. Produce a detailed specification.");
    expect(spec?.rolePrompt).not.toContain("Reconstructed from Danny Postma's AgentOS talk");

    const tpls = await ctx.services.db.select().from(taskTemplates).where(eq(taskTemplates.projectId, p.id)).all();
    const tpl = tpls.find((t) => t.name === "compound-engineer-workflow");
    expect(tpl?.steps.length).toBe(2);
    expect(tpl?.steps[0]?.approvalGate).toBe(true);

    // Pull reflects the pushed state (projection).
    const pulled = await pull(p.id);
    expect(pulled.agents.spec?.title).toBe("Spec agent");
    expect(pulled.templates["compound-engineer-workflow"]?.steps).toHaveLength(2);
  });

  it("skills pushed via YAML attach to the agent's session manifest (by slug)", async () => {
    const p = await newProject(ctx);
    const sync = new YamlSyncService(ctx.services.db);
    const doc = parseAgentosYaml(`project: test-project
skills:
  my-skill:
    name: My Skill
    kind: prompt
    body: do the thing carefully
agents:
  default:
    skills: [my-skill]
`);
    await sync.push(p.id, doc);

    const agent = await agentByName(ctx, p.id, "default");
    const task = await createTask(ctx, p.id, { name: "skills", assigneeAgentId: agent.id });
    const { session } = await runScriptedSession(ctx, {
      projectId: p.id,
      agentId: agent.id,
      taskId: task.id,
      script: [{ kind: "tool", tool: "tasks.set_status", args: { status: "done" } }],
    });
    const slugs = (session.manifest.agent.skills as { slug: string }[]).map((s) => s.slug);
    expect(slugs).toContain("my-skill");
    // And the pulled YAML still carries the skill on the agent.
    const pulled = await pull(p.id);
    expect(pulled.agents.default?.skills).toEqual(["my-skill"]);
  });
});
