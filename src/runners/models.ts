/**
 * Model → provider mapping (§16, extended with DeepSeek BYOK).
 *
 * Cloud routing is model-driven: an agent whose model name is a DeepSeek
 * model runs on the DeepSeek backend (bring-your-own DEEPSEEK_API_KEY);
 * everything else runs on the Claude Agent SDK backend. Worker agents use
 * DeepSeek by default (replacing the blueprint's Grok/local placeholder).
 */

/** Default agent models (blueprint §3/§8 anecdotes, revised). */
export const DEFAULT_MODELS = {
  planner: "claude-opus-4",
  worker: "deepseek-chat",
} as const;

/** DeepSeek models we know how to price (USD per 1M tokens, approximate). */
export const DEEPSEEK_PRICES: Record<string, { input: number; output: number }> = {
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
};

/** True when the model name belongs to the DeepSeek provider. */
export function isDeepseekModel(model: string): boolean {
  return model.toLowerCase().startsWith("deepseek");
}

/** Cost estimate from DeepSeek token usage; null when unknown. */
export function estimateDeepseekCost(
  model: string,
  usage: { promptTokens: number; completionTokens: number },
): number | null {
  const price = DEEPSEEK_PRICES[model.toLowerCase()] ?? DEEPSEEK_PRICES["deepseek-chat"];
  if (!price) return null;
  const cost = (usage.promptTokens * price.input + usage.completionTokens * price.output) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}
