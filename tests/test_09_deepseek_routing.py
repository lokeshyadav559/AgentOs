"""
DeepSeek routing tests. Mirrors test/09-deepseek-routing.test.ts.
"""
import pytest
from agentos.runners.routing import choose_runner
from agentos.runners.simulated import SimulatedRunner
from agentos.runners.models import is_deepseek_model, estimate_deepseek_cost


def test_is_deepseek_model():
    assert is_deepseek_model("deepseek-chat")
    assert is_deepseek_model("deepseek-reasoner")
    assert not is_deepseek_model("claude-opus-4")


def test_deepseek_routing_with_key():
    choice = choose_runner(
        agent_preference="inherit",
        model="deepseek-chat",
        deepseek_api_key="sk-test",
    )
    assert choice["kind"] == "deepseek"
    from agentos.runners.deepseek import DeepSeekRunner
    assert isinstance(choice["runner"], DeepSeekRunner)


def test_deepseek_routing_no_key_falls_back_to_simulated():
    choice = choose_runner(
        agent_preference="inherit",
        model="deepseek-chat",
        deepseek_api_key=None,
    )
    assert choice["kind"] == "deepseek"
    assert isinstance(choice["runner"], SimulatedRunner)
    assert "simulated" in choice["note"]


def test_claude_routing_with_key():
    choice = choose_runner(
        agent_preference="inherit",
        model="claude-opus-4",
        anthropic_api_key="sk-ant-test",
    )
    assert choice["kind"] == "cloud"
    from agentos.runners.cloud import CloudClaudeRunner
    assert isinstance(choice["runner"], CloudClaudeRunner)


def test_claude_routing_no_key_falls_back():
    choice = choose_runner(
        agent_preference="inherit",
        model="claude-opus-4",
        anthropic_api_key=None,
    )
    assert choice["kind"] == "cloud"
    assert isinstance(choice["runner"], SimulatedRunner)


def test_cost_estimation():
    cost = estimate_deepseek_cost("deepseek-chat", 1_000_000, 1_000_000)
    assert cost is not None
    assert cost > 0


def test_local_preference():
    choice = choose_runner(agent_preference="local", model="deepseek-chat")
    assert choice["kind"] == "local"
