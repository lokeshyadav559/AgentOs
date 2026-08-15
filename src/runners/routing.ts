/**
 * Runner routing (§16, extended with DeepSeek BYOK).
 *
 * | Signal | Where it runs |
 * |---|---|
 * | Control plane `busy` | prefer `local` if a local runner is healthy |
 * | `runnerPreference = local` | local runner only |
 * | model `deepseek-*` (workers) | DeepSeek cloud (BYOK `DEEPSEEK_API_KEY`) |
 * | otherwise (planners) | Claude cloud (`ANTHROPIC_API_KEY`) |
 * | Per-goal override | wins over default |
 *
 * When a cloud backend is requested but its key is absent, we fall back to
 * the simulated engine and LABEL the session accordingly (demo/test mode) —
 * the recorded `runner` field keeps the requested kind.
 */
import type { Runner } from "./types.js";
import type { GoalRunnerPreference, RunnerPreference, RunnerKind } from "../domain/types.js";
import { CloudClaudeRunner } from "./cloud.js";
import { LocalVmRunner } from "./local.js";
import { SimulatedRunner } from "./simulated.js";
import { DeepseekRunner } from "./deepseek.js";
import { isDeepseekModel } from "./models.js";

export interface RunnerChoice {
  /** Recorded runner kind: cloud | local | deepseek. */
  kind: RunnerKind;
  /** The backend that will actually execute. */
  runner: Runner;
  /** Human-readable note (e.g. simulated fallback). */
  note: string;
}

export function chooseRunner(opts: {
  agentPreference: RunnerPreference;
  goalPreference?: GoalRunnerPreference | null;
  cloudBusy?: boolean;
  model: string;
  anthropicApiKey?: string;
  deepseekApiKey?: string;
  deepseekBaseUrl?: string;
  localMode?: "inprocess" | "worker";
}): RunnerChoice {
  const {
    agentPreference,
    goalPreference,
    cloudBusy = false,
    model,
    anthropicApiKey,
    deepseekApiKey,
    deepseekBaseUrl,
    localMode = "inprocess",
  } = opts;

  // Per-goal override wins (§16).
  const effective: RunnerPreference | GoalRunnerPreference =
    goalPreference === "local" || goalPreference === "cloud"
      ? goalPreference
      : goalPreference === "auto"
        ? agentPreference === "inherit" ? "cloud" : agentPreference
        : agentPreference === "inherit"
          ? "cloud"
          : agentPreference;

  if (effective === "local") {
    return {
      kind: "local",
      runner: new LocalVmRunner(localMode),
      note: "routed local (preference)",
    };
  }

  // Cloud routing is model-driven.
  if (isDeepseekModel(model)) {
    if (deepseekApiKey) {
      return {
        kind: "deepseek",
        runner: new DeepseekRunner({ apiKey: deepseekApiKey, baseUrl: deepseekBaseUrl }),
        note: "routed deepseek (BYOK)",
      };
    }
    return {
      kind: "deepseek",
      runner: new SimulatedRunner(),
      note: `deepseek model "${model}" but no DEEPSEEK_API_KEY — simulated stand-in (labeled)`,
    };
  }

  // Claude / default.
  if (anthropicApiKey) {
    return {
      kind: "cloud",
      runner: new CloudClaudeRunner(),
      note: cloudBusy ? "routed cloud (busy policy prefers local; cloud used)" : "routed cloud",
    };
  }
  return {
    kind: "cloud",
    runner: new SimulatedRunner(),
    note: "cloud requested but no ANTHROPIC_API_KEY — simulated stand-in (labeled)",
  };
}
