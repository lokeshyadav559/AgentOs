from __future__ import annotations
"""Inbox service. Port of src/services/inbox.ts."""
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, update

from agentos.db.client import get_session
from agentos.db.models import InboxMessage as InboxMessageRow


class HttpError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class InboxService:
    async def send(self, *, from_: str, agent_id: str | None = None,
                   session_id: str | None = None, task_id: str | None = None,
                   goal_id: str | None = None, kind: str = "text",
                   body: str, choices: list[str] | None = None) -> dict:
        row = InboxMessageRow(
            id=str(uuid.uuid4()),
            from_=from_,
            agent_id=agent_id,
            session_id=session_id,
            task_id=task_id,
            goal_id=goal_id,
            kind=kind,
            body=body,
            choices=[{"id": f"c{i}", "label": c} for i, c in enumerate(choices or [])],
            selected_choice_id=None,
            status="open",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        async with get_session() as db:
            db.add(row)
            await db.commit()
        return _row_to_dict(row)

    async def list(self) -> list[dict]:
        async with get_session() as db:
            result = await db.execute(select(InboxMessageRow).order_by(InboxMessageRow.created_at))
            return [_row_to_dict(r) for r in result.scalars().all()]

    async def get(self, msg_id: str) -> dict | None:
        async with get_session() as db:
            result = await db.execute(select(InboxMessageRow).where(InboxMessageRow.id == msg_id))
            row = result.scalar_one_or_none()
        return _row_to_dict(row) if row else None

    async def open_for_session(self, session_id: str) -> list[dict]:
        async with get_session() as db:
            result = await db.execute(
                select(InboxMessageRow)
                .where(InboxMessageRow.session_id == session_id)
                .order_by(InboxMessageRow.created_at)
            )
            return [_row_to_dict(r) for r in result.scalars().all()]

    async def reply(self, message_id: str, body: str | None = None,
                    selected_choice_id: str | None = None) -> dict:
        async with get_session() as db:
            result = await db.execute(select(InboxMessageRow).where(InboxMessageRow.id == message_id))
            msg = result.scalar_one_or_none()
            if not msg:
                raise HttpError(404, "message not found")
            if msg.status != "open":
                raise HttpError(409, "message already answered")
            if msg.kind == "multiple-choice" and not selected_choice_id:
                raise HttpError(400, "multiple-choice message requires selectedChoiceId")
            if selected_choice_id and not any(c["id"] == selected_choice_id for c in (msg.choices or [])):
                raise HttpError(400, "invalid choice id")

            # Record human answer
            answer_row = InboxMessageRow(
                id=str(uuid.uuid4()),
                from_="human",
                agent_id=msg.agent_id,
                session_id=msg.session_id,
                task_id=msg.task_id,
                goal_id=msg.goal_id,
                kind="text",
                body=body or f"(selected: {next((c['label'] for c in (msg.choices or []) if c['id'] == selected_choice_id), selected_choice_id)})",
                choices=[],
                selected_choice_id=None,
                status="closed",
                created_at=datetime.now(timezone.utc).isoformat(),
            )
            db.add(answer_row)
            msg.status = "answered"
            msg.selected_choice_id = selected_choice_id
            await db.commit()
            return _row_to_dict(msg)

    async def close(self, message_id: str) -> None:
        async with get_session() as db:
            result = await db.execute(select(InboxMessageRow).where(InboxMessageRow.id == message_id))
            row = result.scalar_one_or_none()
            if row:
                row.status = "closed"
                await db.commit()


def _row_to_dict(r: InboxMessageRow) -> dict:
    return {
        "id": r.id, "from": r.from_, "agentId": r.agent_id,
        "sessionId": r.session_id, "taskId": r.task_id, "goalId": r.goal_id,
        "kind": r.kind, "body": r.body, "choices": r.choices or [],
        "selectedChoiceId": r.selected_choice_id, "status": r.status,
        "createdAt": r.created_at,
    }
