/**
 * DeepSeek BYOK migration — point existing worker agents at DeepSeek.
 *
 *   pnpm run migrate:deepseek     (default data dir, or AGENTOS_DATA_DIR=…)
 *
 * The default worker model was the Grok/local placeholder ("grok-4.6" +
 * runnerPreference "local"). Workers now use DeepSeek by default:
 * - model "grok-4.6" → "deepseek-chat"
 * - runnerPreference "local" → "inherit" (so model-driven routing reaches
 *   the DeepSeek backend; explicit local preference still wins elsewhere)
 *
 * Idempotent; only touches agents that still carry the placeholder model.
 */
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { openMigratedDb } from "../db/client.js";
import { agents } from "../db/schema.js";

const PLACEHOLDER_MODEL = "grok-4.6";
const DEEPSEEK_WORKER_MODEL = "deepseek-chat";

export async function main(): Promise<void> {
  const config = loadConfig();
  const db = openMigratedDb(config);

  const rows = await db.select().from(agents).all();
  let modelChanged = 0;
  let runnerChanged = 0;

  for (const a of rows) {
    if (a.model !== PLACEHOLDER_MODEL) continue;
    const patch: Partial<typeof a> = { model: DEEPSEEK_WORKER_MODEL };
    modelChanged++;
    if (a.runnerPreference === "local") {
      patch.runnerPreference = "inherit";
      runnerChanged++;
    }
    await db.update(agents).set(patch).where(eq(agents.id, a.id)).run();
    console.log(`agent: ${a.name} → model ${a.model} → ${DEEPSEEK_WORKER_MODEL}${patch.runnerPreference ? " · runner local → inherit" : ""}`);
  }

  console.log(`\ndone — ${modelChanged} worker agent(s) repointed to DeepSeek (${runnerChanged} runner preference(s) updated).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
