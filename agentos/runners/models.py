"""
Model → provider mapping. Port of src/runners/models.ts.
"""

DEFAULT_MODELS = {
    "planner": "claude-opus-4",
    "worker": "deepseek-chat",
}

DEEPSEEK_PRICES: dict[str, dict[str, float]] = {
    "deepseek-chat": {"input": 0.27, "output": 1.1},
    "deepseek-reasoner": {"input": 0.55, "output": 2.19},
}


def is_deepseek_model(model: str) -> bool:
    return model.lower().startswith("deepseek")


def estimate_deepseek_cost(model: str, prompt_tokens: int, completion_tokens: int) -> float | None:
    price = DEEPSEEK_PRICES.get(model.lower()) or DEEPSEEK_PRICES.get("deepseek-chat")
    if not price:
        return None
    cost = (prompt_tokens * price["input"] + completion_tokens * price["output"]) / 1_000_000
    return round(cost, 6)
