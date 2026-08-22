"""
Phase 1 acceptance: one agent, one task, one session.
Mirrors test/01-mvp.test.ts §22 #1.
"""
import pytest
import pytest_asyncio
from pathlib import Path

from tests.helpers import make_context, new_project, agent_by_name, create_task, wait_for, client


@pytest.fixture
async def ctx(tmp_path):
    c = await make_context(tmp_path)
    yield c
    c["svc"].scheduler.stop()


@pytest.mark.asyncio
async def test_task_lifecycle(ctx):
    """Create task → scheduler dispatches → simulated agent marks done → session destroyed."""
    p = await new_project(ctx)
    agent = await agent_by_name(ctx, p["id"], "default")
    task = await create_task(ctx, p["id"], name="hello", description="do the thing",
                              assigneeAgentId=agent["id"])

    await ctx["svc"].scheduler.tick()
    await wait_for(lambda: _task_done(ctx, task["id"]), timeout_ms=10_000, what="task done")

    done = await ctx["svc"].tasks.get(task["id"])
    assert done["status"] == "done"
    assert len(done["sessionIds"]) == 1

    session_id = done["sessionIds"][0]
    await wait_for(lambda: _session_done(ctx, session_id), timeout_ms=5_000, what="session destroyed")

    session = await ctx["svc"].sessions.get(session_id)
    assert session["status"] == "destroyed"
    assert any(t["name"] == "tasks.set_status" for t in session["toolCallLog"])
    assert "agentos" in (session["manifest"] or {}).get("mcpConnections", [])


async def _task_done(ctx, task_id: str) -> bool:
    t = await ctx["svc"].tasks.get(task_id)
    return bool(t and t["status"] == "done")


async def _session_done(ctx, session_id: str) -> bool:
    s = await ctx["svc"].sessions.get(session_id)
    return bool(s and s["status"] in ("destroyed", "failed"))


@pytest.mark.asyncio
async def test_api_health(ctx):
    async with client(ctx) as c:
        resp = await c.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


@pytest.mark.asyncio
async def test_login_and_me(ctx):
    async with client(ctx) as c:
        resp = await c.post("/api/login", json={"token": "test-operator-token"})
        assert resp.status_code == 200
        resp2 = await c.get("/api/me", headers=ctx["auth"])
        assert resp2.json()["operator"] is True


@pytest.mark.asyncio
async def test_create_project(ctx):
    async with client(ctx) as c:
        resp = await c.post("/api/projects", json={"name": "acme"}, headers=ctx["auth"])
    assert resp.status_code == 201
    assert resp.json()["slug"] == "acme"
