"""
AgentOS domain types — mirrors src/domain/types.ts exactly.
Pydantic models replace Zod schemas; used across API, MCP, runners, CLI.
"""
import uuid as _uuid
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


def new_id() -> str:
    return str(_uuid.uuid4())


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class TaskStatus(str, Enum):
    todo = "todo"
    doing = "doing"
    review = "review"
    done = "done"


class AssigneeType(str, Enum):
    agent = "agent"
    human = "human"


class ScheduleKind(str, Enum):
    now = "now"
    at = "at"
    cron = "cron"


class RunnerPreference(str, Enum):
    cloud = "cloud"
    local = "local"
    inherit = "inherit"


class GoalRunnerPreference(str, Enum):
    cloud = "cloud"
    local = "local"
    auto = "auto"


class GoalStatus(str, Enum):
    active = "active"
    paused = "paused"
    completed = "completed"
    stopped_spend = "stopped-spend"
    stopped_time = "stopped-time"
    stopped_stuck = "stopped-stuck"


class Networking(str, Enum):
    open = "open"
    limited = "limited"


class SkillKind(str, Enum):
    prompt = "prompt"
    file = "file"


class SecretPurpose(str, Enum):
    mcp = "mcp"
    repo = "repo"
    env = "env"
    webhook = "webhook"


class GitPermission(str, Enum):
    git_read = "git-read"
    git_write = "git-write"


class SessionStatus(str, Enum):
    requested = "requested"
    starting = "starting"
    running = "running"
    waiting_inbox = "waiting-inbox"
    committing = "committing"
    destroyed = "destroyed"
    failed = "failed"


class RunnerKind(str, Enum):
    cloud = "cloud"
    local = "local"
    deepseek = "deepseek"


class InboxKind(str, Enum):
    text = "text"
    multiple_choice = "multiple-choice"


class InboxFrom(str, Enum):
    agent = "agent"
    human = "human"


class InboxStatus(str, Enum):
    open = "open"
    answered = "answered"
    closed = "closed"


# ---------------------------------------------------------------------------
# Sub-models
# ---------------------------------------------------------------------------

class RepoGrant(BaseModel):
    repoId: str
    mountPath: str
    permissions: GitPermission


class FilesystemGrant(BaseModel):
    folderPath: str
    canRead: bool
    canWrite: bool
    canDelete: bool


class TaskActivity(BaseModel):
    at: str
    actor: str
    message: str


class TemplateStep(BaseModel):
    name: str
    agentName: str
    prompt: str = ""
    approvalGate: bool = False


class DoDItem(BaseModel):
    id: str
    text: str
    done: bool = False


class InboxChoice(BaseModel):
    id: str
    label: str


class ToolCallLogEntry(BaseModel):
    ts: str
    name: str
    input: dict[str, Any]
    output: Optional[Any] = None
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Entities (dict-style; ORM rows mapped to plain dicts in services)
# ---------------------------------------------------------------------------

class Project(BaseModel):
    id: str
    name: str
    slug: str
    yaml: Optional[str] = None
    createdAt: str


class Agent(BaseModel):
    id: str
    projectId: str
    name: str
    title: str
    model: str
    foundationalPrompt: str
    rolePrompt: str
    skillIds: list[str] = Field(default_factory=list)
    mcpConnectionIds: list[str] = Field(default_factory=list)
    repoAccess: list[RepoGrant] = Field(default_factory=list)
    filesystemGrants: list[FilesystemGrant] = Field(default_factory=list)
    collaborationList: list[str] = Field(default_factory=list)
    environmentId: Optional[str] = None
    runnerPreference: RunnerPreference = RunnerPreference.inherit
    inboxAccess: bool = False
    createdAt: str


class Environment(BaseModel):
    id: str
    projectId: str
    name: str
    networking: Networking = Networking.limited
    allowedHosts: list[str] = Field(default_factory=list)
    envNames: list[str] = Field(default_factory=list)


class Skill(BaseModel):
    id: str
    projectId: str
    name: str
    slug: str
    kind: SkillKind = SkillKind.prompt
    body: Optional[str] = None
    filePath: Optional[str] = None


class McpConnection(BaseModel):
    id: str
    projectId: str
    name: str
    config: dict[str, Any] = Field(default_factory=dict)
    credentialSecretId: Optional[str] = None


class Repo(BaseModel):
    id: str
    projectId: str
    name: str
    remoteUrl: str
    mountPath: str
    credentialSecretId: Optional[str] = None
    defaultBranch: str = "main"


class SecretRef(BaseModel):
    id: str
    projectId: str
    name: str
    providerRef: str
    purpose: SecretPurpose


class Task(BaseModel):
    id: str
    projectId: str
    name: str
    description: str = ""
    status: TaskStatus = TaskStatus.todo
    assigneeType: AssigneeType = AssigneeType.agent
    assigneeAgentId: Optional[str] = None
    attachmentIds: list[str] = Field(default_factory=list)
    approvalGate: bool = False
    chainId: Optional[str] = None
    chainIndex: Optional[int] = None
    scheduleKind: ScheduleKind = ScheduleKind.now
    runAt: Optional[str] = None
    cron: Optional[str] = None
    timezone: Optional[str] = None
    templateId: Optional[str] = None
    activity: list[TaskActivity] = Field(default_factory=list)
    sessionIds: list[str] = Field(default_factory=list)
    createdAt: str


class TaskTemplate(BaseModel):
    id: str
    projectId: str
    name: str
    description: str = ""
    variables: list[str] = Field(default_factory=list)
    steps: list[TemplateStep] = Field(default_factory=list)


class Goal(BaseModel):
    id: str
    projectId: str
    title: str
    spec: str
    definitionOfDone: list[DoDItem] = Field(default_factory=list)
    dodApproved: bool = False
    status: GoalStatus = GoalStatus.active
    spendCapUsd: Optional[float] = None
    spendUsd: float = 0.0
    maxDurationMinutes: Optional[int] = None
    stuckThreshold: int = 19
    runnerPreference: GoalRunnerPreference = GoalRunnerPreference.auto
    progressLog: str = ""
    startedAt: Optional[str] = None
    sessionIds: list[str] = Field(default_factory=list)
    createdAt: str


class Trigger(BaseModel):
    id: str
    projectId: str
    name: str
    webhookSecretId: Optional[str] = None
    webhookSecret: Optional[str] = None
    agentId: str
    jobPrompt: str = "New inbound event:\n{{payload}}"


class Automation(BaseModel):
    id: str
    projectId: str
    name: str
    cron: str
    timezone: str = "UTC"
    agentId: str
    taskTemplateId: Optional[str] = None
    taskBody: Optional[str] = None


class InboxMessage(BaseModel):
    id: str
    from_: InboxFrom = Field(alias="from")
    agentId: Optional[str] = None
    sessionId: Optional[str] = None
    taskId: Optional[str] = None
    goalId: Optional[str] = None
    kind: InboxKind = InboxKind.text
    body: str
    choices: list[InboxChoice] = Field(default_factory=list)
    selectedChoiceId: Optional[str] = None
    status: InboxStatus = InboxStatus.open
    createdAt: str

    model_config = {"populate_by_name": True}


class FileObject(BaseModel):
    id: str
    projectId: str
    path: str
    bucketKey: str
    mime: str = "application/octet-stream"
    size: int = 0
    updatedAt: str


class ActivityEvent(BaseModel):
    id: str
    projectId: Optional[str] = None
    at: str
    type: str = "system"
    actor: str
    message: str
    taskId: Optional[str] = None
    goalId: Optional[str] = None
    sessionId: Optional[str] = None


# ---------------------------------------------------------------------------
# Session manifest (least-privilege envelope handed to a runner)
# ---------------------------------------------------------------------------

class SessionManifestAgent(BaseModel):
    id: str
    name: str
    title: str
    model: str
    foundationalPrompt: str
    rolePrompt: str
    skills: list[dict[str, Any]] = Field(default_factory=list)


class SessionManifestTask(BaseModel):
    id: str
    name: str
    description: str
    status: TaskStatus
    approvalGate: bool
    attachments: list[dict[str, Any]] = Field(default_factory=list)


class SessionManifestGoal(BaseModel):
    id: str
    title: str
    spec: str
    definitionOfDone: list[str] = Field(default_factory=list)
    progressLog: str = ""


class SessionManifestEnvironment(BaseModel):
    networking: Networking
    allowedHosts: list[str] = Field(default_factory=list)


class SessionManifest(BaseModel):
    sessionId: str
    projectId: str
    agent: SessionManifestAgent
    task: Optional[SessionManifestTask] = None
    goal: Optional[SessionManifestGoal] = None
    mcpConnections: list[str] = Field(default_factory=list)
    filesystemGrants: list[FilesystemGrant] = Field(default_factory=list)
    repos: list[RepoGrant] = Field(default_factory=list)
    environment: Optional[SessionManifestEnvironment] = None
    collaborationList: list[str] = Field(default_factory=list)
    inboxAccess: bool = False
    envNames: list[str] = Field(default_factory=list)
    runnerPreference: str = "inherit"


class Session(BaseModel):
    id: str
    projectId: str
    agentId: str
    taskId: Optional[str] = None
    goalId: Optional[str] = None
    runner: RunnerKind
    status: SessionStatus = SessionStatus.requested
    runtimeHandle: Optional[str] = None
    toolCallLog: list[ToolCallLogEntry] = Field(default_factory=list)
    startedAt: str
    endedAt: Optional[str] = None
    costUsd: Optional[float] = None
    commitShas: list[str] = Field(default_factory=list)
    manifest: Optional[SessionManifest] = None
    summary: Optional[str] = None


# ---------------------------------------------------------------------------
# API request schemas
# ---------------------------------------------------------------------------

class TaskCreateSchema(BaseModel):
    name: str
    description: str = ""
    assigneeAgentId: Optional[str] = None
    assigneeType: AssigneeType = AssigneeType.agent
    attachmentIds: list[str] = Field(default_factory=list)
    approvalGate: bool = False
    scheduleKind: ScheduleKind = ScheduleKind.now
    runAt: Optional[str] = None
    cron: Optional[str] = None
    timezone: Optional[str] = None
    templateId: Optional[str] = None
    variables: Optional[dict[str, str]] = None
    chainId: Optional[str] = None
    chainIndex: Optional[int] = None


class GoalCreateSchema(BaseModel):
    title: str
    spec: str
    definitionOfDone: list[str] = Field(default_factory=list)
    spendCapUsd: Optional[float] = None
    maxDurationMinutes: Optional[int] = None
    runnerPreference: GoalRunnerPreference = GoalRunnerPreference.auto
    stuckThreshold: int = 19
    confirmNoCap: bool = False


class AgentUpdateSchema(BaseModel):
    name: str
    title: Optional[str] = None
    model: Optional[str] = None
    foundationalPrompt: Optional[str] = None
    rolePrompt: Optional[str] = None
    skillIds: Optional[list[str]] = None
    mcpConnectionIds: Optional[list[str]] = None
    repoAccess: Optional[list[RepoGrant]] = None
    filesystemGrants: Optional[list[FilesystemGrant]] = None
    collaborationList: Optional[list[str]] = None
    environmentId: Optional[str] = None
    runnerPreference: Optional[RunnerPreference] = None
    inboxAccess: Optional[bool] = None


class TriggerCreateSchema(BaseModel):
    name: str
    agentId: str
    jobPrompt: str = "New inbound event:\n{{payload}}"


class AutomationCreateSchema(BaseModel):
    name: str
    cron: str
    timezone: str = "UTC"
    agentId: str
    taskTemplateId: Optional[str] = None
    taskBody: Optional[str] = None


class InboxReplySchema(BaseModel):
    body: Optional[str] = None
    selectedChoiceId: Optional[str] = None
