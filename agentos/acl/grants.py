from __future__ import annotations
"""
Least-privilege ACL engine. Port of src/acl/grants.ts.
Default deny: everything an agent may touch must be listed in its manifest.
"""
from typing import Literal, Optional

from agentos.domain.types import FilesystemGrant, SessionManifest

FsOp = Literal["list", "read", "write", "mkdir", "delete"]


def normalize_path(raw: str) -> Optional[str]:
    """Normalize a virtual path; returns None when escaping the root."""
    parts = raw.replace("\\", "/").split("/")
    out: list[str] = []
    for p in parts:
        if p in ("", "."):
            continue
        if p == "..":
            return None  # traversal denied
        out.append(p)
    return "/" + "/".join(out)


def path_within(prefix: str, path: str) -> bool:
    p = normalize_path(prefix)
    q = normalize_path(path)
    if not p or not q:
        return False
    if p == "/":
        return True
    sep_p = p if p.endswith("/") else p + "/"
    return q == p or q.startswith(sep_p)


def grant_for(grants: list[FilesystemGrant], path: str) -> FilesystemGrant:
    """Combined grant for a path across all the agent's folder grants."""
    merged = FilesystemGrant(folderPath=path, canRead=False, canWrite=False, canDelete=False)
    for g in grants:
        if path_within(g.folderPath, path):
            merged.canRead = merged.canRead or g.canRead
            merged.canWrite = merged.canWrite or g.canWrite
            merged.canDelete = merged.canDelete or g.canDelete
    return merged


def check_fs_op(grants: list[FilesystemGrant], op: FsOp, path: str) -> tuple[bool, str]:
    """Returns (ok, reason). Deny unless the grant covers the op."""
    norm = normalize_path(path)
    if not norm:
        return False, f"path escape denied: {path}"
    g = grant_for(grants, norm)
    if op in ("list", "read") and not g.canRead:
        return False, f"no read grant for {norm}"
    if op in ("write", "mkdir") and not g.canWrite:
        return False, f"no write grant for {norm}"
    if op == "delete" and not g.canDelete:
        return False, f"no delete grant for {norm}"
    return True, ""


def network_allowed(environment: Optional[object], host: str) -> bool:
    """Network wall check (§5.5): limited environments deny everything not allowlisted."""
    if environment is None:
        return True
    networking = getattr(environment, "networking", "limited")
    if networking == "open":
        return True
    allowed_hosts: list[str] = getattr(environment, "allowedHosts", [])
    return any(h == host or host.endswith("." + h) for h in allowed_hosts)


def build_session_manifest(
    *,
    project_id: str,
    session_id: str,
    agent: object,
    skills: list[object],
    env_names: list[str],
    environment: Optional[object],
    task: Optional[object],
    goal: Optional[object],
    attachments: list[object],
    mcp_connection_names: Optional[list[str]] = None,
) -> dict:
    """Build a session manifest dict from ORM objects."""
    from agentos.domain.types import (
        SessionManifest,
        SessionManifestAgent,
        SessionManifestEnvironment,
        SessionManifestGoal,
        SessionManifestTask,
        TaskStatus,
    )

    a = agent
    skill_list = [
        {"name": s.name, "slug": s.slug, "kind": s.kind, "body": s.body}
        for s in skills
    ]
    env_block = (
        SessionManifestEnvironment(
            networking=environment.networking,
            allowedHosts=environment.allowed_hosts,
        )
        if environment
        else None
    )
    task_block = (
        SessionManifestTask(
            id=task.id,
            name=task.name,
            description=task.description,
            status=task.status,
            approvalGate=task.approval_gate,
            attachments=[att.model_dump() if hasattr(att, "model_dump") else att for att in attachments],
        )
        if task
        else None
    )
    goal_block = (
        SessionManifestGoal(
            id=goal.id,
            title=goal.title,
            spec=goal.spec,
            definitionOfDone=[d.text for d in goal.definition_of_done],
            progressLog=goal.progress_log,
        )
        if goal
        else None
    )
    return SessionManifest(
        sessionId=session_id,
        projectId=project_id,
        agent=SessionManifestAgent(
            id=a.id,
            name=a.name,
            title=a.title,
            model=a.model,
            foundationalPrompt=a.foundational_prompt,
            rolePrompt=a.role_prompt,
            skills=skill_list,
        ),
        task=task_block,
        goal=goal_block,
        mcpConnections=mcp_connection_names if mcp_connection_names is not None else a.mcp_connection_ids,
        filesystemGrants=a.filesystem_grants,
        repos=a.repo_access,
        environment=env_block,
        collaborationList=a.collaboration_list,
        inboxAccess=a.inbox_access,
        envNames=env_names,
        runnerPreference=a.runner_preference,
    ).model_dump()
