from __future__ import annotations
"""Task service. Port of src/services/tasks.ts."""
import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, and_

from agentos.db.client import get_session
from agentos.db.models import (
    Agent as AgentRow,
    File as FileRow,
    Task as TaskRow,
    TaskTemplate as TaskTemplateRow,
)


class HttpError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def interpolate(template: str, vars: dict[str, str]) -> str:
    return re.sub(
        r"\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}",
        lambda m: vars.get(m.group(1), m.group(0)),
        template,
    )


class TaskService:
    async def get(self, task_id: str) -> dict | None:
        async with get_session() as db:
            result = await db.execute(select(TaskRow).where(TaskRow.id == task_id))
            row = result.scalar_one_or_none()
        return _row_to_dict(row) if row else None

    async def list(self, project_id: str) -> list[dict]:
        async with get_session() as db:
            result = await db.execute(select(TaskRow).where(TaskRow.project_id == project_id).order_by(TaskRow.created_at))
            return [_row_to_dict(r) for r in result.scalars().all()]

    async def create(self, project_id: str, input: dict) -> dict:
        now = datetime.now(timezone.utc).isoformat()
        row = TaskRow(
            id=str(uuid.uuid4()),
            project_id=project_id,
            name=input["name"],
            description=input.get("description", ""),
            status="todo",
            assignee_type=input.get("assigneeType", "agent"),
            assignee_agent_id=input.get("assigneeAgentId"),
            attachment_ids=input.get("attachmentIds", []),
            approval_gate=input.get("approvalGate", False),
            chain_id=input.get("chainId"),
            chain_index=input.get("chainIndex"),
            schedule_kind=input.get("scheduleKind", "now"),
            run_at=input.get("runAt"),
            cron=input.get("cron"),
            timezone=input.get("timezone"),
            template_id=input.get("templateId"),
            activity=[],
            session_ids=[],
            created_at=now,
        )
        async with get_session() as db:
            db.add(row)
            await db.commit()
        return _row_to_dict(row)

    async def set_status(self, task_id: str, status: str, *,
                         actor: str, agent_id: str | None = None,
                         session_id: str | None = None, note: str | None = None) -> dict:
        async with get_session() as db:
            result = await db.execute(select(TaskRow).where(TaskRow.id == task_id))
            task = result.scalar_one_or_none()
            if not task:
                raise HttpError(404, "task not found")
            if actor == "agent":
                if task.approval_gate and status == "done":
                    raise HttpError(403, "approval-gated task: only the human can mark this done")
                if task.assignee_agent_id and agent_id and task.assignee_agent_id != agent_id:
                    raise HttpError(403, "task is assigned to another agent")
            activity = list(task.activity or [])
            activity.append({
                "at": datetime.now(timezone.utc).isoformat(),
                "actor": agent_id or actor,
                "message": f"status → {status}" + (f" ({note})" if note else ""),
            })
            task.status = status
            task.activity = activity
            await db.commit()

        updated = await self.get(task_id)
        if updated and status == "done":
            await self._enqueue_next_in_chain(updated["chainId"], updated["chainIndex"])
        return updated  # type: ignore[return-value]

    async def append_activity(self, task_id: str, actor: str, message: str) -> dict:
        async with get_session() as db:
            result = await db.execute(select(TaskRow).where(TaskRow.id == task_id))
            task = result.scalar_one_or_none()
            if not task:
                raise HttpError(404, "task not found")
            activity = list(task.activity or [])
            activity.append({"at": datetime.now(timezone.utc).isoformat(), "actor": actor, "message": message})
            task.activity = activity
            await db.commit()
        return await self.get(task_id)  # type: ignore[return-value]

    async def add_session(self, task_id: str, session_id: str) -> None:
        async with get_session() as db:
            result = await db.execute(select(TaskRow).where(TaskRow.id == task_id))
            task = result.scalar_one_or_none()
            if task:
                task.session_ids = list(task.session_ids or []) + [session_id]
                await db.commit()

    async def get_template(self, template_id: str) -> dict | None:
        async with get_session() as db:
            result = await db.execute(select(TaskTemplateRow).where(TaskTemplateRow.id == template_id))
            row = result.scalar_one_or_none()
        return _tpl_to_dict(row) if row else None

    async def list_templates(self, project_id: str) -> list[dict]:
        async with get_session() as db:
            result = await db.execute(select(TaskTemplateRow).where(TaskTemplateRow.project_id == project_id))
            return [_tpl_to_dict(r) for r in result.scalars().all()]

    async def instantiate_template(self, project_id: str, template_id: str,
                                   variables: dict[str, str] | None = None) -> list[dict]:
        variables = variables or {}
        tpl = await self.get_template(template_id)
        if not tpl:
            raise HttpError(404, "template not found")
        if tpl["projectId"] != project_id:
            raise HttpError(403, "template belongs to another project")

        chain_id = str(uuid.uuid4())
        created: list[dict] = []
        async with get_session() as db:
            for i, step in enumerate(tpl["steps"]):
                agent_id = None
                if step["agentName"] != "human":
                    result = await db.execute(
                        select(AgentRow).where(
                            and_(AgentRow.project_id == project_id, AgentRow.name == step["agentName"])
                        )
                    )
                    agent = result.scalar_one_or_none()
                    if not agent:
                        raise HttpError(400, f'template step "{step["name"]}" names unknown agent "{step["agentName"]}"')
                    agent_id = agent.id

                task = await self.create(project_id, {
                    "name": step["name"],
                    "description": interpolate(step.get("prompt", ""), {**variables, "taskName": step["name"]}),
                    "assigneeAgentId": agent_id,
                    "assigneeType": "human" if step["agentName"] == "human" else "agent",
                    "approvalGate": step.get("approvalGate", False),
                    "scheduleKind": "now" if i == 0 else "at",
                    "templateId": template_id,
                    "chainId": chain_id,
                    "chainIndex": i,
                })
                created.append(task)
        return created

    async def spawn_collaborator(self, *, project_id: str, agent_id: str,
                                  agent_name: str, brief: str,
                                  parent_task_id: str | None,
                                  parent_session_id: str) -> dict:
        task = await self.create(project_id, {
            "name": f"Collaborator: {agent_name}",
            "description": brief,
            "assigneeAgentId": agent_id,
            "scheduleKind": "now",
        })
        await self.append_activity(task["id"], agent_name, f"spawned by {agent_name} ({parent_session_id})")
        if parent_task_id:
            parent = await self.get(parent_task_id)
            if parent:
                await self.append_activity(parent["id"], agent_name,
                                           f"spawned collaborator subtask {task['name']} ({task['id']})")
        return task

    async def _enqueue_next_in_chain(self, chain_id: str | None, chain_index: int | None) -> None:
        if not chain_id or chain_index is None:
            return
        async with get_session() as db:
            result = await db.execute(select(TaskRow).where(TaskRow.chain_id == chain_id))
            chain = result.scalars().all()
            next_task = next(
                (t for t in sorted(chain, key=lambda t: t.chain_index or 0)
                 if t.chain_index == chain_index + 1),
                None,
            )
            if next_task:
                activity = list(next_task.activity or [])
                activity.append({"at": datetime.now(timezone.utc).isoformat(),
                                  "actor": "system", "message": "previous chain step done — task released"})
                next_task.schedule_kind = "now"
                next_task.run_at = None
                next_task.activity = activity
                await db.commit()


def _row_to_dict(r: TaskRow) -> dict:
    return {
        "id": r.id, "projectId": r.project_id, "name": r.name,
        "description": r.description, "status": r.status,
        "assigneeType": r.assignee_type, "assigneeAgentId": r.assignee_agent_id,
        "attachmentIds": r.attachment_ids or [], "approvalGate": r.approval_gate,
        "chainId": r.chain_id, "chainIndex": r.chain_index,
        "scheduleKind": r.schedule_kind, "runAt": r.run_at,
        "cron": r.cron, "timezone": r.timezone, "templateId": r.template_id,
        "activity": r.activity or [], "sessionIds": r.session_ids or [],
        "createdAt": r.created_at,
    }


def _tpl_to_dict(r: TaskTemplateRow) -> dict:
    return {
        "id": r.id, "projectId": r.project_id, "name": r.name,
        "description": r.description, "variables": r.variables or [],
        "steps": r.steps or [],
    }
