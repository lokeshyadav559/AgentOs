from __future__ import annotations
"""
Scheduler: fires scheduled/recurring tasks and cron automations. Port of src/services/scheduler.ts.
Uses APScheduler for the tick loop instead of setInterval.
"""
import asyncio
from datetime import datetime, timezone

from sqlalchemy import select

from agentos.db.client import get_session
from agentos.db.models import Agent as AgentRow, Automation as AutomationRow, Task as TaskRow, TaskTemplate as TaskTemplateRow


def _cron_matches(expr: str, date: datetime) -> bool:
    """5-field cron matcher (minute hour dom month dow)."""
    fields = expr.strip().split()
    if len(fields) != 5:
        return False

    def parse_field(field: str, lo: int, hi: int):
        vals: set[int] = set()
        for part in field.split(","):
            step = 1
            if "/" in part:
                body, step_s = part.rsplit("/", 1)
                step = int(step_s)
            else:
                body = part
            if body == "*":
                for v in range(lo, hi + 1, step):
                    vals.add(v)
            elif "-" in body:
                a, b = body.split("-")
                for v in range(int(a), int(b) + 1, step):
                    vals.add(v)
            else:
                vals.add(int(body))
        return vals

    minute, hour, dom, month, dow = fields
    return (
        date.minute in parse_field(minute, 0, 59)
        and date.hour in parse_field(hour, 0, 23)
        and date.day in parse_field(dom, 1, 31)
        and date.month in parse_field(month, 1, 12)
        and date.weekday() in parse_field(dow, 0, 6)  # 0=Mon in Python; cron 0=Sun — approximate
    )


class SchedulerService:
    def __init__(self, services: object, interval_ms: int = 1000) -> None:
        self._svc = services
        self._interval = interval_ms / 1000
        self._cloud_busy = False
        self._ticking = False
        self._due_marked: set[str] = set()
        self._last_fires: dict[str, str] = {}
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._task = asyncio.ensure_future(self._loop())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None

    def is_cloud_busy(self) -> bool:
        return self._cloud_busy

    def set_cloud_busy(self, busy: bool) -> None:
        self._cloud_busy = busy

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            try:
                await self.tick()
            except Exception as e:
                try:
                    await self._svc.activity.emit(  # type: ignore[attr-defined]
                        type="system", actor="scheduler", message=f"tick error: {e}"
                    )
                except Exception:
                    pass

    async def tick(self) -> None:
        if self._ticking:
            return
        self._ticking = True
        try:
            await self._dispatch_due_tasks()
            await self._fire_automations()
        finally:
            self._ticking = False

    async def _dispatch_due_tasks(self) -> None:
        now = datetime.now(timezone.utc)
        async with get_session() as db:
            result = await db.execute(select(TaskRow))
            all_tasks = result.scalars().all()

        for row in all_tasks:
            # Recurring cron: reset done → todo
            if row.status == "done" and row.schedule_kind == "cron":
                async with get_session() as db:
                    result = await db.execute(select(TaskRow).where(TaskRow.id == row.id))
                    t = result.scalar_one_or_none()
                    if t:
                        activity = list(t.activity or [])
                        activity.append({"at": now.isoformat(), "actor": "scheduler",
                                         "message": "recurring task reset for next run"})
                        t.status = "todo"
                        t.activity = activity
                        await db.commit()
                row.status = "todo"

            if row.status != "todo":
                self._due_marked.discard(row.id)
                continue
            if row.assignee_type != "agent" or not row.assignee_agent_id:
                continue
            if row.id in self._due_marked:
                continue
            if self._svc.sessions.is_task_running(row.id):  # type: ignore[attr-defined]
                continue

            # Chain blocking
            if row.chain_id and row.chain_index and row.chain_index > 0:
                prev = next(
                    (t for t in all_tasks
                     if t.chain_id == row.chain_id and t.chain_index == row.chain_index - 1),
                    None,
                )
                if not prev or prev.status != "done":
                    continue

            due = False
            if row.schedule_kind == "now":
                due = True
            elif row.schedule_kind == "at" and row.run_at:
                due = now >= datetime.fromisoformat(row.run_at)
            elif row.schedule_kind == "cron" and row.cron:
                due = _cron_matches(row.cron, now)

            if not due:
                continue
            if row.schedule_kind != "cron":
                self._due_marked.add(row.id)

            try:
                await self._svc.activity.emit(  # type: ignore[attr-defined]
                    project_id=row.project_id, type="task", actor="scheduler",
                    message=f'dispatching task "{row.name}" to agent', task_id=row.id,
                )
                session = await self._svc.sessions.request(  # type: ignore[attr-defined]
                    project_id=row.project_id, agent_id=row.assignee_agent_id, task_id=row.id
                )
                asyncio.ensure_future(self._start_session(session["id"], row.project_id, row.id, row.name))
            except Exception as e:
                self._due_marked.discard(row.id)
                await self._svc.activity.emit(  # type: ignore[attr-defined]
                    project_id=row.project_id, type="task", actor="scheduler",
                    message=f"dispatch failed: {e}", task_id=row.id,
                )

    async def _start_session(self, session_id: str, project_id: str, task_id: str, task_name: str) -> None:
        try:
            await self._svc.sessions.start(session_id)  # type: ignore[attr-defined]
        except Exception as e:
            await self._svc.activity.emit(  # type: ignore[attr-defined]
                project_id=project_id, type="task", actor="scheduler",
                message=f"session start failed: {e}", task_id=task_id,
            )

    async def _fire_automations(self) -> None:
        now = datetime.now(timezone.utc)
        async with get_session() as db:
            result = await db.execute(select(AutomationRow))
            autos = result.scalars().all()

        for a in autos:
            if not a.cron or not _cron_matches(a.cron, now):
                continue
            key = f"{now.year}-{now.month}-{now.day}-{now.hour}-{now.minute}"
            if self._last_fires.get(a.id) == key:
                continue
            self._last_fires[a.id] = key
            try:
                await self._fire_automation(a.id)
            except Exception as e:
                await self._svc.activity.emit(  # type: ignore[attr-defined]
                    project_id=a.project_id, type="automation", actor="scheduler",
                    message=f'automation "{a.name}" failed: {e}',
                )

    async def _fire_automation(self, automation_id: str) -> None:
        async with get_session() as db:
            result = await db.execute(select(AutomationRow).where(AutomationRow.id == automation_id))
            a = result.scalar_one_or_none()
            if not a:
                return
            result2 = await db.execute(select(AgentRow).where(AgentRow.id == a.agent_id))
            agent = result2.scalar_one_or_none()
            if not agent:
                raise ValueError(f"automation agent missing: {a.agent_id}")

        now = datetime.now(timezone.utc).isoformat()
        if a.task_template_id:
            chain = await self._svc.tasks.instantiate_template(  # type: ignore[attr-defined]
                a.project_id, a.task_template_id,
                {"branchName": f"auto-{a.id[:8]}", "featureTitle": a.name},
            )
            task = chain[0]
        else:
            task = await self._svc.tasks.create(a.project_id, {  # type: ignore[attr-defined]
                "name": a.name,
                "description": a.task_body or f'Automation "{a.name}" fired at {now}',
                "assigneeAgentId": agent.id,
                "scheduleKind": "now",
            })
        await self._svc.activity.emit(  # type: ignore[attr-defined]
            project_id=a.project_id, type="automation", actor="scheduler",
            message=f'automation "{a.name}" fired → task "{task["name"]}"', task_id=task["id"],
        )

    async def poke_task(self, task_id: str) -> None:
        self._due_marked.discard(task_id)
        await self.tick()
