"""
MCP runtime context. Port of src/mcp/context.ts.
"""
from __future__ import annotations

import asyncio
from typing import Any, Callable, Optional


class McpRuntime:
    def __init__(self, *, session_id: str, manifest: Any, services: Any,
                 on_tool_call: Callable, on_status: Callable) -> None:
        self.session_id = session_id
        self.manifest = manifest
        self.services = services
        self._on_tool_call = on_tool_call
        self._on_status = on_status
        self._answer: Optional[dict] = None
        self._answer_event: asyncio.Event = asyncio.Event()
        self._cancelled = False

    async def record_tool_call(self, entry: dict) -> None:
        await self._on_tool_call(self.session_id, entry)

    async def on_inbox_question(self, message: dict) -> None:
        await self._on_status(self.session_id, "waiting-inbox")

    async def on_inbox_note(self, message: dict) -> None:
        pass  # fire-and-forget; session keeps running

    async def spawn_collaborator(self, agent_name: str, brief: str) -> dict:
        list_ = self.manifest.collaborationList
        if agent_name not in list_:
            raise ValueError(f'collaborator "{agent_name}" not on list [{", ".join(list_)}]')
        from agentos.db.models import Agent as AgentRow
        from agentos.db.client import get_session as _get_session
        from sqlalchemy import select, and_
        async with _get_session() as db:
            result = await db.execute(
                select(AgentRow).where(
                    and_(AgentRow.project_id == self.manifest.projectId,
                         AgentRow.name == agent_name)
                )
            )
            agent = result.scalar_one_or_none()
        if not agent:
            raise ValueError(f'unknown agent "{agent_name}"')
        return await self.services.tasks.spawn_collaborator(
            project_id=self.manifest.projectId,
            agent_id=agent.id,
            agent_name=agent_name,
            brief=brief,
            parent_task_id=self.manifest.task.id if self.manifest.task else None,
            parent_session_id=self.session_id,
        )

    def answer(self) -> Optional[dict]:
        return self._answer

    async def wait_for_answer(self) -> Optional[dict]:
        self._answer_event.clear()
        self._answer = None
        await self._answer_event.wait()
        if self._cancelled:
            return None
        return self._answer

    def inject_answer(self, answer: dict) -> None:
        self._answer = answer
        self._answer_event.set()

    def cancel_wait(self) -> None:
        self._cancelled = True
        self._answer_event.set()


class McpServer:
    def __init__(self, name: str, tools: list["McpTool"], network_hosts: list[str] = None) -> None:
        self.name = name
        self.tools = tools
        self.network_hosts = network_hosts or []
        self._by_name = {t.name: t for t in tools}

    async def call(self, rt: McpRuntime, tool_name: str, args: Any) -> Any:
        tool = self._by_name.get(tool_name)
        if not tool:
            raise ValueError(f"unknown tool {self.name}.{tool_name}")
        # Network wall
        from agentos.acl.grants import network_allowed
        for host in self.network_hosts:
            if not network_allowed(rt.manifest.environment, host):
                raise PermissionError(
                    f"network wall denied: {self.name} ({host}) not in environment allowlist"
                )
        return await tool.handler(rt, args or {})

    def list_tools(self) -> list[dict]:
        return [{"name": t.name, "description": t.description} for t in self.tools]


class McpTool:
    def __init__(self, name: str, description: str, handler: Callable) -> None:
        self.name = name
        self.description = description
        self.handler = handler


def create_mcp_server(name: str, tools: list[McpTool], network_hosts: list[str] = None) -> McpServer:
    return McpServer(name, tools, network_hosts or [])
