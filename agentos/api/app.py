from __future__ import annotations
"""FastAPI application. Port of src/api/app.ts."""
import asyncio
import json
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from agentos.api.auth import clear_session_cookie, require_operator, set_session_cookie
from agentos.config import load_config, safe_equal


# ---------------------------------------------------------------------------
# Request body schemas (inline — keeps the API file self-contained)
# ---------------------------------------------------------------------------

class LoginBody(BaseModel):
    token: str

class ProjectCreate(BaseModel):
    name: str
    slug: Optional[str] = None

class YamlBody(BaseModel):
    yaml: str

class AgentCreate(BaseModel):
    name: str
    title: Optional[str] = None
    model: Optional[str] = None
    foundationalPrompt: Optional[str] = None
    rolePrompt: Optional[str] = None
    skillIds: list[str] = []
    mcpConnectionIds: list[str] = []
    repoAccess: list[dict] = []
    filesystemGrants: list[dict] = []
    collaborationList: list[str] = []
    environmentId: Optional[str] = None
    runnerPreference: str = "inherit"
    inboxAccess: bool = False

class SkillCreate(BaseModel):
    name: str
    slug: str
    kind: str = "prompt"
    body: Optional[str] = None
    filePath: Optional[str] = None

class McpCreate(BaseModel):
    name: str
    config: dict = {}
    credentialSecretId: Optional[str] = None

class RepoCreate(BaseModel):
    name: str
    remoteUrl: str
    mountPath: str
    credentialSecretId: Optional[str] = None
    defaultBranch: str = "main"

class EnvCreate(BaseModel):
    name: str
    networking: str = "limited"
    allowedHosts: list[str] = []
    envNames: list[str] = []

class SecretCreate(BaseModel):
    name: str
    purpose: str
    value: Optional[str] = None

class FileWrite(BaseModel):
    path: str
    content: str
    mime: Optional[str] = None

class TaskCreate(BaseModel):
    name: str
    description: str = ""
    assigneeAgentId: Optional[str] = None
    assigneeType: str = "agent"
    attachmentIds: list[str] = []
    approvalGate: bool = False
    scheduleKind: str = "now"
    runAt: Optional[str] = None
    cron: Optional[str] = None
    timezone: Optional[str] = None
    templateId: Optional[str] = None
    variables: Optional[dict] = None
    chainId: Optional[str] = None
    chainIndex: Optional[int] = None

class TaskPatch(BaseModel):
    status: str
    note: Optional[str] = None

class TemplateInstantiate(BaseModel):
    variables: dict = {}

class GoalCreate(BaseModel):
    title: str
    spec: str
    definitionOfDone: list[str] = []
    spendCapUsd: Optional[float] = None
    maxDurationMinutes: Optional[int] = None
    runnerPreference: str = "auto"
    stuckThreshold: int = 19
    confirmNoCap: bool = False

class InboxReply(BaseModel):
    body: Optional[str] = None
    selectedChoiceId: Optional[str] = None

class TriggerCreate(BaseModel):
    name: str
    agentId: str
    jobPrompt: str = "New inbound event:\n{{payload}}"

class BugFixChain(BaseModel):
    branchName: str
    featureTitle: str
    context: Optional[str] = None

class AutomationCreate(BaseModel):
    name: str
    cron: str
    timezone: str = "UTC"
    agentId: str
    taskTemplateId: Optional[str] = None
    taskBody: Optional[str] = None

class PushSubscribe(BaseModel):
    endpoint: str
    keys: dict

class PushUnsubscribe(BaseModel):
    endpoint: str

class CloudBusy(BaseModel):
    busy: bool


def create_app(services_holder: dict) -> FastAPI:
    """
    services_holder is a dict with key "svc" set at startup (avoids import-time
    circular dependency with the lifespan).
    """
    app = FastAPI(title="AgentOS", version="0.1.0")

    def svc():
        return services_holder["svc"]

    # -----------------------------------------------------------------------
    # Public
    # -----------------------------------------------------------------------

    @app.get("/api/health")
    async def health():
        return {"ok": True, "version": "0.1.0"}

    @app.post("/api/login")
    async def login(body: LoginBody, response: Response):
        config = load_config()
        if not safe_equal(body.token, config.operator_token):
            raise HTTPException(401, "invalid operator token")
        resp = JSONResponse({"ok": True})
        set_session_cookie(resp, config.operator_token)
        return resp

    @app.post("/api/logout")
    async def logout():
        resp = JSONResponse({"ok": True})
        clear_session_cookie(resp)
        return resp

    @app.get("/api/push/vapid")
    async def vapid():
        config = load_config()
        return {"publicKey": config.vapid_public_key, "subject": config.vapid_subject}

    @app.post("/hooks/{trigger_id}")
    async def webhook(trigger_id: str, request: Request):
        raw_body = await request.body()
        raw_text = raw_body.decode(errors="replace")
        sig = request.headers.get("x-agentos-signature") or request.headers.get("x-webhook-signature")
        secret = await svc().triggers.get_secret(trigger_id)
        if not svc().triggers.verify(secret, raw_text, sig):
            return JSONResponse({"error": "invalid signature"}, status_code=401)
        try:
            payload = json.loads(raw_text) if raw_text else {}
        except Exception:
            payload = raw_text
        task = await svc().triggers.fire(trigger_id, raw_text, payload)
        return JSONResponse({"ok": True, "taskId": task["id"]}, status_code=201)

    # -----------------------------------------------------------------------
    # All routes below require operator auth
    # -----------------------------------------------------------------------

    auth = Depends(require_operator)

    @app.get("/api/me", dependencies=[auth])
    async def me():
        return {"operator": True}

    # Projects
    @app.post("/api/projects", dependencies=[auth])
    async def create_project(body: ProjectCreate):
        p = await svc().projects.create({"name": body.name, "slug": body.slug})
        await svc().activity.emit(project_id=p["id"], type="system", actor="operator",
                                  message=f'project "{p["name"]}" created')
        return JSONResponse(p, status_code=201)

    @app.get("/api/projects", dependencies=[auth])
    async def list_projects():
        return await svc().projects.list()

    @app.get("/api/projects/{project_id}", dependencies=[auth])
    async def get_project(project_id: str):
        p = await svc().projects.get(project_id)
        if not p:
            raise HTTPException(404, "project not found")
        return p

    @app.put("/api/projects/{project_id}/yaml", dependencies=[auth])
    async def set_yaml(project_id: str, body: YamlBody):
        await svc().projects.set_yaml(project_id, body.yaml)
        return {"ok": True}

    @app.get("/api/projects/{project_id}/yaml", dependencies=[auth])
    async def get_yaml(project_id: str):
        p = await svc().projects.get(project_id)
        if not p:
            raise HTTPException(404, "project not found")
        return {"yaml": p.get("yaml") or ""}

    # Agents
    @app.get("/api/projects/{project_id}/agents", dependencies=[auth])
    async def list_agents(project_id: str):
        from agentos.db.models import Agent as AgentRow
        from agentos.db.client import get_session
        from sqlalchemy import select
        async with get_session() as db:
            result = await db.execute(select(AgentRow).where(AgentRow.project_id == project_id))
            rows = result.scalars().all()
        return [_agent_dict(r) for r in rows]

    @app.post("/api/projects/{project_id}/agents", dependencies=[auth])
    async def create_agent(project_id: str, body: AgentCreate):
        from agentos.db.models import Agent as AgentRow
        from agentos.db.client import get_session
        from sqlalchemy import select
        from datetime import datetime, timezone
        aid = str(uuid.uuid4())
        row = AgentRow(
            id=aid, project_id=project_id, name=body.name,
            title=body.title or body.name, model=body.model or "claude-opus-4",
            foundational_prompt=body.foundationalPrompt or "",
            role_prompt=body.rolePrompt or "",
            skill_ids=body.skillIds, mcp_connection_ids=body.mcpConnectionIds,
            repo_access=body.repoAccess, filesystem_grants=body.filesystemGrants,
            collaboration_list=body.collaborationList, environment_id=body.environmentId,
            runner_preference=body.runnerPreference, inbox_access=body.inboxAccess,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        async with get_session() as db:
            db.add(row)
            await db.commit()
        return JSONResponse(_agent_dict(row), status_code=201)

    @app.put("/api/projects/{project_id}/agents/{name}", dependencies=[auth])
    async def update_agent(project_id: str, name: str, body: AgentCreate):
        from agentos.db.models import Agent as AgentRow
        from agentos.db.client import get_session
        from sqlalchemy import select, and_
        async with get_session() as db:
            result = await db.execute(
                select(AgentRow).where(and_(AgentRow.project_id == project_id, AgentRow.name == name))
            )
            row = result.scalar_one_or_none()
            if not row:
                raise HTTPException(404, "agent not found")
            for field, val in body.model_dump(exclude_none=True).items():
                col = _camel_to_snake(field)
                if hasattr(row, col):
                    setattr(row, col, val)
            await db.commit()
        return _agent_dict(row)

    # Skills
    @app.get("/api/projects/{project_id}/skills", dependencies=[auth])
    async def list_skills(project_id: str):
        from agentos.db.models import Skill as SkillRow
        from agentos.db.client import get_session
        from sqlalchemy import select
        async with get_session() as db:
            result = await db.execute(select(SkillRow).where(SkillRow.project_id == project_id))
            return [_skill_dict(r) for r in result.scalars().all()]

    @app.post("/api/projects/{project_id}/skills", dependencies=[auth])
    async def create_skill(project_id: str, body: SkillCreate):
        from agentos.db.models import Skill as SkillRow
        from agentos.db.client import get_session
        sid = str(uuid.uuid4())
        row = SkillRow(id=sid, project_id=project_id, name=body.name, slug=body.slug,
                       kind=body.kind, body=body.body, file_path=body.filePath)
        async with get_session() as db:
            db.add(row)
            await db.commit()
        return JSONResponse(_skill_dict(row), status_code=201)

    # MCP connections
    @app.get("/api/projects/{project_id}/mcps", dependencies=[auth])
    async def list_mcps(project_id: str):
        from agentos.db.models import McpConnection as McpRow
        from agentos.db.client import get_session
        from sqlalchemy import select
        async with get_session() as db:
            result = await db.execute(select(McpRow).where(McpRow.project_id == project_id))
            return [{"id": r.id, "projectId": r.project_id, "name": r.name,
                     "config": r.config, "credentialSecretId": r.credential_secret_id}
                    for r in result.scalars().all()]

    @app.post("/api/projects/{project_id}/mcps", dependencies=[auth])
    async def create_mcp(project_id: str, body: McpCreate):
        from agentos.db.models import McpConnection as McpRow
        from agentos.db.client import get_session
        mid = str(uuid.uuid4())
        row = McpRow(id=mid, project_id=project_id, name=body.name,
                     config=body.config, credential_secret_id=body.credentialSecretId)
        async with get_session() as db:
            db.add(row)
            await db.commit()
        return JSONResponse({"id": mid, "projectId": project_id, "name": body.name,
                              "config": body.config, "credentialSecretId": body.credentialSecretId}, status_code=201)

    # Repos
    @app.get("/api/projects/{project_id}/repos", dependencies=[auth])
    async def list_repos(project_id: str):
        from agentos.db.models import Repo as RepoRow
        from agentos.db.client import get_session
        from sqlalchemy import select
        async with get_session() as db:
            result = await db.execute(select(RepoRow).where(RepoRow.project_id == project_id))
            return [{"id": r.id, "projectId": r.project_id, "name": r.name,
                     "remoteUrl": r.remote_url, "mountPath": r.mount_path,
                     "credentialSecretId": r.credential_secret_id,
                     "defaultBranch": r.default_branch} for r in result.scalars().all()]

    @app.post("/api/projects/{project_id}/repos", dependencies=[auth])
    async def create_repo(project_id: str, body: RepoCreate):
        from agentos.db.models import Repo as RepoRow
        from agentos.db.client import get_session
        rid = str(uuid.uuid4())
        row = RepoRow(id=rid, project_id=project_id, name=body.name, remote_url=body.remoteUrl,
                      mount_path=body.mountPath, credential_secret_id=body.credentialSecretId,
                      default_branch=body.defaultBranch)
        async with get_session() as db:
            db.add(row)
            await db.commit()
        return JSONResponse({"id": rid, "projectId": project_id, "name": body.name,
                              "remoteUrl": body.remoteUrl, "mountPath": body.mountPath,
                              "credentialSecretId": body.credentialSecretId,
                              "defaultBranch": body.defaultBranch}, status_code=201)

    # Environments
    @app.get("/api/projects/{project_id}/environments", dependencies=[auth])
    async def list_envs(project_id: str):
        from agentos.db.models import Environment as EnvRow
        from agentos.db.client import get_session
        from sqlalchemy import select
        async with get_session() as db:
            result = await db.execute(select(EnvRow).where(EnvRow.project_id == project_id))
            return [{"id": r.id, "projectId": r.project_id, "name": r.name,
                     "networking": r.networking, "allowedHosts": r.allowed_hosts,
                     "envNames": r.env_names} for r in result.scalars().all()]

    @app.post("/api/projects/{project_id}/environments", dependencies=[auth])
    async def create_env(project_id: str, body: EnvCreate):
        from agentos.db.models import Environment as EnvRow
        from agentos.db.client import get_session
        eid = str(uuid.uuid4())
        row = EnvRow(id=eid, project_id=project_id, name=body.name,
                     networking=body.networking, allowed_hosts=body.allowedHosts,
                     env_names=body.envNames)
        async with get_session() as db:
            db.add(row)
            await db.commit()
        return JSONResponse({"id": eid, "projectId": project_id, "name": body.name,
                              "networking": body.networking, "allowedHosts": body.allowedHosts,
                              "envNames": body.envNames}, status_code=201)

    # Secrets
    @app.get("/api/projects/{project_id}/secrets", dependencies=[auth])
    async def list_secrets(project_id: str):
        return await svc().secrets.list(project_id)

    @app.post("/api/projects/{project_id}/secrets", dependencies=[auth])
    async def create_secret(project_id: str, body: SecretCreate):
        ref = await svc().secrets.create_ref(project_id, body.name, body.purpose, body.value)
        return JSONResponse(ref, status_code=201)

    @app.delete("/api/projects/{project_id}/secrets/{secret_id}", dependencies=[auth])
    async def delete_secret(project_id: str, secret_id: str):
        await svc().secrets.delete(secret_id)
        return {"ok": True}

    # Files
    @app.get("/api/projects/{project_id}/files", dependencies=[auth])
    async def list_files(project_id: str, path: str = "/"):
        entries = await svc().files.list(project_id, path)
        return {"path": path, "entries": entries}

    @app.get("/api/projects/{project_id}/files/content", dependencies=[auth])
    async def read_file(project_id: str, path: str):
        file, content = await svc().files.read(project_id, path)
        is_text = bool(__import__("re").match(
            r"^(text/|application/(json|yaml|xml|javascript|typescript)|image/svg)", file["mime"]
        ))
        return {
            "path": file["path"], "mime": file["mime"], "size": file["size"],
            "text": content.decode(errors="replace") if is_text else None,
            "base64": __import__("base64").b64encode(content).decode() if not is_text else None,
        }

    @app.put("/api/projects/{project_id}/files/content", dependencies=[auth])
    async def write_file(project_id: str, body: FileWrite):
        f = await svc().files.write(project_id, body.path, body.content, body.mime)
        return JSONResponse(f, status_code=201)

    @app.delete("/api/projects/{project_id}/files/content", dependencies=[auth])
    async def delete_file(project_id: str, path: str):
        await svc().files.delete(project_id, path)
        return {"ok": True}

    # Tasks
    @app.get("/api/projects/{project_id}/tasks", dependencies=[auth])
    async def list_tasks(project_id: str):
        return await svc().tasks.list(project_id)

    @app.get("/api/projects/{project_id}/tasks/{task_id}", dependencies=[auth])
    async def get_task(project_id: str, task_id: str):
        t = await svc().tasks.get(task_id)
        if not t:
            raise HTTPException(404, "task not found")
        return t

    @app.post("/api/projects/{project_id}/tasks", dependencies=[auth])
    async def create_task(project_id: str, body: TaskCreate):
        t = await svc().tasks.create(project_id, body.model_dump())
        await svc().activity.emit(project_id=project_id, type="task", actor="operator",
                                   message=f'task "{t["name"]}" created', task_id=t["id"])
        return JSONResponse(t, status_code=201)

    @app.patch("/api/projects/{project_id}/tasks/{task_id}", dependencies=[auth])
    async def patch_task(project_id: str, task_id: str, body: TaskPatch):
        t = await svc().tasks.set_status(task_id, body.status, actor="human", note=body.note)
        await svc().activity.emit(project_id=t["projectId"], type="task", actor="human",
                                   message=f'task "{t["name"]}" → {t["status"]}', task_id=t["id"])
        return t

    @app.post("/api/projects/{project_id}/tasks/{task_id}/run", dependencies=[auth])
    async def run_task(project_id: str, task_id: str):
        t = await svc().tasks.get(task_id)
        if not t:
            raise HTTPException(404, "task not found")
        if not t["assigneeAgentId"]:
            raise HTTPException(400, "task has no agent assignee")
        session = await svc().sessions.request(
            project_id=t["projectId"], agent_id=t["assigneeAgentId"], task_id=t["id"]
        )
        asyncio.ensure_future(_start_safely(svc(), session["id"], t["projectId"], t["id"], t["name"]))
        return JSONResponse({"ok": True, "sessionId": session["id"]}, status_code=202)

    @app.get("/api/projects/{project_id}/templates", dependencies=[auth])
    async def list_templates(project_id: str):
        return await svc().tasks.list_templates(project_id)

    @app.post("/api/projects/{project_id}/templates/{template_id}/instantiate", dependencies=[auth])
    async def instantiate_template(project_id: str, template_id: str, body: TemplateInstantiate):
        chain = await svc().tasks.instantiate_template(project_id, template_id, body.variables)
        await svc().activity.emit(project_id=project_id, type="task", actor="operator",
                                   message=f"template instantiated → {len(chain)} tasks")
        return JSONResponse(chain, status_code=201)

    # Goals
    @app.get("/api/projects/{project_id}/goals", dependencies=[auth])
    async def list_goals(project_id: str):
        return await svc().goals.list(project_id)

    @app.get("/api/projects/{project_id}/goals/{goal_id}", dependencies=[auth])
    async def get_goal(project_id: str, goal_id: str):
        g = await svc().goals.get(goal_id)
        if not g:
            raise HTTPException(404, "goal not found")
        return g

    @app.post("/api/projects/{project_id}/goals", dependencies=[auth])
    async def create_goal(project_id: str, body: GoalCreate):
        if body.spendCapUsd is None and not body.confirmNoCap:
            raise HTTPException(400, "a spend cap is required (or pass confirmNoCap: true to run uncapped)")
        g = await svc().goals.create({
            "projectId": project_id, "title": body.title, "spec": body.spec,
            "definitionOfDone": body.definitionOfDone, "spendCapUsd": body.spendCapUsd,
            "maxDurationMinutes": body.maxDurationMinutes,
            "runnerPreference": body.runnerPreference, "stuckThreshold": body.stuckThreshold,
        })
        await svc().activity.emit(project_id=project_id, type="goal", actor="operator",
                                   message=f'goal "{g["title"]}" created ({len(g["definitionOfDone"])} DoD items)',
                                   goal_id=g["id"])
        return JSONResponse(g, status_code=201)

    @app.post("/api/projects/{project_id}/goals/{goal_id}/approve-dod", dependencies=[auth])
    async def approve_dod(project_id: str, goal_id: str):
        g = await svc().goals.approve_dod(goal_id)
        await svc().activity.emit(project_id=g["projectId"], type="goal", actor="human",
                                   message=f'DoD approved for "{g["title"]}" — loop starting', goal_id=g["id"])
        asyncio.ensure_future(svc().sessions.start_goal_loop(g["id"]))
        return g

    @app.post("/api/projects/{project_id}/goals/{goal_id}/pause", dependencies=[auth])
    async def pause_goal(project_id: str, goal_id: str):
        return await svc().goals.set_status(goal_id, "paused")

    @app.post("/api/projects/{project_id}/goals/{goal_id}/resume", dependencies=[auth])
    async def resume_goal(project_id: str, goal_id: str):
        return await svc().goals.set_status(goal_id, "active")

    # Inbox
    @app.get("/api/inbox", dependencies=[auth])
    async def list_inbox():
        return await svc().inbox.list()

    @app.post("/api/inbox/{msg_id}/reply", dependencies=[auth])
    async def reply_inbox(msg_id: str, body: InboxReply):
        msg = await svc().inbox.get(msg_id)
        if not msg:
            raise HTTPException(404, "message not found")
        await svc().sessions.resume_from_inbox(msg_id, body.model_dump())
        return {"ok": True}

    # Sessions
    @app.get("/api/sessions", dependencies=[auth])
    async def list_sessions(projectId: Optional[str] = None):
        return await svc().sessions.list(projectId)

    @app.get("/api/sessions/{session_id}", dependencies=[auth])
    async def get_session_ep(session_id: str):
        s = await svc().sessions.get(session_id)
        if not s:
            raise HTTPException(404, "session not found")
        return s

    @app.get("/api/sessions/{session_id}/live", dependencies=[auth])
    async def session_live(session_id: str):
        s = await svc().sessions.get(session_id)
        if not s:
            raise HTTPException(404, "session not found")

        async def event_generator():
            queue: asyncio.Queue = asyncio.Queue()
            def on_event(e):
                queue.put_nowait(e)
            unsub = svc().sessions.subscribe(session_id, on_event)
            yield f"event: status\ndata: {json.dumps({'status': s['status']})}\n\n"
            try:
                while True:
                    try:
                        e = await asyncio.wait_for(queue.get(), timeout=30)
                        yield f"event: {e['type']}\ndata: {json.dumps(e['data'])}\n\n"
                    except asyncio.TimeoutError:
                        yield "event: ping\ndata: {}\n\n"
            finally:
                unsub()

        return StreamingResponse(event_generator(), media_type="text/event-stream")

    # Activity
    @app.get("/api/activity", dependencies=[auth])
    async def list_activity():
        return await svc().activity.list()

    # Triggers
    @app.get("/api/projects/{project_id}/triggers", dependencies=[auth])
    async def list_triggers(project_id: str):
        return await svc().triggers.list(project_id)

    @app.post("/api/projects/{project_id}/triggers", dependencies=[auth])
    async def create_trigger(project_id: str, body: TriggerCreate):
        t = await svc().triggers.create({"projectId": project_id, "name": body.name,
                                          "agentId": body.agentId, "jobPrompt": body.jobPrompt})
        return JSONResponse(t, status_code=201)

    @app.post("/api/projects/{project_id}/triggers/{trigger_id}/rotate", dependencies=[auth])
    async def rotate_trigger(project_id: str, trigger_id: str):
        return await svc().triggers.rotate_secret(trigger_id)

    @app.post("/api/projects/{project_id}/triggers/{trigger_id}/bugfix-chain", dependencies=[auth])
    async def bugfix_chain(project_id: str, trigger_id: str, body: BugFixChain):
        chain = await svc().triggers.start_bug_fix_chain(
            project_id=project_id, branch_name=body.branchName,
            feature_title=body.featureTitle, context=body.context or "",
        )
        await svc().activity.emit(project_id=project_id, type="trigger", actor="human",
                                   message=f"bug fix chain started ({len(chain)} steps)")
        return JSONResponse(chain, status_code=201)

    # Automations
    @app.get("/api/projects/{project_id}/automations", dependencies=[auth])
    async def list_automations(project_id: str):
        from agentos.db.models import Automation as AutoRow
        from agentos.db.client import get_session
        from sqlalchemy import select
        async with get_session() as db:
            result = await db.execute(select(AutoRow).where(AutoRow.project_id == project_id))
            return [{"id": r.id, "projectId": r.project_id, "name": r.name,
                     "cron": r.cron, "timezone": r.timezone, "agentId": r.agent_id,
                     "taskTemplateId": r.task_template_id, "taskBody": r.task_body}
                    for r in result.scalars().all()]

    @app.post("/api/projects/{project_id}/automations", dependencies=[auth])
    async def create_automation(project_id: str, body: AutomationCreate):
        from agentos.db.models import Automation as AutoRow
        from agentos.db.client import get_session
        aid = str(uuid.uuid4())
        row = AutoRow(id=aid, project_id=project_id, name=body.name, cron=body.cron,
                      timezone=body.timezone, agent_id=body.agentId,
                      task_template_id=body.taskTemplateId, task_body=body.taskBody)
        async with get_session() as db:
            db.add(row)
            await db.commit()
        return JSONResponse({"id": aid, "projectId": project_id, "name": body.name,
                              "cron": body.cron, "timezone": body.timezone,
                              "agentId": body.agentId, "taskTemplateId": body.taskTemplateId,
                              "taskBody": body.taskBody}, status_code=201)

    # Push
    @app.post("/api/push/subscribe", dependencies=[auth])
    async def push_subscribe(body: PushSubscribe):
        await svc().push.subscribe(body.endpoint, body.keys)
        return {"ok": True}

    @app.post("/api/push/unsubscribe", dependencies=[auth])
    async def push_unsubscribe(body: PushUnsubscribe):
        await svc().push.unsubscribe(body.endpoint)
        return {"ok": True}

    # Admin
    @app.get("/api/admin/config", dependencies=[auth])
    async def admin_config():
        config = load_config()
        return {
            "localRunnerEnabled": config.local_runner_enabled,
            "hasApiKey": bool(config.anthropic_api_key),
            "hasDeepseekKey": bool(config.deepseek_api_key),
            "cloudBusy": svc().scheduler.is_cloud_busy(),
            "port": config.port,
            "publicUrl": config.public_url,
        }

    @app.post("/api/admin/cloud-busy", dependencies=[auth])
    async def set_cloud_busy(body: CloudBusy):
        svc().scheduler.set_cloud_busy(body.busy)
        return {"ok": True}

    @app.post("/api/admin/scheduler/tick", dependencies=[auth])
    async def scheduler_tick():
        await svc().scheduler.tick()
        return {"ok": True}

    # Serve compiled React SPA (if present)
    web_dist = Path(__file__).parent.parent.parent / "apps" / "web" / "dist"
    if web_dist.exists():
        app.mount("/", StaticFiles(directory=str(web_dist), html=True), name="static")

    return app


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _start_safely(svc: Any, session_id: str, project_id: str, task_id: str, task_name: str) -> None:
    try:
        await svc.sessions.start(session_id)
    except Exception as e:
        await svc.activity.emit(project_id=project_id, type="task", actor="operator",
                                 message=f"run failed: {e}", task_id=task_id)


def _camel_to_snake(name: str) -> str:
    import re
    s1 = re.sub("(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub("([a-z0-9])([A-Z])", r"\1_\2", s1).lower()


def _agent_dict(r: Any) -> dict:
    return {
        "id": r.id, "projectId": r.project_id, "name": r.name, "title": r.title,
        "model": r.model, "foundationalPrompt": r.foundational_prompt,
        "rolePrompt": r.role_prompt, "skillIds": r.skill_ids or [],
        "mcpConnectionIds": r.mcp_connection_ids or [], "repoAccess": r.repo_access or [],
        "filesystemGrants": r.filesystem_grants or [], "collaborationList": r.collaboration_list or [],
        "environmentId": r.environment_id, "runnerPreference": r.runner_preference,
        "inboxAccess": r.inbox_access, "createdAt": r.created_at,
    }


def _skill_dict(r: Any) -> dict:
    return {"id": r.id, "projectId": r.project_id, "name": r.name, "slug": r.slug,
            "kind": r.kind, "body": r.body, "filePath": r.file_path}
