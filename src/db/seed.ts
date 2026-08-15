/**
 * Seed script: creates a demo project with everything wired so the UI has
 * something to show: the default catalog, a feature-template task, a goal,
 * a trigger, and an automation.
 *
 *   pnpm run seed   (against a fresh data dir, or after starting the server)
 *
 * The script talks to a running control plane via its operator token.
 */
import { automations } from "./schema.js";
import { loadConfig } from "../config.js";
import { openMigratedDb } from "../db/client.js";
import { ProjectService } from "../services/projects.js";
import { TaskService } from "../services/tasks.js";
import { FileService } from "../services/files.js";
import { GoalService } from "../services/goals.js";
import { InboxService } from "../services/inbox.js";
import { SessionService } from "../services/sessions.js";
import { ActivityService } from "../services/activity.js";
import { PushService } from "../services/push.js";
import { SecretService } from "../services/secrets.js";
import { SchedulerService } from "../services/scheduler.js";
import { TriggerService } from "../services/triggers.js";
import type { Services } from "../services/registry.js";

export async function main(): Promise<void> {
  const config = loadConfig();
  const db = openMigratedDb(config);
  const services: Services = {
    db,
    config,
    projects: new ProjectService(db),
    tasks: new TaskService(db),
    files: new FileService(db, config),
    goals: new GoalService(db),
    inbox: new InboxService(db),
    activity: new ActivityService(db),
    push: new PushService(db, config),
    secrets: new SecretService(db, config.secret),
    sessions: undefined as unknown as SessionService,
    scheduler: undefined as unknown as SchedulerService,
    triggers: undefined as unknown as TriggerService,
  };
  services.scheduler = new SchedulerService(db, services, undefined, 1000);
  services.sessions = new SessionService(db, config, services);
  services.triggers = new TriggerService(db, services);

  const existing = await services.projects.list();
  if (existing.some((p) => p.slug === "demo")) {
    console.log("demo project already exists — delete ./data to reseed");
    return;
  }

  const demo = await services.projects.create({ name: "demo" });
  console.log(`project: ${demo.name} (${demo.id})`);

  const agentByName = new Map(
    (await db.query.agents.findMany({ where: (t, { eq }) => eq(t.projectId, demo.id) })).map((a) => [a.name, a]),
  );
  const defaultAgent = agentByName.get("default")!;
  const linkedinAgent = agentByName.get("linkedin-content")!;

  // 1) A feature-template task (spec → plan → … → human merge).
  const tpl = (
    await db.query.taskTemplates.findMany({ where: (t, { eq }) => eq(t.projectId, demo.id) })
  ).find((t) => t.name === "compound-engineer-workflow")!;
  const chain = await services.tasks.instantiateTemplate(demo.id, tpl.id, {
    branchName: "feat/dark-mode",
    featureTitle: "Dark mode",
  });
  console.log(`template instantiated → ${chain.length} tasks (step 1: "${chain[0]!.name}", approval-gated)`);

  // 2) A simple immediate task for the default agent.
  await services.tasks.create(demo.id, {
    name: "Update onboarding docs",
    description: "Refresh the README onboarding section with the new CLI flags.",
    assigneeAgentId: defaultAgent.id,
  });
  console.log("task: Update onboarding docs (runs immediately)");

  // 3) A goal with a 2-item DoD (approve in the UI to start the loop).
  const goal = await services.goals.create({
    projectId: demo.id,
    title: "Improve error messages",
    spec: "Make runtime errors actionable.\n- Errors include the failing operation\n- Errors suggest the next step",
    spendCapUsd: 5,
  });
  console.log(`goal: "${goal.title}" (${goal.definitionOfDone.length} DoD items — approve in the UI to start)`);

  // 4) A support-inbound trigger (HMAC-signed webhook).
  const trigger = await services.triggers.create({
    projectId: demo.id,
    name: "support-inbound",
    agentId: agentByName.get("customer-support")!.id,
    jobPrompt: "Support conversation:\n{{payload}}",
  });
  console.log(`trigger: support-inbound → POST /hooks/${trigger.id}`);
  console.log(`  signature: x-agentos-signature = sha256 hmac of the raw body with secret ${trigger.webhookSecret}`);

  // 5) A weekly automation.
  await db
    .insert(automations)
    .values({
      id: crypto.randomUUID(),
      projectId: demo.id,
      name: "weekly-linkedin",
      cron: "0 9 * * 1",
      timezone: "UTC",
      agentId: linkedinAgent.id,
      taskTemplateId: null,
      taskBody: "Draft this week's LinkedIn post.",
    })
    .run();
  console.log("automation: weekly-linkedin (Mon 09:00 UTC)");

  // Kick the scheduler once so immediate tasks start immediately.
  await services.scheduler.tick();
  console.log("\nseeded — open the UI, approve the goal's DoD, and watch the loop.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
