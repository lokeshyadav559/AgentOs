#!/usr/bin/env node
/**
 * agentos CLI (§17).
 *
 *   agentos help
 *   agentos project create <name> [--slug s]
 *   agentos task create <project> --name N --agent A [--desc D] [--schedule-now|--run-at ISO|--cron "m h dom mon dow"] [--template T --branch B --feature F]
 *   agentos goal create <project> --title T --spec-file F [--dod "item1|item2"] [--cap USD] [--max-min N] [--runner cloud|local|auto] [--confirm-no-cap] [--stuck N]
 *   agentos agent update <project> <name> [--model M] [--role-prompt-file F] [--runner cloud|local|inherit] [--inbox on|off]
 *   agentos skill create <project> --slug S [--name N] [--body B] [--file F]
 *   agentos push <project> <agentos.yml>
 *   agentos pull <project> [-o out.yml]
 *
 * Auth: AGENTOS_URL (default http://127.0.0.1:3000) + AGENTOS_TOKEN.
 */
import { readFileSync } from "node:fs";

const HELP = `agentos — AgentOS CLI

Usage:
  agentos help                                  show this help
  agentos project create <name> [--slug s]      create a project
  agentos task create <project> ...             create a task (see below)
  agentos goal create <project> ...             create a goal
  agentos agent update <project> <name> ...     adjust an agent
  agentos skill create <project> ...            create a skill
  agentos push <project> <file.yml>             sync local YAML → control plane
  agentos pull <project> [-o file.yml]          sync control plane → local YAML

Task options:
  --name N --agent A [--desc D] [--gate] [--attachments id,...]
  --now | --at ISO | --cron "m h dom mon dow" [--tz TZ]
  --template T --branch B --feature F

Goal options:
  --title T --spec-file F [--dod "a|b|c"] [--cap USD] [--max-min N]
  [--runner cloud|local|auto] [--confirm-no-cap] [--stuck N]

Agent options:
  --model M --role-prompt-file F --runner cloud|local|inherit --inbox on|off

Skill options:
  --slug S --name N --body "text" | --file /path/to/script.py

Environment: AGENTOS_URL (default http://127.0.0.1:3000), AGENTOS_TOKEN.
`;

function fail(msg: string): never {
  console.error(`agentos: ${msg}`);
  process.exit(1);
}

function apiUrl(): string {
  return process.env.AGENTOS_URL ?? "http://127.0.0.1:3000";
}

function token(): string {
  const t = process.env.AGENTOS_TOKEN;
  if (!t) fail("AGENTOS_TOKEN is not set (see `agentos help`)");
  return t;
}

async function req(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) fail(`${method} ${path}: ${json.error ?? res.status}`);
  return json;
}

function parseArgs(argv: string[]): { flags: Record<string, string>; positionals: string[] } {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("-")) {
      const key = a.replace(/^--?/, "");
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positionals } = parseArgs(rest);

  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return;

    case "project": {
      const sub = positionals[0];
      if (sub === "create") {
        const name = positionals[1] ?? fail("project create <name>");
        const p = await req("POST", "/api/projects", { name, slug: flags.slug || undefined });
        console.log(`project created: ${p.name} (${p.id}) — default agents/templates seeded`);
        return;
      }
      break;
    }

    case "task": {
      const sub = positionals[0];
      if (sub === "create") {
        const projectSlug = positionals[1] ?? fail("task create <project>");
        const project = await findProject(projectSlug);
        const name = flags.name ?? fail("--name required");
        const agentName = flags.agent ?? fail("--agent required");
        const agent = (await req("GET", `/api/projects/${project.id}/agents`)).find(
          (a: { name: string }) => a.name === agentName,
        );
        if (!agent) fail(`unknown agent "${agentName}" in project`);
        const body: Record<string, unknown> = {
          name,
          description: flags.desc ?? "",
          assigneeAgentId: agent.id,
          approvalGate: flags.gate === "true",
          scheduleKind: flags.cron ? "cron" : flags.at ? "at" : "now",
          cron: flags.cron ?? null,
          runAt: flags.at ? new Date(flags.at).toISOString() : null,
          timezone: flags.tz ?? "UTC",
        };
        if (flags.template) {
          const tpls = await req("GET", `/api/projects/${project.id}/templates`);
          const tpl = tpls.find((t: { name: string }) => t.name === flags.template);
          if (!tpl) fail(`unknown template "${flags.template}"`);
          body.templateId = tpl.id;
          body.variables = { branchName: flags.branch ?? "agentos", featureTitle: flags.feature ?? name };
        }
        const task = await req("POST", `/api/projects/${project.id}/tasks`, body);
        console.log(`task created: ${task.name} (${task.status}) — ${task.id}`);
        return;
      }
      break;
    }

    case "goal": {
      const sub = positionals[0];
      if (sub === "create") {
        const projectSlug = positionals[1] ?? fail("goal create <project>");
        const project = await findProject(projectSlug);
        const title = flags.title ?? fail("--title required");
        const specFile = flags["spec-file"] ?? fail("--spec-file required");
        const spec = readFileSync(specFile, "utf8");
        const body: Record<string, unknown> = {
          title,
          spec,
          definitionOfDone: flags.dod ? flags.dod.split("|").map((s) => s.trim()).filter(Boolean) : undefined,
          spendCapUsd: flags.cap !== undefined ? Number(flags.cap) : null,
          maxDurationMinutes: flags["max-min"] !== undefined ? Number(flags["max-min"]) : null,
          runnerPreference: flags.runner ?? "auto",
          stuckThreshold: flags.stuck !== undefined ? Number(flags.stuck) : 19,
        };
        const g = await req("POST", `/api/projects/${project.id}/goals`, body).catch((e) => {
          if (String(e).includes("spend cap")) {
            if (flags["confirm-no-cap"] !== "true") {
              fail("goal has no spend cap — pass --confirm-no-cap to run uncapped");
            }
            return req("POST", `/api/projects/${project.id}/goals`, { ...body, confirmNoCap: true });
          }
          throw e;
        });
        console.log(`goal created: ${g.title} (${g.definitionOfDone.length} DoD items drafted) — ${g.id}`);
        console.log(`approve the DoD in the UI, then the loop starts.`);
        return;
      }
      break;
    }

    case "agent": {
      const sub = positionals[0];
      if (sub === "update") {
        const projectSlug = positionals[1] ?? fail("agent update <project> <name>");
        const name = positionals[2] ?? fail("agent update <project> <name>");
        const project = await findProject(projectSlug);
        const body: Record<string, unknown> = { name };
        if (flags.model) body.model = flags.model;
        if (flags["role-prompt-file"]) body.rolePrompt = readFileSync(flags["role-prompt-file"], "utf8");
        if (flags.runner) body.runnerPreference = flags.runner;
        if (flags.inbox) body.inboxAccess = flags.inbox === "on";
        const updated = await req("PUT", `/api/projects/${project.id}/agents/${name}`, body);
        console.log(`agent updated: ${updated.name} (model=${updated.model}, runner=${updated.runnerPreference})`);
        return;
      }
      break;
    }

    case "skill": {
      const sub = positionals[0];
      if (sub === "create") {
        const projectSlug = positionals[1] ?? fail("skill create <project>");
        const project = await findProject(projectSlug);
        const slug = flags.slug ?? fail("--slug required");
        const body: Record<string, unknown> = {
          name: flags.name ?? slug,
          slug,
          kind: flags.file ? "file" : "prompt",
          body: flags.body ?? null,
          filePath: flags.file ?? null,
        };
        const s = await req("POST", `/api/projects/${project.id}/skills`, body);
        console.log(`skill created: /${s.slug} (${s.kind})`);
        return;
      }
      break;
    }

    case "push": {
      const projectSlug = positionals[0] ?? fail("push <project> <file.yml>");
      const file = positionals[1] ?? fail("push <project> <file.yml>");
      const project = await findProject(projectSlug);
      const yaml = readFileSync(file, "utf8");
      await req("PUT", `/api/projects/${project.id}/yaml`, { yaml });
      console.log(`pushed ${file} → project "${project.name}"`);
      return;
    }

    case "pull": {
      const projectSlug = positionals[0] ?? fail("pull <project>");
      const project = await findProject(projectSlug);
      const { yaml } = await req("GET", `/api/projects/${project.id}/yaml`);
      if (flags.o) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(flags.o, yaml);
        console.log(`pulled project "${project.name}" → ${flags.o}`);
      } else {
        process.stdout.write(yaml);
      }
      return;
    }

    default:
      fail(`unknown command "${cmd}" — run \`agentos help\``);
  }
  fail(`unknown subcommand — run \`agentos help\``);
}

async function findProject(slugOrName: string): Promise<{ id: string; name: string }> {
  const projects = await req("GET", "/api/projects");
  const p = projects.find(
    (x: { slug: string; name: string }) => x.slug === slugOrName || x.name === slugOrName,
  );
  if (!p) fail(`project "${slugOrName}" not found`);
  return p;
}

void main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
