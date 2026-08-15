/**
 * Agent scripts for the simulated runner.
 *
 * The SimulatedRunner executes a deterministic script of MCP tool calls
 * through the SAME in-process MCP servers a real model would use, so ACL
 * enforcement is exercised identically. Default scripts per agent make the
 * system demoable without an API key; tests may inject explicit scripts.
 */
import type { SessionManifest } from "../domain/types.js";

export type ScriptStep =
  | { kind: "tool"; tool: string; args: Record<string, unknown> }
  | { kind: "ask"; body: string; choices: string[]; onReply: Record<string, ScriptStep[]>; default?: ScriptStep[] }
  | { kind: "send"; body: string; then?: ScriptStep[] }
  | { kind: "wait"; ms: number };

export type AgentScript = ScriptStep[];

const home = (agent: string) => `/agents/${agent}`;
const goalFolder = (goalId: string) => `/goals/${goalId}`;

/** Steps to finish a task: review + inbox note when gated, done otherwise. */
export function finishSteps(manifest: SessionManifest, note: string): ScriptStep[] {
  if (manifest.task?.approvalGate) {
    return [
      { kind: "tool", tool: "tasks.set_status", args: { status: "review" } },
      { kind: "send", body: `${note} (task is approval-gated — awaiting your review.)` },
    ];
  }
  return [{ kind: "tool", tool: "tasks.set_status", args: { status: "done" } }];
}

/**
 * Build the default script for a session's agent + context.
 * `goalDoDItem` is the first unsatisfied DoD item text for goal sessions,
 * injected by the session service so the deterministic engine's progress
 * log delta lets the orchestrator mark the item satisfied (§11.6).
 */
export function defaultScriptFor(
  manifest: SessionManifest,
  goalDoDItem?: string,
): AgentScript {
  const agent = manifest.agent.name;
  const task = manifest.task;
  const goal = manifest.goal;
  const h = home(agent);
  const stamp = String(Date.now()).slice(-6);
  const taskTag = task ? task.id.slice(0, 8) : "no-task";

  if (goal && !task) {
    const steps: AgentScript = [
      { kind: "tool", tool: "goals.append_progress", args: { entry: `[${agent}] started iteration for "${goal.title}"` } },
      { kind: "wait", ms: 40 },
      {
        kind: "tool",
        tool: "fs.write",
        args: { path: `${goalFolder(goal.id)}/note-${stamp}.md`, content: `Work note from ${agent} on ${goal.title} (${new Date().toISOString()})` },
      },
    ];
    if (goalDoDItem) {
      // Explicit, verified completion: mark exactly this DoD item done.
      steps.push({
        kind: "tool",
        tool: "goals.complete_dod_item",
        args: { item: goalDoDItem },
      });
      steps.push({
        kind: "tool",
        tool: "goals.append_progress",
        args: { entry: `[${agent}] completed and verified a definition-of-done item: ${goalDoDItem}` },
      });
    } else {
      steps.push({
        kind: "tool",
        tool: "goals.append_progress",
        args: { entry: `[${agent}] finished iteration (no outstanding DoD item supplied)` },
      });
    }
    return steps;
  }

  switch (agent) {
    case "spec":
      return specScript(manifest, h, taskTag);
    case "plan":
      return [
        { kind: "tool", tool: "tasks.set_status", args: { status: "doing" } },
        { kind: "wait", ms: 60 },
        {
          kind: "tool",
          tool: "fs.write",
          args: { path: `${h}/plan-${taskTag}.md`, content: `# Implementation plan for "${task?.name}"\n\n1. Scaffold\n2. Implement\n3. Test\n4. Ship` },
        },
        { kind: "tool", tool: "tasks.attach", args: { filePath: `${h}/plan-${taskTag}.md` } },
        { kind: "tool", tool: "tasks.append_activity", args: { message: "Plan written and attached." } },
        ...finishSteps(manifest, "Plan ready"),
      ];
    case "review-coordinator":
      return coordinatorScript(manifest, h, taskTag);
    case "feasibility":
    case "scope-guardian":
    case "coherence":
    case "plan-risk":
      return [
        { kind: "tool", tool: "tasks.set_status", args: { status: "doing" } },
        { kind: "wait", ms: 40 },
        {
          kind: "tool",
          tool: "fs.write",
          args: { path: `${h}/report-${taskTag}.md`, content: `# ${agent} report for "${task?.name}"\n\nNo must-fix issues. Minor notes only.` },
        },
        { kind: "tool", tool: "tasks.attach", args: { filePath: `${h}/report-${taskTag}.md` } },
        ...finishSteps(manifest, `${agent} report attached`),
      ];
    case "implementation-plan-executioner":
    case "senior-dev":
      return [
        { kind: "tool", tool: "tasks.set_status", args: { status: "doing" } },
        { kind: "wait", ms: 80 },
        {
          kind: "tool",
          tool: "fs.write",
          args: { path: `${h}/work-${taskTag}.md`, content: `# Implementation log for "${task?.name}"\n\nImplemented per plan. E2E checks pass. Committed.` },
        },
        { kind: "tool", tool: "tasks.append_activity", args: { message: "Implemented; tests pass." } },
        ...finishSteps(manifest, "Implementation complete"),
      ];
    case "librarian":
      return [
        { kind: "tool", tool: "tasks.set_status", args: { status: "doing" } },
        { kind: "wait", ms: 40 },
        {
          kind: "tool",
          tool: "fs.write",
          args: { path: `/wiki/${taskTag}.md`, content: `# Wiki: how the codebase works now (after "${task?.name}")` },
        },
        ...finishSteps(manifest, "Wiki updated"),
      ];
    case "customer-support":
      // No r2-fs on purpose (§5.3: the support agent gets Front only) — the
      // script must not touch the filesystem.
      return [
        { kind: "tool", tool: "tasks.set_status", args: { status: "doing" } },
        { kind: "tool", tool: "front.list_conversations", args: {} },
        { kind: "tool", tool: "front.read_conversation", args: { id: "demo-support-1" } },
        { kind: "wait", ms: 40 },
        ...finishSteps(manifest, "Support conversation assigned (billing team rep)"),
      ];
    case "diagnostic":
      return [
        { kind: "tool", tool: "tasks.set_status", args: { status: "doing" } },
        { kind: "wait", ms: 60 },
        {
          kind: "tool",
          tool: "fs.write",
          args: { path: `${h}/cause-report-${taskTag}.md`, content: "# Cause report\n\nRoot cause: missing validation on the webhook payload path. No implementation performed." },
        },
        { kind: "tool", tool: "tasks.attach", args: { filePath: `${h}/cause-report-${taskTag}.md` } },
        { kind: "send", body: "Diagnosis complete — cause report attached. Approve to start the fix chain." },
        { kind: "tool", tool: "tasks.set_status", args: { status: "review" } },
      ];
    case "linkedin-content":
      return [
        { kind: "tool", tool: "tasks.set_status", args: { status: "doing" } },
        { kind: "wait", ms: 40 },
        {
          kind: "tool",
          tool: "fs.write",
          args: { path: `${h}/linkedin-${taskTag}.md`, content: "# LinkedIn post (draft)\n\nDraft content for the scheduled post. Awaiting posting approval." },
        },
        ...finishSteps(manifest, "Content drafted"),
      ];
    default:
      // "default" workhorse
      return [
        { kind: "tool", tool: "tasks.set_status", args: { status: "doing" } },
        { kind: "wait", ms: 60 },
        {
          kind: "tool",
          tool: "fs.write",
          args: { path: `${h}/result-${taskTag}.md`, content: `# Result for "${task?.name}"\n\nDone by ${agent}.` },
        },
        { kind: "tool", tool: "tasks.append_activity", args: { message: "Work complete." } },
        ...finishSteps(manifest, "Task complete"),
      ];
  }
}

function specScript(manifest: SessionManifest, h: string, taskTag: string): AgentScript {
  const specPath = `${h}/spec-${taskTag}.md`;
  const steps: AgentScript = [
    { kind: "tool", tool: "tasks.set_status", args: { status: "doing" } },
    { kind: "wait", ms: 60 },
    {
      kind: "tool",
      tool: "fs.write",
      args: {
        path: specPath,
        content: `# Specification: ${manifest.task?.name}\n\n## Context\n${manifest.task?.description}\n\n## Requirements\n1. Feature works end-to-end\n2. Tests included\n3. No scope creep`,
      },
    },
    { kind: "tool", tool: "tasks.attach", args: { filePath: specPath } },
    { kind: "tool", tool: "tasks.append_activity", args: { message: "Spec attached; waiting for human approval." } },
  ];
  // One refinement round: ask → if changes requested, revise once and ask again.
  const ask = (round: number): ScriptStep => ({
    kind: "ask",
    body: `Spec ready for review (round ${round}). Approve it?`,
    choices: ["Approve", "Request changes"],
    onReply: {
      c0: [...finishSteps(manifest, "Spec approved by human")],
      c1: [
        { kind: "tool", tool: "fs.write", args: { path: specPath, content: `# Specification: ${manifest.task?.name} (revised)\n\n## Context\n${manifest.task?.description}\n\n## Requirements (revised)\n1. Feature works end-to-end\n2. Tests included\n3. Explicit out-of-scope list` } },
        { kind: "tool", tool: "tasks.append_activity", args: { message: "Spec revised after human feedback." } },
        ...(round < 2 ? [ask(round + 1)] : finishSteps(manifest, "Spec finalized")),
      ],
    },
  });
  steps.push(ask(1));
  return steps;
}

function coordinatorScript(manifest: SessionManifest, h: string, taskTag: string): AgentScript {
  const reviewers =
    manifest.agent.name === "review-coordinator"
      ? ["feasibility", "scope-guardian", "coherence", "plan-risk"]
      : [];
  const steps: AgentScript = [
    { kind: "tool", tool: "tasks.set_status", args: { status: "doing" } },
    ...reviewers.map(
      (r) =>
        ({
          kind: "tool",
          tool: "collaborators.spawn",
          args: { agentName: r, brief: `Review "${manifest.task?.name}" (${taskTag}) through your lens; write a report.` },
        }) as ScriptStep,
    ),
    { kind: "wait", ms: 60 },
    {
      kind: "tool",
      tool: "fs.write",
      args: {
        path: `${h}/consolidated-${taskTag}.md`,
        content: `# Consolidated review for "${manifest.task?.name}"\n\nMust-fix:\n- (none blocking)\n\nShould-fix:\n- Add missing edge-case tests`,
      },
    },
    { kind: "tool", tool: "tasks.attach", args: { filePath: `${h}/consolidated-${taskTag}.md` } },
    ...finishSteps(manifest, "Consolidated review attached"),
  ];
  return steps;
}
