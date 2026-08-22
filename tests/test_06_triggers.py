"""
Webhook trigger tests. Mirrors test/06-triggers.test.ts §22 #6.
"""
import pytest
from tests.helpers import make_context, new_project, agent_by_name, client
from agentos.config import hmac_hex


@pytest.fixture
async def ctx(tmp_path):
    c = await make_context(tmp_path)
    yield c
    c["svc"].scheduler.stop()


@pytest.mark.asyncio
async def test_trigger_create_and_verify(ctx):
    p = await new_project(ctx)
    agent = await agent_by_name(ctx, p["id"], "default")
    t = await ctx["svc"].triggers.create({
        "projectId": p["id"],
        "name": "test-hook",
        "agentId": agent["id"],
    })
    assert t["id"]
    assert t["webhookSecret"]

    raw = '{"event": "test"}'
    sig = hmac_hex(t["webhookSecret"], raw)
    assert ctx["svc"].triggers.verify(t["webhookSecret"], raw, sig)
    assert not ctx["svc"].triggers.verify(t["webhookSecret"], raw, "bad-sig")


@pytest.mark.asyncio
async def test_webhook_fires_task(ctx):
    p = await new_project(ctx)
    agent = await agent_by_name(ctx, p["id"], "default")
    t = await ctx["svc"].triggers.create({
        "projectId": p["id"],
        "name": "hook",
        "agentId": agent["id"],
        "jobPrompt": "Event: {{payload}}",
    })
    raw = '{"type":"push"}'
    task = await ctx["svc"].triggers.fire(t["id"], raw, {"type": "push"})
    assert task["name"].startswith("hook")
    assert "push" in task["description"]


@pytest.mark.asyncio
async def test_webhook_endpoint_rejects_bad_sig(ctx):
    p = await new_project(ctx)
    agent = await agent_by_name(ctx, p["id"], "default")
    t = await ctx["svc"].triggers.create({
        "projectId": p["id"], "name": "hook2", "agentId": agent["id"],
    })
    async with client(ctx) as c:
        resp = await c.post(
            f"/hooks/{t['id']}",
            content='{"x":1}',
            headers={"content-type": "application/json", "x-agentos-signature": "bad"},
        )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_webhook_endpoint_fires_with_valid_sig(ctx):
    p = await new_project(ctx)
    agent = await agent_by_name(ctx, p["id"], "default")
    t = await ctx["svc"].triggers.create({
        "projectId": p["id"], "name": "hook3", "agentId": agent["id"],
    })
    raw = '{"x":1}'
    sig = hmac_hex(t["webhookSecret"], raw)
    async with client(ctx) as c:
        resp = await c.post(
            f"/hooks/{t['id']}",
            content=raw,
            headers={"content-type": "application/json", "x-agentos-signature": sig},
        )
    assert resp.status_code == 201
    assert resp.json()["ok"] is True
