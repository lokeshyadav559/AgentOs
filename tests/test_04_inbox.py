"""
Inbox tests. Mirrors test/04-inbox.test.ts §22 #4.
"""
import pytest
from tests.helpers import make_context, new_project, agent_by_name, create_task, wait_for, client


@pytest.fixture
async def ctx(tmp_path):
    c = await make_context(tmp_path)
    yield c
    c["svc"].scheduler.stop()


@pytest.mark.asyncio
async def test_inbox_send_and_reply(ctx):
    p = await new_project(ctx)
    msg = await ctx["svc"].inbox.send(
        from_="agent", agent_id=None, session_id=None,
        task_id=None, goal_id=None, body="need a decision",
    )
    assert msg["status"] == "open"
    assert msg["kind"] == "text"

    msgs = await ctx["svc"].inbox.list()
    assert any(m["id"] == msg["id"] for m in msgs)

    replied = await ctx["svc"].inbox.reply(msg["id"], body="go ahead")
    assert replied["status"] == "answered"


@pytest.mark.asyncio
async def test_inbox_multiple_choice(ctx):
    msg = await ctx["svc"].inbox.send(
        from_="agent", kind="multiple-choice",
        body="which option?", choices=["A", "B", "C"],
    )
    assert len(msg["choices"]) == 3
    choice_id = msg["choices"][0]["id"]
    replied = await ctx["svc"].inbox.reply(msg["id"], selected_choice_id=choice_id)
    assert replied["selectedChoiceId"] == choice_id


@pytest.mark.asyncio
async def test_inbox_api(ctx):
    async with client(ctx) as c:
        # Post a message via service, then retrieve via API
        msg = await ctx["svc"].inbox.send(from_="agent", body="hello human")
        resp = await c.get("/api/inbox", headers=ctx["auth"])
        assert resp.status_code == 200
        ids = [m["id"] for m in resp.json()]
        assert msg["id"] in ids

        resp2 = await c.post(f"/api/inbox/{msg['id']}/reply",
                              json={"body": "ok"}, headers=ctx["auth"])
        assert resp2.status_code == 200
