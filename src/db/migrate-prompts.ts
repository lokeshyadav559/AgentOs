/**
 * Prompt migration — upgrade existing projects' agents to the refactored,
 * DeepSeek-Harness-style prompts WITHOUT losing project data.
 *
 *   pnpm run migrate:prompts     (default data dir, or AGENTOS_DATA_DIR=…)
 *
 * The refactor changed the prompt *constants*; projects seeded before it
 * keep the old prompt strings in the DB. This script rewrites, in place:
 *
 * - strips the legacy reconstruction label from every stored agent prompt
 *   and template step prompt (the label is a docs/code matter, never
 *   agent-facing text);
 * - every agent whose foundational prompt is the old shared AgentOS prompt
 *   → the new structured FOUNDATIONAL_PROMPT;
 * - every agent whose role prompt is an old-style default ("You …") and
 *   whose name is a known default → the new structured role contract;
 *   custom agents keep their role prompt;
 * - the plan-mode skill body (old one-liner → full plan-mode rules);
 * - compound-engineer-workflow step prompts still in old one-line-brief
 *   form → the new briefs (steps that already carry "Deliverable:" are
 *   left alone).
 *
 * Idempotent: re-running changes nothing.
 */
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { openMigratedDb } from "../db/client.js";
import { agents, skills, taskTemplates } from "../db/schema.js";
import type { TemplateStep } from "../domain/types.js";
import {
  FOUNDATIONAL_PROMPT,
  ROLE_PROMPTS,
  RECONSTRUCTED_NOTICE,
  PLAN_MODE_SKILL_BODY,
} from "../prompts/prompts.js";
import { compoundEngineerSteps } from "../domain/defaults.js";

/** Old foundational prompts all opened with this line. */
const OLD_FOUNDATIONAL_SIGNATURE = "You are running inside AgentOS.";
/** Old default role prompts were the notice followed by "You …". */
const OLD_ROLE_SIGNATURE = `${RECONSTRUCTED_NOTICE}\n\nYou `;
/** Old plan-mode skill body (one-liner). */
const OLD_PLAN_MODE_BODY = "/plan — enter plan mode and produce an ordered implementation plan.";

/** Strip the legacy label prefix if present; returns [text, stripped]. */
function stripNotice(text: string): [string, boolean] {
  if (text.startsWith(RECONSTRUCTED_NOTICE)) {
    return [text.slice(RECONSTRUCTED_NOTICE.length).replace(/^\n+/, ""), true];
  }
  return [text, false];
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const db = openMigratedDb(config);

  const stats = {
    noticeStripped: 0,
    foundational: 0,
    role: 0,
    skills: 0,
    templateSteps: 0,
  };

  // --- Agents ----------------------------------------------------------------
  const rows = await db.select().from(agents).all();
  for (const a of rows) {
    const [foundational, fStripped] = stripNotice(a.foundationalPrompt);
    const [role, rStripped] = stripNotice(a.rolePrompt);
    const patch: Partial<typeof a> = {};
    let changed = false;

    if (foundational.includes(OLD_FOUNDATIONAL_SIGNATURE)) {
      patch.foundationalPrompt = FOUNDATIONAL_PROMPT;
      stats.foundational++;
      changed = true;
    } else if (fStripped) {
      patch.foundationalPrompt = foundational;
      changed = true;
    }

    const freshRole = ROLE_PROMPTS[a.name];
    if (freshRole && role.startsWith("You ")) {
      patch.rolePrompt = freshRole;
      stats.role++;
      changed = true;
    } else if (rStripped) {
      patch.rolePrompt = role;
      changed = true;
    }

    if (fStripped || rStripped) stats.noticeStripped++;
    if (changed) {
      await db.update(agents).set(patch).where(eq(agents.id, a.id)).run();
      console.log(
        `agent: ${a.name} → ${patch.foundationalPrompt ? "foundational" : ""}${patch.rolePrompt ? " + role" : ""}${fStripped || rStripped ? " (label stripped)" : ""}`,
      );
    }
  }

  // --- Plan-mode skill --------------------------------------------------------
  const skillRows = await db.select().from(skills).all();
  for (const s of skillRows) {
    if (s.slug === "plan-mode" && s.body === OLD_PLAN_MODE_BODY) {
      await db.update(skills).set({ body: PLAN_MODE_SKILL_BODY }).where(eq(skills.id, s.id)).run();
      stats.skills++;
      console.log("skill: plan-mode → full plan-mode rules");
    }
  }

  // --- Template step prompts (all templates) ----------------------------------
  const freshSteps = compoundEngineerSteps();
  const tplRows = await db.select().from(taskTemplates).all();
  for (const t of tplRows) {
    const steps: TemplateStep[] = Array.isArray(t.steps) ? t.steps : [];
    let touched = 0;
    let stripped = 0;
    const updated = steps.map((s) => {
      const [prompt, hadNotice] = stripNotice(s.prompt);
      if (hadNotice) stripped++;
      const fresh = t.name === "compound-engineer-workflow" ? freshSteps.find((f) => f.name === s.name) : undefined;
      // Only replace prompts that still look like old one-line briefs:
      // new briefs (and user edits that kept "Deliverable:") are kept.
      if (fresh && prompt !== fresh.prompt && !prompt.includes("Deliverable:")) {
        touched++;
        return { ...s, prompt: fresh.prompt };
      }
      if (hadNotice) return { ...s, prompt };
      return s;
    });
    if (touched > 0 || stripped > 0) {
      await db.update(taskTemplates).set({ steps: updated }).where(eq(taskTemplates.id, t.id)).run();
      stats.templateSteps += touched;
      stats.noticeStripped += stripped;
      console.log(`template: ${t.name} → ${touched} step prompt(s) refreshed, ${stripped} label(s) stripped`);
    }
  }

  console.log(
    `\ndone — ${stats.noticeStripped} label(s) stripped, ${stats.foundational} foundational, ` +
      `${stats.role} role, ${stats.skills} skill, ${stats.templateSteps} template step prompt(s) updated.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
