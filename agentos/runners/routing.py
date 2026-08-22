"""
Runner routing. Port of src/runners/routing.ts.
Model-driven: deepseek-* → DeepSeekRunner, else → CloudClaudeRunner.
Falls back to SimulatedRunner when the required API key is absent.
"""
from __future__ import annotations

from agentos.runners.models import is_deepseek_model


def choose_runner(
    *,
    agent_preference: str,
    goal_preference: str | None = None,
    cloud_busy: bool = False,
    model: str,
    anthropic_api_key: str | None = None,
    deepseek_api_key: str | None = None,
    deepseek_base_url: str = "https://api.deepseek.com",
    local_mode: str = "inprocess",
) -> dict:
    """
    Returns {"kind": RunnerKind, "runner": Runner, "note": str}.
    """
    from agentos.runners.cloud import CloudClaudeRunner
    from agentos.runners.deepseek import DeepSeekRunner
    from agentos.runners.simulated import SimulatedRunner

    # Effective preference: goal overrides agent; "auto"/"inherit" → cloud
    effective = goal_preference if goal_preference in ("local", "cloud") else (
        agent_preference if agent_preference != "inherit" else "cloud"
    )

    if effective == "local":
        # ponytail: local VM runner not yet implemented — simulated stand-in
        return {
            "kind": "local",
            "runner": SimulatedRunner(),
            "note": "local runner requested — simulated stand-in (not yet implemented)",
        }

    if is_deepseek_model(model):
        if deepseek_api_key:
            return {
                "kind": "deepseek",
                "runner": DeepSeekRunner(api_key=deepseek_api_key, base_url=deepseek_base_url),
                "note": "routed deepseek (BYOK)",
            }
        return {
            "kind": "deepseek",
            "runner": SimulatedRunner(),
            "note": f'deepseek model "{model}" but no DEEPSEEK_API_KEY — simulated stand-in (labeled)',
        }

    if anthropic_api_key:
        return {
            "kind": "cloud",
            "runner": CloudClaudeRunner(api_key=anthropic_api_key),
            "note": "routed cloud (Claude)",
        }
    return {
        "kind": "cloud",
        "runner": SimulatedRunner(),
        "note": "cloud requested but no ANTHROPIC_API_KEY — simulated stand-in (labeled)",
    }
