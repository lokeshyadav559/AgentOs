"""
AgentOS CLI. Port of src/cli/cli.ts.
Auth: AGENTOS_URL (default http://127.0.0.1:3000) + AGENTOS_TOKEN.
"""
import json
import os
import sys
from pathlib import Path

import httpx
import typer

app = typer.Typer(name="agentos", help="AgentOS CLI", no_args_is_help=True)
project_app = typer.Typer(help="Project commands")
task_app = typer.Typer(help="Task commands")
goal_app = typer.Typer(help="Goal commands")
agent_app = typer.Typer(help="Agent commands")
skill_app = typer.Typer(help="Skill commands")

app.add_typer(project_app, name="project")
app.add_typer(task_app, name="task")
app.add_typer(goal_app, name="goal")
app.add_typer(agent_app, name="agent")
app.add_typer(skill_app, name="skill")


def _base_url() -> str:
    return os.environ.get("AGENTOS_URL", "http://127.0.0.1:3000").rstrip("/")


def _token() -> str:
    t = os.environ.get("AGENTOS_TOKEN", "")
    if not t:
        typer.echo("Error: AGENTOS_TOKEN is not set", err=True)
        raise typer.Exit(1)
    return t


def _req(method: str, path: str, body: dict | None = None) -> dict:
    try:
        resp = httpx.request(
            method, f"{_base_url()}{path}",
            headers={"authorization": f"Bearer {_token()}", "content-type": "application/json"},
            content=json.dumps(body) if body is not None else None,
            timeout=30,
        )
        data = resp.json()
        if not resp.is_success:
            typer.echo(f"Error: {method} {path}: {data.get('detail') or data.get('error') or resp.status_code}", err=True)
            raise typer.Exit(1)
        return data
    except httpx.ConnectError:
        typer.echo(f"Error: cannot connect to {_base_url()} — is the server running?", err=True)
        raise typer.Exit(1)


def _resolve_project(project_slug_or_id: str) -> dict:
    projects = _req("GET", "/api/projects")
    match = next((p for p in projects if p["id"] == project_slug_or_id or p["slug"] == project_slug_or_id), None)
    if not match:
        typer.echo(f"Error: project '{project_slug_or_id}' not found", err=True)
        raise typer.Exit(1)
    return match


# ---------------------------------------------------------------------------
# Project
# ---------------------------------------------------------------------------

@project_app.command("create")
def project_create(
    name: str = typer.Argument(..., help="Project name"),
    slug: str = typer.Option(None, "--slug", help="URL slug (auto-generated from name if omitted)"),
):
    """Create a project."""
    body: dict = {"name": name}
    if slug:
        body["slug"] = slug
    p = _req("POST", "/api/projects", body)
    typer.echo(f"project created: {p['name']} ({p['id']})")


@project_app.command("list")
def project_list():
    """List projects."""
    projects = _req("GET", "/api/projects")
    for p in projects:
        typer.echo(f"  {p['slug']}  {p['id']}  {p['name']}")


# ---------------------------------------------------------------------------
# Task
# ---------------------------------------------------------------------------

@task_app.command("create")
def task_create(
    project: str = typer.Argument(..., help="Project slug or id"),
    name: str = typer.Option(..., "--name", "-n", help="Task name"),
    agent: str = typer.Option(None, "--agent", "-a", help="Agent name"),
    desc: str = typer.Option("", "--desc", "-d", help="Task description"),
    gate: bool = typer.Option(False, "--gate", help="Require human approval"),
    now: bool = typer.Option(False, "--now", help="Schedule immediately (default)"),
    run_at: str = typer.Option(None, "--at", help="Schedule at ISO datetime"),
    cron: str = typer.Option(None, "--cron", help="Cron expression"),
    tz: str = typer.Option(None, "--tz", help="Timezone for cron"),
    template: str = typer.Option(None, "--template", help="Template name"),
    branch: str = typer.Option(None, "--branch", help="Branch variable for template"),
    feature: str = typer.Option(None, "--feature", help="Feature title variable for template"),
):
    """Create a task."""
    p = _resolve_project(project)
    if template:
        templates = _req("GET", f"/api/projects/{p['id']}/templates")
        tpl = next((t for t in templates if t["name"] == template), None)
        if not tpl:
            typer.echo(f"Error: template '{template}' not found", err=True)
            raise typer.Exit(1)
        variables = {}
        if branch:
            variables["branchName"] = branch
        if feature:
            variables["featureTitle"] = feature
        chain = _req("POST", f"/api/projects/{p['id']}/templates/{tpl['id']}/instantiate",
                     {"variables": variables})
        typer.echo(f"template '{template}' instantiated → {len(chain)} tasks")
        return

    body: dict = {"name": name, "description": desc, "approvalGate": gate}
    if agent:
        agents_list = _req("GET", f"/api/projects/{p['id']}/agents")
        a = next((ag for ag in agents_list if ag["name"] == agent), None)
        if not a:
            typer.echo(f"Error: agent '{agent}' not found", err=True)
            raise typer.Exit(1)
        body["assigneeAgentId"] = a["id"]

    if run_at:
        body["scheduleKind"] = "at"
        body["runAt"] = run_at
    elif cron:
        body["scheduleKind"] = "cron"
        body["cron"] = cron
        if tz:
            body["timezone"] = tz
    else:
        body["scheduleKind"] = "now"

    t = _req("POST", f"/api/projects/{p['id']}/tasks", body)
    typer.echo(f"task created: {t['name']} ({t['id']})")


# ---------------------------------------------------------------------------
# Goal
# ---------------------------------------------------------------------------

@goal_app.command("create")
def goal_create(
    project: str = typer.Argument(..., help="Project slug or id"),
    title: str = typer.Option(..., "--title", "-t", help="Goal title"),
    spec_file: str = typer.Option(None, "--spec-file", help="Path to spec file"),
    spec: str = typer.Option(None, "--spec", help="Inline spec text"),
    dod: str = typer.Option(None, "--dod", help="DoD items separated by |"),
    cap: float = typer.Option(None, "--cap", help="Spend cap USD"),
    max_min: int = typer.Option(None, "--max-min", help="Max duration minutes"),
    runner: str = typer.Option("auto", "--runner", help="Runner preference (cloud|local|auto)"),
    confirm_no_cap: bool = typer.Option(False, "--confirm-no-cap", help="Allow uncapped spend"),
    stuck: int = typer.Option(19, "--stuck", help="Stuck threshold"),
):
    """Create a goal."""
    p = _resolve_project(project)
    spec_text = ""
    if spec_file:
        spec_text = Path(spec_file).read_text()
    elif spec:
        spec_text = spec
    else:
        typer.echo("Error: --spec or --spec-file is required", err=True)
        raise typer.Exit(1)

    body: dict = {
        "title": title, "spec": spec_text,
        "runnerPreference": runner, "stuckThreshold": stuck,
        "confirmNoCap": confirm_no_cap,
    }
    if cap is not None:
        body["spendCapUsd"] = cap
    if max_min is not None:
        body["maxDurationMinutes"] = max_min
    if dod:
        body["definitionOfDone"] = [d.strip() for d in dod.split("|") if d.strip()]

    g = _req("POST", f"/api/projects/{p['id']}/goals", body)
    typer.echo(f"goal created: {g['title']} ({g['id']}) — {len(g['definitionOfDone'])} DoD items")
    typer.echo("  → approve DoD in the UI to start the goal loop")


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

@agent_app.command("update")
def agent_update(
    project: str = typer.Argument(...),
    name: str = typer.Argument(...),
    model: str = typer.Option(None, "--model"),
    role_prompt_file: str = typer.Option(None, "--role-prompt-file"),
    runner: str = typer.Option(None, "--runner"),
    inbox: str = typer.Option(None, "--inbox", help="on|off"),
):
    """Update an agent."""
    p = _resolve_project(project)
    body: dict = {"name": name}
    if model:
        body["model"] = model
    if role_prompt_file:
        body["rolePrompt"] = Path(role_prompt_file).read_text()
    if runner:
        body["runnerPreference"] = runner
    if inbox:
        body["inboxAccess"] = inbox.lower() in ("on", "true", "1", "yes")
    _req("PUT", f"/api/projects/{p['id']}/agents/{name}", body)
    typer.echo(f"agent '{name}' updated")


# ---------------------------------------------------------------------------
# Skill
# ---------------------------------------------------------------------------

@skill_app.command("create")
def skill_create(
    project: str = typer.Argument(...),
    slug: str = typer.Option(..., "--slug"),
    name: str = typer.Option(None, "--name"),
    body_text: str = typer.Option(None, "--body"),
    file: str = typer.Option(None, "--file"),
):
    """Create a skill."""
    p = _resolve_project(project)
    skill_body: dict = {
        "name": name or slug, "slug": slug,
        "kind": "prompt" if not file else "file",
    }
    if body_text:
        skill_body["body"] = body_text
    if file:
        skill_body["filePath"] = file
    s = _req("POST", f"/api/projects/{p['id']}/skills", skill_body)
    typer.echo(f"skill created: {s['name']} ({s['id']})")


# ---------------------------------------------------------------------------
# YAML push / pull
# ---------------------------------------------------------------------------

@app.command("push")
def push(
    project: str = typer.Argument(..., help="Project slug or id"),
    file: str = typer.Argument(..., help="Path to agentos.yml"),
):
    """Sync local YAML → control plane."""
    p = _resolve_project(project)
    yaml_text = Path(file).read_text()
    _req("PUT", f"/api/projects/{p['id']}/yaml", {"yaml": yaml_text})
    typer.echo(f"pushed {file} → project '{p['slug']}'")


@app.command("pull")
def pull(
    project: str = typer.Argument(..., help="Project slug or id"),
    output: str = typer.Option(None, "-o", "--output", help="Output file (default: stdout)"),
):
    """Sync control plane → local YAML."""
    p = _resolve_project(project)
    data = _req("GET", f"/api/projects/{p['id']}/yaml")
    yaml_text = data.get("yaml", "")
    if output:
        Path(output).write_text(yaml_text)
        typer.echo(f"pulled → {output}")
    else:
        typer.echo(yaml_text)


if __name__ == "__main__":
    app()
