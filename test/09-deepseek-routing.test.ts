/**
 * DeepSeek BYOK routing (§16 extension).
 */
import { describe, it, expect } from "vitest";
import { chooseRunner } from "../src/runners/routing.js";
import { DeepseekRunner } from "../src/runners/deepseek.js";
import { CloudClaudeRunner } from "../src/runners/cloud.js";
import { SimulatedRunner } from "../src/runners/simulated.js";
import { LocalVmRunner } from "../src/runners/local.js";

const base = {
  agentPreference: "inherit" as const,
  goalPreference: null,
  cloudBusy: false,
};

describe("DeepSeek BYOK routing", () => {
  it("routes deepseek-* models to the DeepSeek runner when a key is present", () => {
    const c = chooseRunner({ ...base, model: "deepseek-chat", deepseekApiKey: "sk-test" });
    expect(c.kind).toBe("deepseek");
    expect(c.runner).toBeInstanceOf(DeepseekRunner);
  });

  it("falls back to simulated (labeled) for deepseek models without a key", () => {
    const c = chooseRunner({ ...base, model: "deepseek-reasoner" });
    expect(c.kind).toBe("deepseek");
    expect(c.runner).toBeInstanceOf(SimulatedRunner);
    expect(c.note).toContain("DEEPSEEK_API_KEY");
  });

  it("still routes non-deepseek models to Claude cloud", () => {
    const c = chooseRunner({ ...base, model: "claude-opus-4", anthropicApiKey: "sk-ant" });
    expect(c.kind).toBe("cloud");
    expect(c.runner).toBeInstanceOf(CloudClaudeRunner);
  });

  it("keeps Claude models on the simulated fallback when no anthropic key", () => {
    const c = chooseRunner({ ...base, model: "claude-opus-4", deepseekApiKey: "sk-test" });
    expect(c.kind).toBe("cloud");
    expect(c.runner).toBeInstanceOf(SimulatedRunner);
    expect(c.note).toContain("ANTHROPIC_API_KEY");
  });

  it("local preference still wins over model-driven cloud routing", () => {
    const c = chooseRunner({ ...base, agentPreference: "local", model: "deepseek-chat", deepseekApiKey: "sk-test" });
    expect(c.kind).toBe("local");
    expect(c.runner).toBeInstanceOf(LocalVmRunner);
  });
});
