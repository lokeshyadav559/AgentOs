from __future__ import annotations
"""Goals service + orchestrator. Port of src/services/goals.ts."""
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select

from agentos.db.client import get_session
from agentos.db.models import Agent as AgentRow, Goal as GoalRow, KV, Session as SessionRow


class HttpError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


_STOPWORDS = {
    "the", "and", "for", "with", "from", "into", "this", "that", "your", "you",
    "are", "not", "when", "will", "then", "each", "only", "can", "its",
    "item", "a", "an", "of", "to", "in", "on", "by", "at", "or", "as", "be",
    "it", "is", "one", "any", "all", "but", "has", "have", "was", "were",
}


def _norm(s: str) -> list[str]:
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower()).split()


def mission_score(mission: str, item_text: str) -> float:
    words = [w for w in _norm(item_text) if len(w) > 3 and w not in _STOPWORDS]
    if not words:
        return 0.0
    wanted = set(words)
    hits = sum(1 for w in _norm(mission) if w in wanted)
    return hits / len(words)


def _normalize_text(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", s.lower())).strip()


def _rotate(lst: list[dict], last_name: str | None) -> dict | None:
    if not lst:
        return None
    out = list(lst)
    if last_name:
        idx = next((i for i, a in enumerate(out) if a["name"] == last_name), -1)
        if idx >= 0:
            out.append(out.pop(0 if idx == 0 else idx))
    return out[0] if out else None


class GoalService:
    @staticmethod
    def draft_dod(spec: str) -> list[str]:
        lines = [l.strip() for l in spec.split("\n") if l.strip()]
        bullets = [re.sub(r"^[-*•]\s*|\d+[.)]\s*", "", l) for l in lines if re.match(r"^[-*•]|\d+[.)]", l)]
        if len(bullets) >= 2:
            return bullets
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", spec) if len(s.strip()) > 8]
        return sentences[:5]

    async def get(self, goal_id: str) -> dict | None:
        async with get_session() as db:
            result = await db.execute(select(GoalRow).where(GoalRow.id == goal_id))
            row = result.scalar_one_or_none()
        return _row_to_dict(row) if row else None

    async def list(self, project_id: str) -> list[dict]:
        async with get_session() as db:
            result = await db.execute(select(GoalRow).where(GoalRow.project_id == project_id).order_by(GoalRow.created_at.desc()))
            return [_row_to_dict(r) for r in result.scalars().all()]

    async def create(self, input: dict) -> dict:
        dod_texts = input.get("definitionOfDone") or self.draft_dod(input["spec"])
        if not dod_texts:
            raise HttpError(400, "could not draft a definition of done — write DoD items explicitly")
        now = datetime.now(timezone.utc).isoformat()
        row = GoalRow(
            id=str(uuid.uuid4()),
            project_id=input["projectId"],
            title=input["title"],
            spec=input["spec"],
            definition_of_done=[{"id": str(uuid.uuid4()), "text": t, "done": False} for t in dod_texts],
            dod_approved=False,
            status="active",
            spend_cap_usd=input.get("spendCapUsd"),
            spend_usd=0.0,
            max_duration_minutes=input.get("maxDurationMinutes"),
            stuck_threshold=input.get("stuckThreshold", 19),
            runner_preference=input.get("runnerPreference", "auto"),
            progress_log="",
            started_at=None,
            session_ids=[],
            created_at=now,
        )
        async with get_session() as db:
            db.add(row)
            await db.commit()
        return _row_to_dict(row)

    async def approve_dod(self, goal_id: str) -> dict:
        async with get_session() as db:
            result = await db.execute(select(GoalRow).where(GoalRow.id == goal_id))
            row = result.scalar_one_or_none()
            if not row:
                raise HttpError(404, "goal not found")
            row.dod_approved = True
            row.started_at = row.started_at or datetime.now(timezone.utc).isoformat()
            await db.commit()
        return await self.get(goal_id)  # type: ignore[return-value]

    async def set_status(self, goal_id: str, status: str) -> dict:
        async with get_session() as db:
            result = await db.execute(select(GoalRow).where(GoalRow.id == goal_id))
            row = result.scalar_one_or_none()
            if not row:
                raise HttpError(404, "goal not found")
            row.status = status
            await db.commit()
        return await self.get(goal_id)  # type: ignore[return-value]

    async def append_progress(self, goal_id: str, entry: str) -> dict:
        async with get_session() as db:
            result = await db.execute(select(GoalRow).where(GoalRow.id == goal_id))
            row = result.scalar_one_or_none()
            if not row:
                raise HttpError(404, "goal not found")
            stamp = f"[{datetime.now(timezone.utc).isoformat()}] {entry}"
            row.progress_log = (row.progress_log + "\n" + stamp) if row.progress_log else stamp
            await db.commit()
        return await self.get(goal_id)  # type: ignore[return-value]

    async def add_session(self, goal_id: str, session_id: str) -> None:
        async with get_session() as db:
            result = await db.execute(select(GoalRow).where(GoalRow.id == goal_id))
            row = result.scalar_one_or_none()
            if row:
                row.session_ids = list(row.session_ids or []) + [session_id]
                await db.commit()

    async def add_spend(self, goal_id: str, usd: float) -> dict:
        async with get_session() as db:
            result = await db.execute(select(GoalRow).where(GoalRow.id == goal_id))
            row = result.scalar_one_or_none()
            if not row:
                raise HttpError(404, "goal not found")
            row.spend_usd = round((row.spend_usd or 0) + usd, 4)
            await db.commit()
        return await self.get(goal_id)  # type: ignore[return-value]

    async def complete_dod_item(self, goal_id: str, item_text: str) -> dict:
        async with get_session() as db:
            result = await db.execute(select(GoalRow).where(GoalRow.id == goal_id))
            row = result.scalar_one_or_none()
            if not row:
                raise HttpError(404, "goal not found")
            items = list(row.definition_of_done or [])
            target = _normalize_text(item_text)
            if not target:
                raise HttpError(400, "empty definition-of-done item")

            idx = next((i for i, d in enumerate(items) if not d["done"] and _normalize_text(d["text"]) == target), -1)
            if idx == -1:
                idx = next((i for i, d in enumerate(items) if not d["done"] and (
                    _normalize_text(d["text"]) in target or target in _normalize_text(d["text"])
                )), -1)
            if idx == -1:
                best, best_score = -1, 0.0
                for i, d in enumerate(items):
                    if d["done"]:
                        continue
                    s = mission_score(d["text"], target) + mission_score(target, d["text"])
                    if s > best_score:
                        best_score, best = s, i
                idx = best if best_score > 0 else -1
            if idx == -1:
                raise HttpError(400, f'no unsatisfied DoD item matches "{item_text}"')

            items[idx] = {**items[idx], "done": True}
            row.definition_of_done = items
            await db.commit()
        return await self.get(goal_id)  # type: ignore[return-value]

    async def orchestrate(self, goal_id: str, allow_list: list[dict]) -> dict:
        g = await self.get(goal_id)
        if not g:
            raise HttpError(404, "goal not found")
        if not g["dodApproved"]:
            return {"action": "stop", "stopReason": "stopped-stuck", "summary": "goal not approved"}
        if g["status"] != "active":
            return {"action": "stop", "summary": f"goal status {g['status']}"}

        # Safety rails
        if g["spendCapUsd"] is not None and g["spendUsd"] >= g["spendCapUsd"]:
            await self.set_status(goal_id, "stopped-spend")
            return {"action": "stop", "stopReason": "stopped-spend",
                    "summary": f"spend {g['spendUsd']} >= cap {g['spendCapUsd']}"}
        if g["maxDurationMinutes"] and g["startedAt"]:
            from datetime import timezone as tz
            elapsed = (datetime.now(tz.utc) - datetime.fromisoformat(g["startedAt"])).total_seconds() / 60
            if elapsed >= g["maxDurationMinutes"]:
                await self.set_status(goal_id, "stopped-time")
                return {"action": "stop", "stopReason": "stopped-time",
                        "summary": f"elapsed {int(elapsed)}m >= {g['maxDurationMinutes']}m"}

        # DoD complete?
        if all(d["done"] for d in g["definitionOfDone"]):
            await self.set_status(goal_id, "completed")
            return {"action": "complete", "summary": "all DoD checkboxes satisfied"}

        # Stuck detection
        last_agent = await self._last_agent_name(g)
        stuck_key = f"goal:stuck:{goal_id}"
        async with get_session() as db:
            result = await db.execute(select(KV).where(KV.key == stuck_key))
            kv_row = result.scalar_one_or_none()
        stuck = json.loads(kv_row.value) if kv_row else {"lastAgent": None, "lastProgressLen": 0, "count": 0}
        progress_len = len(g["progressLog"])
        same_agent = stuck["lastAgent"] == last_agent
        no_delta = progress_len == stuck["lastProgressLen"]
        count = (stuck["count"] + 1) if (same_agent and no_delta and last_agent) else (stuck["count"] if same_agent else 0)
        new_stuck = {"lastAgent": last_agent, "lastProgressLen": progress_len, "count": count}
        async with get_session() as db:
            if kv_row:
                result = await db.execute(select(KV).where(KV.key == stuck_key))
                kv_row2 = result.scalar_one_or_none()
                if kv_row2:
                    kv_row2.value = json.dumps(new_stuck)
            else:
                db.add(KV(key=stuck_key, value=json.dumps(new_stuck)))
            await db.commit()
        if count >= g["stuckThreshold"]:
            await self.set_status(goal_id, "stopped-stuck")
            return {"action": "stop", "stopReason": "stopped-stuck",
                    "summary": f"{count} identical iterations without progress"}

        # Pick next specialist
        first_open = next((d["text"] for d in g["definitionOfDone"] if not d["done"]), "")
        profiles = await self._missions_for(allow_list)
        next_agent = self._pick_next_agent(allow_list, last_agent, first_open, profiles)
        if not next_agent:
            await self.set_status(goal_id, "stopped-stuck")
            return {"action": "stop", "stopReason": "stopped-stuck", "summary": "no specialist available"}
        return {"action": "continue", "nextAgentId": next_agent["id"],
                "nextAgentName": next_agent["name"], "summary": f"spawn {next_agent['name']}"}

    async def _missions_for(self, allow_list: list[dict]) -> dict[str, str]:
        if not allow_list:
            return {}
        ids = [a["id"] for a in allow_list]
        async with get_session() as db:
            result = await db.execute(select(AgentRow).where(AgentRow.id.in_(ids)))
            rows = result.scalars().all()
        return {
            r.name: f"{r.name} {r.title} {_prompt_section(r.role_prompt, '## Mission')} {_prompt_section(r.role_prompt, '## Deliverable')}"
            for r in rows
        }

    def _pick_next_agent(self, allow_list: list[dict], last_name: str | None,
                          first_open: str, profiles: dict[str, str]) -> dict | None:
        best_score, tied = 0.0, []
        if first_open:
            for a in allow_list:
                score = mission_score(profiles.get(a["name"], ""), first_open)
                if score > best_score:
                    best_score, tied = score, [a]
                elif score > 0 and score == best_score:
                    tied.append(a)
        if best_score > 0:
            return _rotate(tied, last_name)
        return _rotate(allow_list, last_name)

    async def _last_agent_name(self, g: dict) -> str | None:
        session_ids = g.get("sessionIds", [])
        if not session_ids:
            return None
        last_id = session_ids[-1]
        async with get_session() as db:
            result = await db.execute(select(SessionRow).where(SessionRow.id == last_id))
            s = result.scalar_one_or_none()
            if not s:
                return None
            result2 = await db.execute(select(AgentRow).where(AgentRow.id == s.agent_id))
            agent = result2.scalar_one_or_none()
        return agent.name if agent else None


def _prompt_section(role_prompt: str, marker: str) -> str:
    i = role_prompt.find(marker)
    if i < 0:
        return ""
    rest = role_prompt[i + len(marker):]
    j = rest.find("##")
    return (rest[:j] if j >= 0 else rest).strip()


def _row_to_dict(r: GoalRow) -> dict:
    return {
        "id": r.id, "projectId": r.project_id, "title": r.title, "spec": r.spec,
        "definitionOfDone": r.definition_of_done or [], "dodApproved": r.dod_approved,
        "status": r.status, "spendCapUsd": r.spend_cap_usd, "spendUsd": r.spend_usd,
        "maxDurationMinutes": r.max_duration_minutes, "stuckThreshold": r.stuck_threshold,
        "runnerPreference": r.runner_preference, "progressLog": r.progress_log,
        "startedAt": r.started_at, "sessionIds": r.session_ids or [], "createdAt": r.created_at,
    }
