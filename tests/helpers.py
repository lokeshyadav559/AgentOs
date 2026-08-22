"""
Test harness: in-memory control plane with simulated runner (no API key),
manual scheduler ticks, and a disposable data dir.
"""
import asyncio
import shutil
import tempfile
from pathlib import Path
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport


async def make_context(tmp_path: Path) -> dict:
    """Build a full services + FastAPI app wired to a temp data dir."""
    import os
    os.environ["AGENTOS_DATA_DIR"] = str(tmp_path)
    os.environ["AGENTOS_OPERATOR_TOKEN"] = "test-operator-token"
    os.environ["AGENTOS_SECRET"] = "test-hmac-secret"

    # Reset config singleton
    import agentos.config as cfg_mod
    cfg_mod._config = None
    config = cfg_mod.load_config()

    from agentos.db.client import init_engine, create_tables
    init_engine(":memory:")
    await create_tables()

    from agentos.services.registry import build_services
    svc = await build_services(config)

    services_holder = {"svc": svc}
    from agentos.api.app import create_app
    app = create_app(services_holder)

    auth_headers = {"authorization": "Bearer test-operator-token"}
    return {"config": config, "svc": svc, "app": app, "auth": auth_headers}


async def new_project(ctx: dict, name: str = "test-project") -> dict:
    return await ctx["svc"].projects.create({"name": name})


async def agent_by_name(ctx: dict, project_id: str, name: str) -> dict:
    agents = await ctx["svc"].projects.list_agents(project_id)
    a = next((ag for ag in agents if ag["name"] == name), None)
    if not a:
        raise ValueError(f"agent {name} not found")
    return a


async def create_task(ctx: dict, project_id: str, **kwargs) -> dict:
    return await ctx["svc"].tasks.create(project_id, kwargs)


async def wait_for(fn, timeout_ms: int = 10_000, what: str = "condition") -> None:
    deadline = asyncio.get_event_loop().time() + timeout_ms / 1000
    while True:
        if await fn():
            return
        if asyncio.get_event_loop().time() > deadline:
            raise TimeoutError(f"timeout waiting for {what}")
        await asyncio.sleep(0.025)


async def tick_until_task_done(ctx: dict, task_id: str, max_ticks: int = 200) -> None:
    for _ in range(max_ticks):
        await ctx["svc"].scheduler.tick()
        t = await ctx["svc"].tasks.get(task_id)
        if t and t["status"] == "done":
            return
        await asyncio.sleep(0.02)
    t = await ctx["svc"].tasks.get(task_id)
    raise TimeoutError(f"task did not complete via scheduler (status={t and t['status']})")


def client(ctx: dict) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=ctx["app"]), base_url="http://test")
