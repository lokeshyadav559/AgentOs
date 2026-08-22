"""
Seed script: creates a demo project with the default agent catalog, a
feature-template task chain, a goal, a trigger, and a weekly automation.

    python -m agentos.db.seed
"""
import asyncio
import uuid


async def main() -> None:
    from agentos.config import load_config
    from agentos.db.client import create_tables, get_session, init_engine
    from agentos.db.models import Automation
    from agentos.services.registry import build_services

    config = load_config()
    init_engine(config.db_path)
    await create_tables()

    services = await build_services(config)

    existing = await services.projects.list()
    if any(p["slug"] == "demo" for p in existing):
        print("demo project already exists — delete ./data to reseed")
        return

    demo = await services.projects.create({"name": "demo"})
    print(f"project: {demo['name']} ({demo['id']})")

    agents_list = await services.projects.list_agents(demo["id"])
    agent_by_name = {a["name"]: a for a in agents_list}
    default_agent = agent_by_name.get("default")
    linkedin_agent = agent_by_name.get("linkedin-content")
    support_agent = agent_by_name.get("customer-support")

    # 1) Feature-template task chain
    templates = await services.tasks.list_templates(demo["id"])
    tpl = next((t for t in templates if t["name"] == "compound-engineer-workflow"), None)
    if tpl:
        chain = await services.tasks.instantiate_template(
            demo["id"], tpl["id"],
            {"branchName": "feat/dark-mode", "featureTitle": "Dark mode"},
        )
        print(f"template instantiated → {len(chain)} tasks")

    # 2) Simple immediate task
    if default_agent:
        await services.tasks.create(demo["id"], {
            "name": "Update onboarding docs",
            "description": "Refresh the README onboarding section with the new CLI flags.",
            "assigneeAgentId": default_agent["id"],
        })
        print("task: Update onboarding docs")

    # 3) Goal with spend cap
    goal = await services.goals.create({
        "projectId": demo["id"],
        "title": "Improve error messages",
        "spec": "Make runtime errors actionable.\n- Errors include the failing operation\n- Errors suggest next step",
        "spendCapUsd": 5,
    })
    print(f"goal: \"{goal['title']}\" ({len(goal['definitionOfDone'])} DoD items)")

    # 4) HMAC-signed webhook trigger
    if support_agent:
        trigger = await services.triggers.create({
            "projectId": demo["id"],
            "name": "support-inbound",
            "agentId": support_agent["id"],
            "jobPrompt": "Support conversation:\n{{payload}}",
        })
        print(f"trigger: support-inbound → POST /hooks/{trigger['id']}")

    # 5) Weekly automation
    if linkedin_agent:
        async with get_session() as db:
            db.add(Automation(
                id=str(uuid.uuid4()),
                project_id=demo["id"],
                name="weekly-linkedin",
                cron="0 9 * * 1",
                timezone="UTC",
                agent_id=linkedin_agent["id"],
                task_body="Draft this week's LinkedIn post.",
            ))
            await db.commit()
        print("automation: weekly-linkedin (Mon 09:00 UTC)")

    await services.scheduler.tick()
    print("\nseeded — open the UI, approve the goal DoD, and watch the loop.")


if __name__ == "__main__":
    asyncio.run(main())
