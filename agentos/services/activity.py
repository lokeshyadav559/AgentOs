"""Activity feed service. Port of src/services/activity.ts."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from agentos.db.client import get_session
from agentos.db.models import ActivityEvent as ActivityEventRow


class ActivityService:
    async def emit(self, *, project_id: str | None = None, type: str = "system",
                   actor: str, message: str, task_id: str | None = None,
                   goal_id: str | None = None, session_id: str | None = None) -> dict:
        row = ActivityEventRow(
            id=str(uuid.uuid4()),
            project_id=project_id,
            at=datetime.now(timezone.utc).isoformat(),
            type=type,
            actor=actor,
            message=message,
            task_id=task_id,
            goal_id=goal_id,
            session_id=session_id,
        )
        async with get_session() as db:
            db.add(row)
            await db.commit()
            # Keep feed bounded to 500 entries.
            result = await db.execute(select(ActivityEventRow).order_by(ActivityEventRow.at))
            all_rows = result.scalars().all()
            if len(all_rows) > 500:
                excess_ids = [r.id for r in all_rows[: len(all_rows) - 500]]
                await db.execute(delete(ActivityEventRow).where(ActivityEventRow.id.in_(excess_ids)))
                await db.commit()
        return _row_to_dict(row)

    async def list(self, limit: int = 100) -> list[dict]:
        async with get_session() as db:
            result = await db.execute(
                select(ActivityEventRow).order_by(ActivityEventRow.at.desc()).limit(limit)
            )
            return [_row_to_dict(r) for r in result.scalars().all()]


def _row_to_dict(r: ActivityEventRow) -> dict:
    return {
        "id": r.id, "projectId": r.project_id, "at": r.at, "type": r.type,
        "actor": r.actor, "message": r.message, "taskId": r.task_id,
        "goalId": r.goal_id, "sessionId": r.session_id,
    }
