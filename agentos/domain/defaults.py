"""
Default project catalog. Port of src/domain/defaults.ts.
Agents, environments, skills, MCP connections, and the compound-engineer-workflow template.
"""
from agentos.prompts.prompts import FOUNDATIONAL_PROMPT, PLAN_MODE_SKILL_BODY, ROLE_PROMPTS
from agentos.runners.models import DEFAULT_MODELS


def _home_grant(slug: str) -> dict:
    return {"folderPath": f"/agents/{slug}", "canRead": True, "canWrite": True, "canDelete": True}


_GOAL_GRANT = {"folderPath": "/goals/", "canRead": True, "canWrite": True, "canDelete": False}
_WIKI_GRANT = {"folderPath": "/wiki", "canRead": True, "canWrite": True, "canDelete": False}

_PLANNER = DEFAULT_MODELS["planner"]
_WORKER = DEFAULT_MODELS["worker"]


def project_defaults(project_id: str) -> dict:
    env_none = "limited-none"
    env_open = "open"

    environments = [
        {"project_id": project_id, "name": "limited-none", "networking": "limited",
         "allowed_hosts": ["api.front.com"], "env_names": []},
        {"project_id": project_id, "name": "open", "networking": "open",
         "allowed_hosts": [], "env_names": []},
    ]

    skills = [
        {"project_id": project_id, "name": "Plan mode", "slug": "plan-mode",
         "kind": "prompt", "body": PLAN_MODE_SKILL_BODY, "file_path": None},
    ]

    mcp_connections = [
        {"project_id": project_id, "name": "agentos", "config": {"builtin": True}, "credential_secret_id": None},
        {"project_id": project_id, "name": "inbox", "config": {"builtin": True}, "credential_secret_id": None},
        {"project_id": project_id, "name": "r2-fs", "config": {"builtin": True}, "credential_secret_id": None},
        {"project_id": project_id, "name": "github", "config": {"provider": "github", "url": "https://api.github.com"}, "credential_secret_id": None},
        {"project_id": project_id, "name": "front", "config": {"provider": "front", "url": "https://api.front.com"}, "credential_secret_id": None},
    ]

    def agent(name, title, model, role=None, mcp=None, grants=None, collab=None,
              env=None, runner="inherit", inbox=False, skills_list=None):
        return {
            "project_id": project_id,
            "name": name, "title": title, "model": model,
            "foundational_prompt": FOUNDATIONAL_PROMPT,
            "role_prompt": role or ROLE_PROMPTS.get(name, ROLE_PROMPTS["default"]),
            "skill_ids": skills_list or [],
            "mcp_connection_ids": mcp or ["agentos", "inbox", "r2-fs"],
            "repo_access": [],
            "filesystem_grants": grants or [_home_grant(name), _GOAL_GRANT],
            "collaboration_list": collab or [],
            "environment_id": env or env_none,
            "runner_preference": runner,
            "inbox_access": inbox,
        }

    agents = [
        agent("default", "Default workhorse", _WORKER, env=env_open),
        agent("plan", "Plan agent", _PLANNER, role=ROLE_PROMPTS["plan"],
              skills_list=["skill-plan-mode"], runner="cloud"),
        agent("spec", "Spec agent", _PLANNER, role=ROLE_PROMPTS["spec"], runner="cloud", inbox=True),
        agent("senior-dev", "Senior developer", _WORKER, role=ROLE_PROMPTS["senior-dev"],
              mcp=["agentos", "inbox", "r2-fs", "github"], env=env_open),
        agent("implementation-plan-executioner", "Implementation plan executioner", _WORKER,
              role=ROLE_PROMPTS["implementation-plan-executioner"],
              mcp=["agentos", "inbox", "r2-fs", "github"], env=env_open),
        agent("review-coordinator", "Review coordinator", _PLANNER,
              role=ROLE_PROMPTS["review-coordinator"],
              collab=["feasibility", "scope-guardian", "coherence", "plan-risk"], runner="cloud"),
        agent("feasibility", "Feasibility reviewer", _PLANNER, role=ROLE_PROMPTS["feasibility"], runner="cloud"),
        agent("scope-guardian", "Scope guardian", _PLANNER, role=ROLE_PROMPTS["scope-guardian"], runner="cloud"),
        agent("coherence", "Coherence reviewer", _PLANNER, role=ROLE_PROMPTS["coherence"], runner="cloud"),
        agent("plan-risk", "Plan risk reviewer", _PLANNER, role=ROLE_PROMPTS["plan-risk"], runner="cloud"),
        agent("librarian", "Librarian", _WORKER, role=ROLE_PROMPTS["librarian"],
              grants=[_home_grant("librarian"), _WIKI_GRANT], env=env_open),
        agent("customer-support", "Customer support", _WORKER, role=ROLE_PROMPTS["customer-support"],
              mcp=["agentos", "inbox", "front"], env=env_none, inbox=True),
        agent("diagnostic", "Bug diagnostic", _WORKER, role=ROLE_PROMPTS["diagnostic"],
              mcp=["agentos", "inbox", "r2-fs", "github"], env=env_open),
        agent("linkedin-content", "LinkedIn content", _WORKER,
              role=ROLE_PROMPTS["linkedin-content"], env=env_none),
    ]

    templates = [
        {
            "project_id": project_id,
            "name": "compound-engineer-workflow",
            "description": "~3-hour fully managed feature build: spec → plan → review → revise → implement → code review → fixes → wiki → human PR review.",
            "variables": ["branchName", "featureTitle"],
            "steps": compound_engineer_steps(),
        }
    ]

    return {"agents": agents, "environments": environments, "skills": skills,
            "mcp_connections": mcp_connections, "templates": templates}


def compound_engineer_steps() -> list[dict]:
    return [
        {"name": "Write a spec", "agentName": "spec",
         "prompt": "Write a detailed feature specification for {{featureTitle}} (branch {{branchName}}). "
                   "Deliverable: a spec file attached to the task. Exit: spec attached, awaiting human approval — do not mark done.",
         "approvalGate": True},
        {"name": "Plan", "agentName": "plan",
         "prompt": "Turn the approved spec for {{featureTitle}} (branch {{branchName}}) into a concrete, ordered implementation plan. "
                   "Deliverable: a plan file attached to the task. Exit: plan attached, task finished. Do not implement.",
         "approvalGate": False},
        {"name": "Plan review", "agentName": "review-coordinator",
         "prompt": "Spawn the plan-review specialists for {{featureTitle}}. "
                   "Deliverable: consolidated report with must-fix / should-fix items. Exit: every specialist reported and consolidation attached.",
         "approvalGate": False},
        {"name": "Revise plan", "agentName": "plan",
         "prompt": "Revise the plan for {{featureTitle}} using the consolidated review. "
                   "Deliverable: revised plan attached. Exit: must-fix items addressed.",
         "approvalGate": False},
        {"name": "Implementation", "agentName": "implementation-plan-executioner",
         "prompt": "Implement {{featureTitle}} on branch {{branchName}} exactly per the revised plan. "
                   "Deliverable: committed implementation. Exit: all steps done, E2E run, work committed.",
         "approvalGate": False},
        {"name": "Code review", "agentName": "review-coordinator",
         "prompt": "Spawn code-review specialists for {{featureTitle}} on branch {{branchName}}. "
                   "Deliverable: consolidated report. Exit: every specialist reported.",
         "approvalGate": False},
        {"name": "Apply review fixes", "agentName": "senior-dev",
         "prompt": "Apply consolidated code-review fixes for {{featureTitle}} on branch {{branchName}}. "
                   "Deliverable: committed fixes. Exit: must-fix resolved, E2E passing.",
         "approvalGate": False},
        {"name": "Librarian", "agentName": "librarian",
         "prompt": "Update the internal wiki to reflect {{featureTitle}} on branch {{branchName}}. "
                   "Deliverable: updated wiki pages. Exit: wiki updated.",
         "approvalGate": False},
        {"name": "Human PR review", "agentName": "human",
         "prompt": "Review and merge the PR for {{featureTitle}} on branch {{branchName}}.",
         "approvalGate": True},
    ]


def bugfix_chain_steps() -> list[dict]:
    return [
        {"name": "Implement fix", "agentName": "implementation-plan-executioner",
         "prompt": "Implement the fix for {{featureTitle}} on branch {{branchName}}. Context: {{bugContext}}", "approvalGate": False},
        {"name": "Plan", "agentName": "plan",
         "prompt": "Turn the fix into a concrete plan for {{featureTitle}} on branch {{branchName}}.", "approvalGate": False},
        {"name": "Plan review", "agentName": "review-coordinator",
         "prompt": "Review the fix plan ({{featureTitle}}, branch {{branchName}}) and consolidate must-fix / should-fix.", "approvalGate": False},
        {"name": "Apply review fixes", "agentName": "senior-dev",
         "prompt": "Apply consolidated review fixes for {{featureTitle}} on branch {{branchName}}. Commit.", "approvalGate": False},
        {"name": "E2E verification", "agentName": "implementation-plan-executioner",
         "prompt": "Run E2E tests for {{featureTitle}} on branch {{branchName}}; fix failures; commit.", "approvalGate": False},
        {"name": "Human merge", "agentName": "human",
         "prompt": "Review and merge the bug fix for {{featureTitle}} on branch {{branchName}}.", "approvalGate": True},
    ]
