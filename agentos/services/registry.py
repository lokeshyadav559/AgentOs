"""Services registry and factory. Port of src/services/registry.ts."""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agentos.config import Config
    from agentos.services.activity import ActivityService
    from agentos.services.files import FileService
    from agentos.services.goals import GoalService
    from agentos.services.inbox import InboxService
    from agentos.services.projects import ProjectService
    from agentos.services.push import PushService
    from agentos.services.scheduler import SchedulerService
    from agentos.services.secrets import SecretService
    from agentos.services.sessions import SessionService
    from agentos.services.tasks import TaskService
    from agentos.services.triggers import TriggerService


@dataclass
class Services:
    config: "Config"
    projects: "ProjectService"
    tasks: "TaskService"
    files: "FileService"
    goals: "GoalService"
    inbox: "InboxService"
    sessions: "SessionService"
    activity: "ActivityService"
    push: "PushService"
    secrets: "SecretService"
    scheduler: "SchedulerService"
    triggers: "TriggerService"


async def build_services(config: "Config") -> Services:
    """Wire all services together — avoids circular imports at module level."""
    from agentos.services.activity import ActivityService
    from agentos.services.files import FileService
    from agentos.services.goals import GoalService
    from agentos.services.inbox import InboxService
    from agentos.services.projects import ProjectService
    from agentos.services.push import PushService
    from agentos.services.scheduler import SchedulerService
    from agentos.services.secrets import SecretService
    from agentos.services.sessions import SessionService
    from agentos.services.tasks import TaskService
    from agentos.services.triggers import TriggerService

    secrets = SecretService(config.secret)
    activity = ActivityService()
    push = PushService(config.vapid_subject, config.vapid_public_key, config.vapid_private_key)
    projects = ProjectService()
    tasks = TaskService()
    files = FileService(config.blob_dir)
    goals = GoalService()
    inbox = InboxService()

    # Create placeholder Services first so circular refs (sessions ↔ scheduler ↔ triggers) resolve
    svc = Services(
        config=config,
        projects=projects,
        tasks=tasks,
        files=files,
        goals=goals,
        inbox=inbox,
        sessions=None,  # type: ignore[arg-type]
        activity=activity,
        push=push,
        secrets=secrets,
        scheduler=None,  # type: ignore[arg-type]
        triggers=None,  # type: ignore[arg-type]
    )

    svc.sessions = SessionService(config, svc)
    svc.scheduler = SchedulerService(svc)
    svc.triggers = TriggerService(svc)

    return svc
