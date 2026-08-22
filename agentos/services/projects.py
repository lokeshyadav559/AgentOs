from __future__ import annotations
"""Projects service. Port of src/services/projects.ts."""
import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from agentos.db.client import get_session
from agentos.db.models import (
    Agent as AgentRow,
    Environment as EnvironmentRow,
    McpConnection as McpConnectionRow,
    Project as ProjectRow,
    Skill as SkillRow,
    TaskTemplate as TaskTemplateRow,
)


class HttpError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "project"


class ProjectService:
    async def create(self, input: dict) -> dict:
        slug = input.get("slug") or slugify(input["name"])
        async with get_session() as db:
            result = await db.execute(select(ProjectRow).where(ProjectRow.slug == slug))
            if result.scalar_one_or_none():
                raise HttpError(409, f'project slug "{slug}" already exists')
            now = datetime.now(timezone.utc).isoformat()
            row = ProjectRow(
                id=str(uuid.uuid4()),
                name=input["name"],
                slug=slug,
                yaml=None,
                created_at=now,
            )
            db.add(row)
            await db.commit()

        await self._provision_defaults(row.id)
        return _row_to_dict(row)

    async def _provision_defaults(self, project_id: str) -> None:
        from agentos.domain.defaults import project_defaults
        d = project_defaults(project_id)

        async with get_session() as db:
            for e in d["environments"]:
                db.add(EnvironmentRow(id=str(uuid.uuid4()), **e))
            await db.commit()

            result = await db.execute(select(EnvironmentRow).where(EnvironmentRow.project_id == project_id))
            env_by_name = {r.name: r.id for r in result.scalars().all()}

            for m in d["mcp_connections"]:
                db.add(McpConnectionRow(id=str(uuid.uuid4()), **m))
            await db.commit()

            result = await db.execute(select(McpConnectionRow).where(McpConnectionRow.project_id == project_id))
            mcp_by_name = {r.name: r.id for r in result.scalars().all()}

            for s in d["skills"]:
                skill_id = (
                    f"skill-plan-mode-{project_id[:8]}"
                    if s["slug"] == "plan-mode"
                    else str(uuid.uuid4())
                )
                db.add(SkillRow(id=skill_id, **s))
            await db.commit()

            for a in d["agents"]:
                a = dict(a)
                # resolve skill + mcp + env name references to IDs
                a["skill_ids"] = [
                    sid.replace("skill-plan-mode", f"skill-plan-mode-{project_id[:8]}")
                    for sid in a.get("skill_ids", [])
                ]
                a["mcp_connection_ids"] = [mcp_by_name.get(n, n) for n in a.get("mcp_connection_ids", [])]
                env_name = a.pop("environment_id", None)
                resolved_env = env_by_name.get(env_name) if env_name else None
                db.add(AgentRow(
                    id=str(uuid.uuid4()),
                    created_at=datetime.now(timezone.utc).isoformat(),
                    environment_id=resolved_env,
                    **a,
                ))
            await db.commit()

            for t in d["templates"]:
                db.add(TaskTemplateRow(id=str(uuid.uuid4()), **t))
            # bugfix-chain template
            from agentos.domain.defaults import bugfix_chain_steps
            db.add(TaskTemplateRow(
                id=str(uuid.uuid4()),
                project_id=project_id,
                name="bugfix-chain",
                description="Post-approval bug fix chain: implement → plan → plan review → fix → E2E → human merge.",
                variables=["branchName", "featureTitle", "bugContext"],
                steps=bugfix_chain_steps(),
            ))
            await db.commit()

    async def get(self, project_id: str) -> dict | None:
        async with get_session() as db:
            result = await db.execute(select(ProjectRow).where(ProjectRow.id == project_id))
            row = result.scalar_one_or_none()
        return _row_to_dict(row) if row else None

    async def list(self) -> list[dict]:
        async with get_session() as db:
            result = await db.execute(select(ProjectRow))
            return [_row_to_dict(r) for r in result.scalars().all()]

    async def set_yaml(self, project_id: str, yaml: str | None) -> None:
        async with get_session() as db:
            result = await db.execute(select(ProjectRow).where(ProjectRow.id == project_id))
            row = result.scalar_one_or_none()
            if row:
                row.yaml = yaml
                await db.commit()

    async def list_agents(self, project_id: str) -> list[dict]:
        async with get_session() as db:
            result = await db.execute(select(AgentRow).where(AgentRow.project_id == project_id))
            return [_agent_to_dict(r) for r in result.scalars().all()]


def _row_to_dict(r: ProjectRow) -> dict:
    return {"id": r.id, "name": r.name, "slug": r.slug, "yaml": r.yaml, "createdAt": r.created_at}


def _agent_to_dict(r: AgentRow) -> dict:
    return {
        "id": r.id, "projectId": r.project_id, "name": r.name, "title": r.title,
        "model": r.model, "foundationalPrompt": r.foundational_prompt,
        "rolePrompt": r.role_prompt, "skillIds": r.skill_ids or [],
        "mcpConnectionIds": r.mcp_connection_ids or [],
        "repoAccess": r.repo_access or [], "filesystemGrants": r.filesystem_grants or [],
        "collaborationList": r.collaboration_list or [],
        "environmentId": r.environment_id,
        "runnerPreference": r.runner_preference, "inboxAccess": r.inbox_access,
        "createdAt": r.created_at,
    }
