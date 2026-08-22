"""
Cloud runner (Claude Agent SDK via Strands Agents). Port of src/runners/cloud.ts.
Falls back to SimulatedRunner when ANTHROPIC_API_KEY is absent.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any

from agentos.mcp.index import servers_for_manifest
from agentos.runners.base import Runner, RunnerHandle, SessionOutcome


class _CloudHandle(RunnerHandle):
    def __init__(self) -> None:
        self._done_fut: asyncio.Future[SessionOutcome] = asyncio.get_event_loop().create_future()
        self._runtime: Any = None

    @property
    def done(self):
        return self._done_fut

    async def inject_reply(self, answer: dict) -> None:
        if self._runtime:
            self._runtime.inject_answer(answer)

    async def destroy(self) -> None:
        if self._runtime:
            self._runtime.cancel_wait()


class CloudClaudeRunner(Runner):
    """
    Runs agent sessions via the Anthropic Strands Agents SDK.
    The MCP servers are exposed as in-process tools through a custom tool adapter.
    """
    kind = "cloud"

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    async def provision(self, *, session_id: str, manifest: Any, runtime: Any,
                        cwd: str, script: Any = None) -> _CloudHandle:
        handle = _CloudHandle()
        handle._runtime = runtime
        asyncio.ensure_future(self._run(handle, session_id, manifest, runtime, cwd))
        return handle

    async def _run(self, handle: _CloudHandle, session_id: str, manifest: Any,
                    runtime: Any, cwd: str) -> None:
        try:
            outcome = await self._invoke_agent(session_id, manifest, runtime, cwd)
            if not handle._done_fut.done():
                handle._done_fut.set_result(outcome)
        except Exception as e:
            if not handle._done_fut.done():
                handle._done_fut.set_result(SessionOutcome(
                    status="failed", summary=None, cost_usd=None,
                    commit_shas=[], error=str(e),
                ))

    async def _invoke_agent(self, session_id: str, manifest: Any, runtime: Any, cwd: str) -> SessionOutcome:
        import os
        os.environ["ANTHROPIC_API_KEY"] = self._api_key

        from strands import Agent, tool  # type: ignore[import-untyped]

        servers = servers_for_manifest(manifest.mcpConnections)
        tools = _build_strands_tools(servers, runtime, session_id)

        system_prompt = (
            f"{manifest.agent.foundationalPrompt}\n\n{manifest.agent.rolePrompt}"
        )
        if manifest.agent.skills:
            skill_text = "\n\n".join(
                s["body"] for s in manifest.agent.skills if s.get("body")
            )
            if skill_text:
                system_prompt += f"\n\n## Skills\n{skill_text}"

        task_prompt = ""
        if manifest.task:
            task_prompt = (
                f"## Current Task\nName: {manifest.task.name}\n"
                f"Description: {manifest.task.description}"
            )
        elif manifest.goal:
            task_prompt = (
                f"## Goal\nTitle: {manifest.goal.title}\nSpec: {manifest.goal.spec}\n"
                f"Progress so far:\n{manifest.goal.progressLog or '(none)'}"
            )

        agent = Agent(
            model=manifest.agent.model,
            system_prompt=system_prompt,
            tools=tools,
        )

        # Run in thread pool to avoid blocking event loop
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, lambda: agent(task_prompt))

        cost = None
        if hasattr(result, "metrics") and result.metrics:
            m = result.metrics
            input_t = getattr(m, "input_tokens", 0) or 0
            output_t = getattr(m, "output_tokens", 0) or 0
            cost = round((input_t * 15 + output_t * 75) / 1_000_000, 6)  # claude-opus-4 approx

        return SessionOutcome(
            status="ok",
            summary=str(result)[:500] if result else "done",
            cost_usd=cost,
            commit_shas=[],
        )


def _build_strands_tools(servers, runtime, session_id: str):
    """Convert McpServer tools into Strands @tool functions."""
    from strands import tool as strands_tool  # type: ignore[import-untyped]
    tools = []
    for server in servers:
        for mcp_tool in server.tools:
            # Capture in closure
            async def _call(args: dict, _s=server, _t=mcp_tool) -> str:
                try:
                    result = await _s.call(runtime, _t.name, args)
                    return json.dumps(result)
                except Exception as e:
                    return json.dumps({"error": str(e)})

            # Strands requires synchronous functions; wrap with asyncio.run
            import functools
            def make_tool(name, desc, call_fn):
                @strands_tool
                def t(args: dict = None) -> str:  # type: ignore[misc]
                    return asyncio.get_event_loop().run_until_complete(call_fn(args or {}))
                t.__name__ = name.replace(".", "_")
                t.__doc__ = desc
                return t

            tools.append(make_tool(mcp_tool.name, mcp_tool.description, _call))
    return tools
