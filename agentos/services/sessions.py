"""
Sessions service stub — full implementation in phase 5 (runners layer).
Provides the interface the rest of the services depend on.
"""
import asyncio
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Callable

from sqlalchemy import select

from agentos.db.client import get_session
from agentos.db.models import Agent as AgentRow, Session as SessionRow


class HttpError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class SessionService:
    def __init__(self, config: Any, services: Any) -> None:
        self._config = config
        self._svc = services
        self._handles: dict[str, Any] = {}       # sessionId → RunnerHandle
        self._subscribers: dict[str, list[Callable]] = defaultdict(list)

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    async def get(self, session_id: str) -> dict | None:
        async with get_session() as db:
            result = await db.execute(select(SessionRow).where(SessionRow.id == session_id))
            row = result.scalar_one_or_none()
        return _row_to_dict(row) if row else None

    async def list(self, project_id: str | None = None) -> list[dict]:
        async with get_session() as db:
            q = select(SessionRow)
            if project_id:
                q = q.where(SessionRow.project_id == project_id)
            result = await db.execute(q.order_by(SessionRow.started_at.desc()))
            return [_row_to_dict(r) for r in result.scalars().all()]

    def is_task_running(self, task_id: str) -> bool:
        return any(h for h in self._handles.values() if h.get("taskId") == task_id)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def request(self, *, project_id: str, agent_id: str,
                      task_id: str | None = None, goal_id: str | None = None) -> dict:
        """Create a session row in 'requested' state."""
        from agentos.runners.routing import choose_runner
        async with get_session() as db:
            result = await db.execute(select(AgentRow).where(AgentRow.id == agent_id))
            agent = result.scalar_one_or_none()
        if not agent:
            raise HttpError(404, "agent not found")

        choice = choose_runner(
            agent_preference=agent.runner_preference,
            model=agent.model,
            anthropic_api_key=self._config.anthropic_api_key,
            deepseek_api_key=self._config.deepseek_api_key,
            deepseek_base_url=self._config.deepseek_base_url,
        )
        now = datetime.now(timezone.utc).isoformat()
        row = SessionRow(
            id=str(uuid.uuid4()),
            project_id=project_id,
            agent_id=agent_id,
            task_id=task_id,
            goal_id=goal_id,
            runner=choice["kind"],
            status="requested",
            tool_call_log=[],
            started_at=now,
            commit_shas=[],
        )
        async with get_session() as db:
            db.add(row)
            await db.commit()
        if task_id:
            await self._svc.tasks.add_session(task_id, row.id)
        if goal_id:
            await self._svc.goals.add_session(goal_id, row.id)
        return _row_to_dict(row)

    async def start(self, session_id: str) -> None:
        """Build the manifest, pick a runner, and launch the session."""
        from agentos.acl.grants import build_session_manifest
        from agentos.mcp.context import McpRuntime
        from agentos.runners.routing import choose_runner

        async with get_session() as db:
            result = await db.execute(select(SessionRow).where(SessionRow.id == session_id))
            row = result.scalar_one_or_none()
        if not row:
            raise HttpError(404, "session not found")

        async with get_session() as db:
            result = await db.execute(select(AgentRow).where(AgentRow.id == row.agent_id))
            agent = result.scalar_one_or_none()
        if not agent:
            raise HttpError(404, "session agent not found")

        # Gather manifest inputs
        from agentos.db.models import (
            Environment as EnvironmentRow, File as FileRow,
            Goal as GoalRow, Skill as SkillRow, Task as TaskRow,
        )
        async with get_session() as db:
            skills_result = await db.execute(
                select(SkillRow).where(SkillRow.id.in_(agent.skill_ids or []))
            )
            skills = skills_result.scalars().all()

            env = None
            if agent.environment_id:
                env_result = await db.execute(
                    select(EnvironmentRow).where(EnvironmentRow.id == agent.environment_id)
                )
                env = env_result.scalar_one_or_none()

            task = None
            if row.task_id:
                task_result = await db.execute(select(TaskRow).where(TaskRow.id == row.task_id))
                task = task_result.scalar_one_or_none()

            goal = None
            if row.goal_id:
                goal_result = await db.execute(select(GoalRow).where(GoalRow.id == row.goal_id))
                goal = goal_result.scalar_one_or_none()

            attachments = []
            if task and task.attachment_ids:
                att_result = await db.execute(
                    select(FileRow).where(FileRow.id.in_(task.attachment_ids))
                )
                attachments = att_result.scalars().all()

        env_names = (env.env_names or []) if env else []
        manifest_dict = build_session_manifest(
            project_id=row.project_id,
            session_id=session_id,
            agent=agent,
            skills=skills,
            env_names=env_names,
            environment=env,
            task=task,
            goal=goal,
            attachments=attachments,
        )

        from agentos.domain.types import SessionManifest
        manifest = SessionManifest(**manifest_dict)

        async with get_session() as db:
            result = await db.execute(select(SessionRow).where(SessionRow.id == session_id))
            r = result.scalar_one_or_none()
            if r:
                r.status = "starting"
                r.manifest = manifest_dict
                await db.commit()

        self._emit(session_id, "status", {"status": "starting"})

        choice = choose_runner(
            agent_preference=agent.runner_preference,
            model=agent.model,
            anthropic_api_key=self._config.anthropic_api_key,
            deepseek_api_key=self._config.deepseek_api_key,
            deepseek_base_url=self._config.deepseek_base_url,
        )
        runner = choice["runner"]
        runtime = McpRuntime(session_id=session_id, manifest=manifest, services=self._svc,
                              on_tool_call=self._on_tool_call, on_status=self._on_status)
        import tempfile, os
        cwd = os.path.join(self._config.work_dir, session_id)
        os.makedirs(cwd, exist_ok=True)

        handle = await runner.provision(
            session_id=session_id,
            manifest=manifest,
            runtime=runtime,
            cwd=cwd,
        )
        self._handles[session_id] = {"handle": handle, "taskId": row.task_id}

        await self._update_status(session_id, "running")
        asyncio.ensure_future(self._await_done(session_id, handle, task, goal, manifest))

    async def _await_done(self, session_id: str, handle: Any, task: Any, goal: Any, manifest: Any) -> None:
        try:
            outcome = await handle.done
        except Exception as e:
            outcome = {"status": "failed", "summary": None, "costUsd": None, "commitShas": [], "error": str(e)}

        self._handles.pop(session_id, None)
        ended = datetime.now(timezone.utc).isoformat()
        final_status = "destroyed" if outcome["status"] == "ok" else "failed"

        async with get_session() as db:
            result = await db.execute(select(SessionRow).where(SessionRow.id == session_id))
            row = result.scalar_one_or_none()
            if row:
                row.status = final_status
                row.ended_at = ended
                row.cost_usd = outcome.get("costUsd")
                row.commit_shas = outcome.get("commitShas", [])
                row.summary = outcome.get("summary")
                await db.commit()

        self._emit(session_id, "status", {"status": final_status})

        if outcome.get("costUsd") and goal:
            await self._svc.goals.add_spend(goal.id, outcome["costUsd"])

        if task:
            note = outcome.get("summary") or outcome.get("error") or ""
            await self._svc.tasks.append_activity(
                task.id, manifest.agent.name,
                f"session {final_status}" + (f": {note}" if note else ""),
            )

        await self._svc.activity.emit(
            project_id=manifest.projectId, type="session",
            actor=manifest.agent.name,
            message=f"session {final_status}: {outcome.get('summary') or outcome.get('error') or ''}",
            session_id=session_id,
        )

        # Goal loop continuation
        if goal and final_status == "destroyed":
            asyncio.ensure_future(self.start_goal_loop(goal.id))

    async def resume_from_inbox(self, message_id: str,
                                 answer: dict) -> None:
        msg = await self._svc.inbox.get(message_id)
        if not msg or not msg.get("sessionId"):
            return
        session_id = msg["sessionId"]
        await self._svc.inbox.reply(
            message_id,
            body=answer.get("body"),
            selected_choice_id=answer.get("selectedChoiceId"),
        )
        handle_info = self._handles.get(session_id)
        if handle_info:
            choice = msg.get("choices", [])
            label = next(
                (c["label"] for c in choice if c["id"] == answer.get("selectedChoiceId")), None
            )
            await handle_info["handle"].inject_reply({**answer, "label": label})

    async def start_goal_loop(self, goal_id: str) -> None:
        goal = await self._svc.goals.get(goal_id)
        if not goal or goal["status"] != "active":
            return

        from agentos.db.models import Agent as AgentRow
        async with get_session() as db:
            result = await db.execute(select(AgentRow).where(AgentRow.project_id == goal["projectId"]))
            agents = result.scalars().all()
        allow_list = [{"id": a.id, "name": a.name} for a in agents]

        decision = await self._svc.goals.orchestrate(goal_id, allow_list)
        if decision["action"] != "continue":
            return
        next_agent_id = decision.get("nextAgentId")
        if not next_agent_id:
            return
        session = await self.request(
            project_id=goal["projectId"], agent_id=next_agent_id, goal_id=goal_id
        )
        await self.start(session["id"])

    # ------------------------------------------------------------------
    # SSE pub/sub
    # ------------------------------------------------------------------

    def subscribe(self, session_id: str, callback: Callable) -> Callable:
        self._subscribers[session_id].append(callback)
        def unsub():
            try:
                self._subscribers[session_id].remove(callback)
            except ValueError:
                pass
        return unsub

    def _emit(self, session_id: str, event_type: str, data: dict) -> None:
        for cb in list(self._subscribers.get(session_id, [])):
            try:
                cb({"type": event_type, "data": data})
            except Exception:
                pass

    async def _on_tool_call(self, session_id: str, entry: dict) -> None:
        async with get_session() as db:
            result = await db.execute(select(SessionRow).where(SessionRow.id == session_id))
            row = result.scalar_one_or_none()
            if row:
                row.tool_call_log = list(row.tool_call_log or []) + [entry]
                await db.commit()
        self._emit(session_id, "tool_call", entry)

    async def _on_status(self, session_id: str, status: str) -> None:
        await self._update_status(session_id, status)

    async def _update_status(self, session_id: str, status: str) -> None:
        async with get_session() as db:
            result = await db.execute(select(SessionRow).where(SessionRow.id == session_id))
            row = result.scalar_one_or_none()
            if row:
                row.status = status
                await db.commit()
        self._emit(session_id, "status", {"status": status})


def _row_to_dict(r: SessionRow) -> dict:
    return {
        "id": r.id, "projectId": r.project_id, "agentId": r.agent_id,
        "taskId": r.task_id, "goalId": r.goal_id, "runner": r.runner,
        "status": r.status, "runtimeHandle": r.runtime_handle,
        "toolCallLog": r.tool_call_log or [], "startedAt": r.started_at,
        "endedAt": r.ended_at, "costUsd": r.cost_usd,
        "commitShas": r.commit_shas or [], "manifest": r.manifest, "summary": r.summary,
    }
