from __future__ import annotations
"""AgentOS MCP server. Port of src/mcp/agentos.ts."""
from agentos.mcp.context import McpServer, McpTool, create_mcp_server
from agentos.acl.grants import check_fs_op


def create_agentos_mcp_server() -> McpServer:
    async def tasks_current(rt, args):
        if not rt.manifest.task:
            return {"task": None}
        task = await rt.services.tasks.get(rt.manifest.task.id)
        if not task:
            return {"task": None}
        attachments = [
            await rt.services.files.get_by_id(fid) for fid in task.get("attachmentIds", [])
        ]
        return {"task": {
            "id": task["id"], "name": task["name"], "description": task["description"],
            "status": task["status"], "approvalGate": task["approvalGate"],
            "activity": task["activity"], "attachments": [a for a in attachments if a],
        }}

    async def tasks_append_activity(rt, args):
        task_id = rt.manifest.task.id if rt.manifest.task else None
        if not task_id:
            raise ValueError("this session has no task")
        task = await rt.services.tasks.append_activity(task_id, rt.manifest.agent.name, args["message"])
        return {"ok": True, "activity": task["activity"]}

    async def tasks_set_status(rt, args):
        task_id = rt.manifest.task.id if rt.manifest.task else None
        if not task_id:
            raise ValueError("this session has no task")
        task = await rt.services.tasks.set_status(
            task_id, args["status"],
            actor="agent", agent_id=rt.manifest.agent.id, session_id=rt.session_id,
        )
        return {"ok": True, "status": task["status"], "approvalGate": task["approvalGate"]}

    async def tasks_attach(rt, args):
        task_id = rt.manifest.task.id if rt.manifest.task else None
        if not task_id:
            raise ValueError("this session has no task")
        ok, reason = check_fs_op(rt.manifest.filesystemGrants, "read", args["filePath"])
        if not ok:
            raise PermissionError(f"attachment denied: {reason}")
        from agentos.db.models import File as FileRow
        from agentos.db.client import get_session as _get_session
        from sqlalchemy import select, and_
        async with _get_session() as db:
            result = await db.execute(
                select(FileRow).where(
                    and_(FileRow.project_id == rt.manifest.projectId, FileRow.path == args["filePath"])
                )
            )
            f = result.scalar_one_or_none()
        if not f:
            raise FileNotFoundError(f"file not found: {args['filePath']}")
        from agentos.db.models import Task as TaskRow
        async with _get_session() as db:
            result = await db.execute(select(TaskRow).where(TaskRow.id == task_id))
            task_row = result.scalar_one_or_none()
            if task_row:
                ids = list(task_row.attachment_ids or [])
                if f.id not in ids:
                    ids.append(f.id)
                    task_row.attachment_ids = ids
                    await db.commit()
        return {"ok": True}

    async def collaborators_spawn(rt, args):
        list_ = rt.manifest.collaborationList
        if args["agentName"] not in list_:
            raise PermissionError(
                f'collaborator "{args["agentName"]}" not on collaboration list [{", ".join(list_)}]'
            )
        task = await rt.spawn_collaborator(args["agentName"], args["brief"])
        return {"ok": True, "taskId": task["id"], "name": task["name"]}

    async def goals_current(rt, args):
        if not rt.manifest.goal:
            return {"goal": None}
        g = await rt.services.goals.get(rt.manifest.goal.id)
        if not g:
            return {"goal": None}
        return {"goal": {"id": g["id"], "title": g["title"], "spec": g["spec"],
                          "definitionOfDone": g["definitionOfDone"],
                          "progressLog": g["progressLog"]}}

    async def goals_append_progress(rt, args):
        if not rt.manifest.goal:
            raise ValueError("this session has no goal")
        g = await rt.services.goals.append_progress(rt.manifest.goal.id, args["entry"])
        return {"ok": True, "progressLog": g["progressLog"]}

    async def goals_complete_dod_item(rt, args):
        if not rt.manifest.goal:
            raise ValueError("this session has no goal")
        g = await rt.services.goals.complete_dod_item(rt.manifest.goal.id, args["item"])
        return {"ok": True, "definitionOfDone": g["definitionOfDone"]}

    async def projects_meta(rt, args):
        from agentos.db.models import Project as ProjectRow
        from agentos.db.client import get_session as _get_session
        from sqlalchemy import select
        async with _get_session() as db:
            result = await db.execute(select(ProjectRow).where(ProjectRow.id == rt.manifest.projectId))
            p = result.scalar_one_or_none()
        if not p:
            raise ValueError("project not found")
        return {"project": {"id": p.id, "name": p.name, "slug": p.slug}}

    return create_mcp_server("agentos", [
        McpTool("tasks.current", "Read the current task.", tasks_current),
        McpTool("tasks.append_activity", "Append a progress note to the current task's activity log.", tasks_append_activity),
        McpTool("tasks.set_status", "Move the current task status (todo/doing/review/done). Gated tasks cannot be set to done by agents.", tasks_set_status),
        McpTool("tasks.attach", "Attach a file by virtual path to the current task.", tasks_attach),
        McpTool("collaborators.spawn", "Spawn a collaborator subtask (collaboration list enforced).", collaborators_spawn),
        McpTool("goals.current", "Read the goal context for this session.", goals_current),
        McpTool("goals.append_progress", "Append to the goal's progress log.", goals_append_progress),
        McpTool("goals.complete_dod_item", "Mark one DoD item done after verifying it.", goals_complete_dod_item),
        McpTool("projects.meta", "Read project metadata (name, slug).", projects_meta),
    ])
