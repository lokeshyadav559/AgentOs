"""Triggers service. Port of src/services/triggers.ts."""
import json
import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, and_

from agentos.db.client import get_session
from agentos.db.models import Agent as AgentRow, TaskTemplate as TaskTemplateRow, Trigger as TriggerRow
from agentos.config import hmac_hex, safe_equal


class HttpError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _sanitize_payload(payload: object, depth: int = 0) -> str:
    _SENSITIVE = re.compile(r"(secret|token|authorization|password|key|signature|header)", re.I)
    if depth > 4:
        return "[truncated]"
    if isinstance(payload, str):
        return payload[:4000] + ("…" if len(payload) > 4000 else "")
    if isinstance(payload, list):
        return "[" + ", ".join(_sanitize_payload(p, depth + 1) for p in payload) + "]"
    if isinstance(payload, dict):
        out = {k: _sanitize_payload(v, depth + 1) for k, v in payload.items() if not _SENSITIVE.search(k)}
        s = json.dumps(out)
        return s[:4000] + ("…" if len(s) > 4000 else "")
    return str(payload)


class TriggerService:
    def __init__(self, services: object) -> None:
        self._svc = services

    async def create(self, input: dict) -> dict:
        async with get_session() as db:
            result = await db.execute(select(AgentRow).where(AgentRow.id == input["agentId"]))
            if not result.scalar_one_or_none():
                raise HttpError(404, "agent not found")

        secret = uuid.uuid4().hex
        secret_ref = await self._svc.secrets.create_ref(  # type: ignore[attr-defined]
            input["projectId"], f"webhook:{input['name']}", "webhook", secret
        )
        trigger_id = str(uuid.uuid4())
        async with get_session() as db:
            db.add(TriggerRow(
                id=trigger_id,
                project_id=input["projectId"],
                name=input["name"],
                webhook_secret_id=secret_ref["id"],
                webhook_secret_enc=self._svc.secrets.encrypt(secret),  # type: ignore[attr-defined]
                agent_id=input["agentId"],
                job_prompt=input.get("jobPrompt", "New inbound event:\n{{payload}}"),
            ))
            await db.commit()
        return {"id": trigger_id, "projectId": input["projectId"], "name": input["name"],
                "webhookSecretId": secret_ref["id"], "webhookSecret": secret,
                "agentId": input["agentId"], "jobPrompt": input.get("jobPrompt", "New inbound event:\n{{payload}}")}

    async def list(self, project_id: str) -> list[dict]:
        async with get_session() as db:
            result = await db.execute(select(TriggerRow).where(TriggerRow.project_id == project_id))
            rows = result.scalars().all()
        return [
            {**_row_to_dict(r), "webhookSecret": (
                self._svc.secrets.decrypt(r.webhook_secret_enc)  # type: ignore[attr-defined]
                if r.webhook_secret_enc else None
            )}
            for r in rows
        ]

    async def rotate_secret(self, trigger_id: str) -> dict:
        async with get_session() as db:
            result = await db.execute(select(TriggerRow).where(TriggerRow.id == trigger_id))
            row = result.scalar_one_or_none()
            if not row:
                raise HttpError(404, "trigger not found")
            secret = uuid.uuid4().hex
            row.webhook_secret_enc = self._svc.secrets.encrypt(secret)  # type: ignore[attr-defined]
            await db.commit()
        if row.webhook_secret_id:
            await self._svc.secrets.set_value(row.webhook_secret_id, secret)  # type: ignore[attr-defined]
        return {**_row_to_dict(row), "webhookSecret": secret}

    async def get_secret(self, trigger_id: str) -> str:
        async with get_session() as db:
            result = await db.execute(select(TriggerRow).where(TriggerRow.id == trigger_id))
            row = result.scalar_one_or_none()
        if not row or not row.webhook_secret_enc:
            raise HttpError(404, "trigger not found")
        return self._svc.secrets.decrypt(row.webhook_secret_enc)  # type: ignore[attr-defined]

    def verify(self, secret: str, raw_body: str, signature: str | None) -> bool:
        if not signature:
            return False
        return safe_equal(hmac_hex(secret, raw_body), signature)

    async def fire(self, trigger_id: str, raw_body: str, payload: object) -> dict:
        async with get_session() as db:
            result = await db.execute(select(TriggerRow).where(TriggerRow.id == trigger_id))
            t = result.scalar_one_or_none()
            if not t:
                raise HttpError(404, "trigger not found")
            result2 = await db.execute(select(AgentRow).where(AgentRow.id == t.agent_id))
            agent = result2.scalar_one_or_none()
            if not agent:
                raise HttpError(404, "trigger agent not found")

        from agentos.services.tasks import interpolate
        sanitized = _sanitize_payload(payload)
        description = interpolate(t.job_prompt, {"payload": sanitized, "eventId": uuid.uuid4().hex[:8]})
        task = await self._svc.tasks.create(t.project_id, {  # type: ignore[attr-defined]
            "name": f"{t.name} · {datetime.now(timezone.utc).isoformat()[11:19]}",
            "description": description,
            "assigneeAgentId": agent.id,
            "scheduleKind": "now",
        })
        await self._svc.activity.emit(  # type: ignore[attr-defined]
            project_id=t.project_id, type="trigger", actor=t.name,
            message=f'webhook fired → task "{task["name"]}" ({agent.name})',
            task_id=task["id"],
        )
        session = await self._svc.sessions.request(  # type: ignore[attr-defined]
            project_id=t.project_id, agent_id=agent.id, task_id=task["id"]
        )
        import asyncio
        asyncio.ensure_future(self._start_session(session["id"], t.project_id, t.name, task["id"]))
        return task

    async def _start_session(self, session_id: str, project_id: str, trigger_name: str, task_id: str) -> None:
        try:
            await self._svc.sessions.start(session_id)  # type: ignore[attr-defined]
        except Exception as e:
            await self._svc.activity.emit(  # type: ignore[attr-defined]
                project_id=project_id, type="trigger", actor=trigger_name,
                message=f"trigger session start failed: {e}", task_id=task_id,
            )

    async def start_bug_fix_chain(self, *, project_id: str, branch_name: str,
                                   feature_title: str, context: str = "") -> list[dict]:
        async with get_session() as db:
            result = await db.execute(
                select(TaskTemplateRow).where(
                    and_(TaskTemplateRow.project_id == project_id, TaskTemplateRow.name == "bugfix-chain")
                )
            )
            tpl = result.scalar_one_or_none()
        if not tpl:
            raise HttpError(400, "bugfix-chain template not seeded for this project")
        return await self._svc.tasks.instantiate_template(  # type: ignore[attr-defined]
            project_id, tpl.id,
            {"branchName": branch_name, "featureTitle": feature_title, "bugContext": context},
        )


def _row_to_dict(r: TriggerRow) -> dict:
    return {
        "id": r.id, "projectId": r.project_id, "name": r.name,
        "webhookSecretId": r.webhook_secret_id, "agentId": r.agent_id,
        "jobPrompt": r.job_prompt, "webhookSecret": None,
    }
