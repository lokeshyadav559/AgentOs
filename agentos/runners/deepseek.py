"""
DeepSeek runner (BYOK, OpenAI-compatible API). Port of src/runners/deepseek.ts.
Uses httpx for async HTTP; tool calls loop mirrors the TS implementation.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any

import httpx

from agentos.mcp.index import servers_for_manifest
from agentos.runners.base import Runner, RunnerHandle, SessionOutcome
from agentos.runners.models import estimate_deepseek_cost


class _DeepSeekHandle(RunnerHandle):
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


class DeepSeekRunner(Runner):
    kind = "deepseek"

    def __init__(self, api_key: str, base_url: str = "https://api.deepseek.com") -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")

    async def provision(self, *, session_id: str, manifest: Any, runtime: Any,
                        cwd: str, script: Any = None) -> _DeepSeekHandle:
        handle = _DeepSeekHandle()
        handle._runtime = runtime
        asyncio.ensure_future(self._run(handle, session_id, manifest, runtime))
        return handle

    async def _run(self, handle: _DeepSeekHandle, session_id: str,
                    manifest: Any, runtime: Any) -> None:
        try:
            outcome = await self._invoke(session_id, manifest, runtime)
            if not handle._done_fut.done():
                handle._done_fut.set_result(outcome)
        except Exception as e:
            if not handle._done_fut.done():
                handle._done_fut.set_result(SessionOutcome(
                    status="failed", summary=None, cost_usd=None,
                    commit_shas=[], error=str(e),
                ))

    async def _invoke(self, session_id: str, manifest: Any, runtime: Any) -> SessionOutcome:
        servers = servers_for_manifest(manifest.mcpConnections)
        tools_schema = _build_tools_schema(servers)

        system = f"{manifest.agent.foundationalPrompt}\n\n{manifest.agent.rolePrompt}"
        if manifest.agent.skills:
            skill_text = "\n\n".join(s["body"] for s in manifest.agent.skills if s.get("body"))
            if skill_text:
                system += f"\n\n## Skills\n{skill_text}"

        user_msg = ""
        if manifest.task:
            user_msg = f"Task: {manifest.task.name}\n{manifest.task.description}"
        elif manifest.goal:
            user_msg = (
                f"Goal: {manifest.goal.title}\n{manifest.goal.spec}\n"
                f"Progress:\n{manifest.goal.progressLog or '(none)'}"
            )

        messages = [{"role": "user", "content": user_msg}]
        total_prompt_tokens = total_completion_tokens = 0

        async with httpx.AsyncClient(timeout=120) as client:
            for _ in range(50):  # max tool-call rounds
                resp = await client.post(
                    f"{self._base_url}/v1/chat/completions",
                    headers={"Authorization": f"Bearer {self._api_key}",
                              "Content-Type": "application/json"},
                    json={
                        "model": manifest.agent.model,
                        "messages": [{"role": "system", "content": system}, *messages],
                        "tools": tools_schema if tools_schema else None,
                        "tool_choice": "auto" if tools_schema else None,
                        "max_tokens": 4096,
                    },
                )
                resp.raise_for_status()
                data = resp.json()

                usage = data.get("usage", {})
                total_prompt_tokens += usage.get("prompt_tokens", 0)
                total_completion_tokens += usage.get("completion_tokens", 0)

                choice = data["choices"][0]
                msg = choice["message"]
                messages.append(msg)

                if choice["finish_reason"] == "tool_calls":
                    for tc in msg.get("tool_calls", []):
                        fn = tc["function"]
                        ts = datetime.now(timezone.utc).isoformat()
                        try:
                            args = json.loads(fn.get("arguments", "{}"))
                        except json.JSONDecodeError:
                            args = {}
                        tool_output = None
                        tool_error = None
                        try:
                            tool_output = await _dispatch_tool(servers, runtime, fn["name"], args)
                        except Exception as e:
                            tool_error = str(e)
                        await runtime.record_tool_call({
                            "ts": ts, "name": fn["name"], "input": args,
                            "output": tool_output, "error": tool_error,
                        })
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc["id"],
                            "content": json.dumps(tool_output) if tool_output is not None else (tool_error or ""),
                        })
                    continue

                # finish_reason == "stop" or other
                summary = msg.get("content") or ""
                cost = estimate_deepseek_cost(manifest.agent.model, total_prompt_tokens, total_completion_tokens)
                return SessionOutcome(status="ok", summary=summary[:500], cost_usd=cost, commit_shas=[])

        return SessionOutcome(status="failed", summary=None, cost_usd=None,
                               commit_shas=[], error="max tool-call rounds exceeded")


def _build_tools_schema(servers) -> list[dict]:
    tools = []
    for server in servers:
        for t in server.tools:
            tools.append({
                "type": "function",
                "function": {
                    "name": t.name.replace(".", "_"),
                    "description": t.description,
                    "parameters": {"type": "object", "properties": {}, "required": []},
                },
            })
    return tools


async def _dispatch_tool(servers, runtime, name: str, args: dict) -> Any:
    # DeepSeek uses underscores; MCP uses dots
    dot_name = name.replace("_", ".", 1)
    for server in servers:
        try:
            return await server.call(runtime, dot_name, args)
        except ValueError as e:
            if "unknown tool" in str(e):
                continue
            raise
    raise ValueError(f"unknown tool {name}")
