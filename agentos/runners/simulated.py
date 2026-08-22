"""
SimulatedRunner — deterministic agent execution for tests and demo.
Port of src/runners/simulated.ts. Uses the same in-process MCP servers.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from agentos.mcp.index import servers_for_manifest
from agentos.runners.base import Runner, RunnerHandle, SessionOutcome


class _SimulatedHandle(RunnerHandle):
    def __init__(self) -> None:
        self._done: asyncio.Future[SessionOutcome] = asyncio.get_event_loop().create_future()
        self._destroyed = False
        self._runtime: Any = None

    @property
    def done(self):
        return self._done

    async def inject_reply(self, answer: dict) -> None:
        if self._runtime:
            self._runtime.inject_answer(answer)

    async def destroy(self) -> None:
        self._destroyed = True
        if self._runtime:
            self._runtime.cancel_wait()


class SimulatedRunner(Runner):
    """
    Runs a fixed script or a default tool-call sequence against the in-process
    MCP servers. Used when no API key is present (demo/test mode).
    """
    kind = "simulated"

    def __init__(self, fail_on_denied: bool = False, time_scale: float = 1.0) -> None:
        self._fail_on_denied = fail_on_denied
        self._time_scale = time_scale

    async def provision(self, *, session_id: str, manifest: Any, runtime: Any,
                        cwd: str, script: list | None = None) -> _SimulatedHandle:
        servers = servers_for_manifest(manifest.mcpConnections)
        handle = _SimulatedHandle()
        handle._runtime = runtime

        if script is None:
            # Default script: set task doing → append progress → set done
            script = _default_script(manifest)

        asyncio.ensure_future(self._run(handle, servers, runtime, session_id, manifest, script))
        return handle

    async def _run(self, handle: _SimulatedHandle, servers, runtime, session_id: str,
                    manifest, script: list) -> None:
        try:
            await self._exec_steps(handle, servers, runtime, session_id, script)
            if not handle._destroyed:
                handle._done.set_result(SessionOutcome(
                    status="ok",
                    summary=f'simulated agent "{manifest.agent.name}" finished',
                    cost_usd=0.0,
                    commit_shas=[],
                ))
        except Exception as e:
            if not handle._done.done():
                msg = str(e)
                await runtime.record_tool_call({
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "name": "agent.error", "input": {}, "output": None, "error": msg,
                })
                handle._done.set_result(SessionOutcome(
                    status="failed", summary=None, cost_usd=0.0, commit_shas=[], error=msg,
                ))

    async def _exec_steps(self, handle: _SimulatedHandle, servers, runtime, session_id: str,
                           steps: list) -> None:
        for step in steps:
            if handle._destroyed:
                return
            kind = step.get("kind")
            if kind == "wait":
                await asyncio.sleep(step["ms"] / 1000 * self._time_scale)
            elif kind == "tool":
                await self._call_tool(servers, runtime, session_id, step["tool"], step.get("args", {}))
            elif kind == "send":
                await self._call_tool(servers, runtime, session_id, "inbox.send", {"body": step["body"]})
                if step.get("then"):
                    await self._exec_steps(handle, servers, runtime, session_id, step["then"])
            elif kind == "ask":
                await self._call_tool(servers, runtime, session_id, "inbox.ask",
                                      {"body": step["body"], "choices": step["choices"]})
                answer = await runtime.wait_for_answer()
                if not answer:
                    return
                choice_id = answer.get("selectedChoiceId", "")
                label = answer.get("label", choice_id)
                next_steps = step.get("onReply", {}).get(choice_id) or \
                             step.get("onReply", {}).get(label) or \
                             step.get("default", [])
                await self._exec_steps(handle, servers, runtime, session_id, next_steps)

    async def _call_tool(self, servers, runtime, session_id: str,
                          name: str, args: dict) -> Any:
        ts = datetime.now(timezone.utc).isoformat()
        for server in servers:
            try:
                output = await server.call(runtime, name, args)
                await runtime.record_tool_call(
                    {"ts": ts, "name": name, "input": args, "output": output, "error": None}
                )
                return output
            except ValueError as e:
                if "unknown tool" in str(e):
                    continue
                raise
        raise ValueError(f"unknown tool {name}")


def _default_script(manifest) -> list:
    steps = []
    if manifest.task:
        steps.append({"kind": "tool", "tool": "tasks.set_status", "args": {"status": "doing"}})
        steps.append({"kind": "tool", "tool": "tasks.append_activity",
                       "args": {"message": "simulated agent starting work"}})
        steps.append({"kind": "wait", "ms": 50})
        if not manifest.task.approvalGate:
            steps.append({"kind": "tool", "tool": "tasks.set_status", "args": {"status": "done"}})
        else:
            steps.append({"kind": "tool", "tool": "tasks.set_status", "args": {"status": "review"}})
    return steps
