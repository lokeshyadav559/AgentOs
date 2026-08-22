"""
SQLAlchemy ORM models — mirrors the Drizzle schema in src/db/schema.ts exactly.
SQLite via aiosqlite; swap engine URL to move to Postgres (same models).

JSON columns store arrays/objects as TEXT (SQLite has no native JSON type).
Boolean columns stored as INTEGER (SQLite convention).
"""
import json
from typing import Any, Optional

from sqlalchemy import (
    Boolean,
    Float,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator


class JSONType(TypeDecorator):
    """Transparent JSON serialisation for SQLite TEXT columns."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Any) -> Optional[str]:
        if value is None:
            return None
        return json.dumps(value)

    def process_result_value(self, value: Optional[str], dialect: Any) -> Any:
        if value is None:
            return None
        return json.loads(value)


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    slug: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    yaml: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(String, nullable=False)


class Agent(Base):
    __tablename__ = "agents"
    __table_args__ = (UniqueConstraint("project_id", "name", name="agents_project_name_idx"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    model: Mapped[str] = mapped_column(String, nullable=False)
    foundational_prompt: Mapped[str] = mapped_column(Text, nullable=False, default="")
    role_prompt: Mapped[str] = mapped_column(Text, nullable=False, default="")
    skill_ids: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    mcp_connection_ids: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    repo_access: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    filesystem_grants: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    collaboration_list: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    environment_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    runner_preference: Mapped[str] = mapped_column(String, nullable=False, default="inherit")
    inbox_access: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[str] = mapped_column(String, nullable=False)


class Environment(Base):
    __tablename__ = "environments"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    networking: Mapped[str] = mapped_column(String, nullable=False, default="limited")
    allowed_hosts: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    env_names: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)


class Skill(Base):
    __tablename__ = "skills"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    slug: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False, default="prompt")
    body: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    file_path: Mapped[Optional[str]] = mapped_column(String, nullable=True)


class McpConnection(Base):
    __tablename__ = "mcp_connections"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    config: Mapped[dict] = mapped_column(JSONType, nullable=False, default=dict)
    credential_secret_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)


class Repo(Base):
    __tablename__ = "repos"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    remote_url: Mapped[str] = mapped_column(String, nullable=False)
    mount_path: Mapped[str] = mapped_column(String, nullable=False)
    credential_secret_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    default_branch: Mapped[str] = mapped_column(String, nullable=False, default="main")


class Secret(Base):
    """Secret refs. Values live in the AES-256-GCM encrypted local vault."""

    __tablename__ = "secrets"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    provider_ref: Mapped[str] = mapped_column(String, nullable=False)
    purpose: Mapped[str] = mapped_column(String, nullable=False)
    value_enc: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(String, nullable=False)


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        Index("tasks_status_idx", "status"),
        Index("tasks_chain_idx", "chain_id", "chain_index"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String, nullable=False, default="todo")
    assignee_type: Mapped[str] = mapped_column(String, nullable=False, default="agent")
    assignee_agent_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    attachment_ids: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    approval_gate: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    chain_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    chain_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    schedule_kind: Mapped[str] = mapped_column(String, nullable=False, default="now")
    run_at: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    cron: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    timezone: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    template_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    activity: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    session_ids: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    created_at: Mapped[str] = mapped_column(String, nullable=False)


class TaskTemplate(Base):
    __tablename__ = "task_templates"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    variables: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    steps: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)


class Goal(Base):
    __tablename__ = "goals"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    spec: Mapped[str] = mapped_column(Text, nullable=False)
    definition_of_done: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    dod_approved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="active")
    spend_cap_usd: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    spend_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    max_duration_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    stuck_threshold: Mapped[int] = mapped_column(Integer, nullable=False, default=19)
    runner_preference: Mapped[str] = mapped_column(String, nullable=False, default="auto")
    progress_log: Mapped[str] = mapped_column(Text, nullable=False, default="")
    started_at: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    session_ids: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    created_at: Mapped[str] = mapped_column(String, nullable=False)


class Trigger(Base):
    __tablename__ = "triggers"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    webhook_secret_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    webhook_secret_enc: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    agent_id: Mapped[str] = mapped_column(String, nullable=False)
    job_prompt: Mapped[str] = mapped_column(Text, nullable=False, default="New inbound event:\n{{payload}}")


class Automation(Base):
    __tablename__ = "automations"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    cron: Mapped[str] = mapped_column(String, nullable=False)
    timezone: Mapped[str] = mapped_column(String, nullable=False, default="UTC")
    agent_id: Mapped[str] = mapped_column(String, nullable=False)
    task_template_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    task_body: Mapped[Optional[str]] = mapped_column(Text, nullable=True)


class InboxMessage(Base):
    __tablename__ = "inbox_messages"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    from_: Mapped[str] = mapped_column("from", String, nullable=False)
    agent_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    session_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    task_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    goal_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    kind: Mapped[str] = mapped_column(String, nullable=False, default="text")
    body: Mapped[str] = mapped_column(Text, nullable=False)
    choices: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    selected_choice_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="open")
    created_at: Mapped[str] = mapped_column(String, nullable=False)


class Session(Base):
    __tablename__ = "sessions"
    __table_args__ = (Index("sessions_status_idx", "status"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, nullable=False)
    agent_id: Mapped[str] = mapped_column(String, nullable=False)
    task_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    goal_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    runner: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="requested")
    runtime_handle: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    tool_call_log: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    started_at: Mapped[str] = mapped_column(String, nullable=False)
    ended_at: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    cost_usd: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    commit_shas: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    manifest: Mapped[Optional[dict]] = mapped_column(JSONType, nullable=True)
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)


class File(Base):
    __tablename__ = "files"
    __table_args__ = (UniqueConstraint("project_id", "path", name="files_project_path_idx"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, nullable=False)
    path: Mapped[str] = mapped_column(String, nullable=False)
    bucket_key: Mapped[str] = mapped_column(String, nullable=False)
    mime: Mapped[str] = mapped_column(String, nullable=False, default="application/octet-stream")
    size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[str] = mapped_column(String, nullable=False)


class ActivityEvent(Base):
    __tablename__ = "activity_events"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    at: Mapped[str] = mapped_column(String, nullable=False)
    type: Mapped[str] = mapped_column(String, nullable=False, default="system")
    actor: Mapped[str] = mapped_column(String, nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    task_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    goal_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    session_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    endpoint: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    keys: Mapped[dict] = mapped_column(JSONType, nullable=False)
    created_at: Mapped[str] = mapped_column(String, nullable=False)


class KV(Base):
    __tablename__ = "kv"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
