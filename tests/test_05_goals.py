"""
Goal orchestrator tests. Mirrors test/05-goals.test.ts §22 #5.
"""
import pytest
from tests.helpers import make_context, new_project, agent_by_name, wait_for


@pytest.fixture
async def ctx(tmp_path):
    c = await make_context(tmp_path)
    yield c
    c["svc"].scheduler.stop()


@pytest.mark.asyncio
async def test_create_goal_drafts_dod(ctx):
    p = await new_project(ctx)
    g = await ctx["svc"].goals.create({
        "projectId": p["id"],
        "title": "Improve errors",
        "spec": "Make errors actionable.\n- Errors show failing operation\n- Errors suggest next step",
        "spendCapUsd": 5,
    })
    assert g["status"] == "active"
    assert len(g["definitionOfDone"]) >= 2
    assert not g["dodApproved"]


@pytest.mark.asyncio
async def test_approve_dod_starts_loop(ctx):
    p = await new_project(ctx)
    g = await ctx["svc"].goals.create({
        "projectId": p["id"],
        "title": "test goal",
        "spec": "do something\n- step one\n- step two",
        "spendCapUsd": 1,
    })
    approved = await ctx["svc"].goals.approve_dod(g["id"])
    assert approved["dodApproved"] is True
    assert approved["startedAt"] is not None


@pytest.mark.asyncio
async def test_orchestrator_spend_rail(ctx):
    p = await new_project(ctx)
    g = await ctx["svc"].goals.create({
        "projectId": p["id"],
        "title": "capped goal",
        "spec": "do x\n- item a\n- item b",
        "spendCapUsd": 1.0,
    })
    await ctx["svc"].goals.approve_dod(g["id"])
    # Exceed the cap
    await ctx["svc"].goals.add_spend(g["id"], 2.0)
    agents = await ctx["svc"].projects.list_agents(p["id"])
    allow_list = [{"id": a["id"], "name": a["name"]} for a in agents]
    decision = await ctx["svc"].goals.orchestrate(g["id"], allow_list)
    assert decision["action"] == "stop"
    assert decision["stopReason"] == "stopped-spend"


@pytest.mark.asyncio
async def test_complete_dod_item(ctx):
    p = await new_project(ctx)
    g = await ctx["svc"].goals.create({
        "projectId": p["id"],
        "title": "t",
        "spec": "do x\n- improve error messages\n- add tests",
        "spendCapUsd": 5,
    })
    updated = await ctx["svc"].goals.complete_dod_item(g["id"], "improve error messages")
    done_items = [d for d in updated["definitionOfDone"] if d["done"]]
    assert len(done_items) == 1


@pytest.mark.asyncio
async def test_orchestrator_completes_when_all_dod_done(ctx):
    p = await new_project(ctx)
    g = await ctx["svc"].goals.create({
        "projectId": p["id"],
        "title": "t",
        "spec": "do x\n- task a\n- task b",
        "spendCapUsd": 5,
    })
    await ctx["svc"].goals.approve_dod(g["id"])
    for item in g["definitionOfDone"]:
        await ctx["svc"].goals.complete_dod_item(g["id"], item["text"])
    agents = await ctx["svc"].projects.list_agents(p["id"])
    allow_list = [{"id": a["id"], "name": a["name"]} for a in agents]
    decision = await ctx["svc"].goals.orchestrate(g["id"], allow_list)
    assert decision["action"] == "complete"
