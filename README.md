# AgentOS

A personal **AgentOS**: a control plane + UI on top of Claude Agent SDK / Claude
managed agents. You set a goal or file a task, assign a scoped agent, and walk
away. Agents run in ephemeral sessions, do the work (plan, implement, review,
commit), and only message you when they are stuck or need a decision.

Built exactly per [`agentos-blueprint.md`](./agentos-blueprint.md)
(reconstructed from Danny Postma's talk *How I Built My Own AgentOS on Claude's
Agent SDK (So You Can Too)*). The reconstruction provenance is a docs/code
matter — agent-facing prompts never carry the label.
The reconstructed one-paragraph contracts are restructured along
DeepSeek-Harness-style agent-engineering lines (see the §8 revision note in
the blueprint): a foundational prompt with explicit sections for environment
facts, tool discipline, work management, communication, delegation, the
completion contract, error recovery and safety; role prompts with a
`Mission / Process / Deliverable / Exit criteria / Do not` skeleton; a
structured-decision orchestrator prompt; and a DoD-aware goal loop that
dispatches the specialist whose mission best matches the first unsatisfied
definition-of-done item (round-robin fallback).

> One-page operator story (§25 of the blueprint): You define agents (plan,
> senior-dev, …) with only the tools they need. You file a task or a goal.
> AgentOS starts a throwaway container, clones the allowed repo, injects
> allowed secrets, and lets that agent work. When it needs you, you get an
> inbox push. When it is done, the container is gone and a commit or a PR is
> left behind. Recurring jobs and webhooks use the same path. A feature
> template runs spec (you approve) → plan → multi-agent plan review → revise →
> implement with E2E → code review → fixes → wiki → you merge. A goal loop
> keeps dispatching specialists until the definition of done is checked, or
> spend/time/stuck rails stop it.

---

## Quickstart

```bash
pnpm install
pnpm build          # compile server + CLI (tsc)
pnpm test           # acceptance suite (§22 of the blueprint)

pnpm start          # starts the control plane on http://127.0.0.1:3000
```

The first run prints an **operator token** — that is your single-operator login
for the UI (`http://127.0.0.1:3000`) and the CLI (`AGENTOS_TOKEN`).

Without an API key the system runs in **demo/test mode**: sessions are
driven by a deterministic simulated agent through the exact same in-process MCP
servers, so every ACL, gate and inbox mechanic works end-to-end. Bring your own
key to route real sessions:

- `ANTHROPIC_API_KEY` → Claude Agent SDK (cloud) for `claude-*` / planner models.
- `DEEPSEEK_API_KEY` (optional `DEEPSEEK_BASE_URL`) → DeepSeek (cloud, BYOK) for
  `deepseek-*` / worker models.

```bash
# CLI
export AGENTOS_URL=http://127.0.0.1:3000 AGENTOS_TOKEN=<token>
agentos help
agentos project create acme
agentos task create acme --name "Add dark mode" --agent default
agentos goal create acme --title "Ship search" --spec-file spec.md --cap 20
agentos pull acme -o agentos.yml && agentos push acme agentos.yml
```

## What is inside

| Surface | Where |
|---|---|
| Kanban tasks (`todo → doing → review → done`), approval gates, follow-up chains, schedule-at & recurring cron | UI → Tasks · API `POST /api/projects/:id/tasks` |
| `compound-engineer-workflow` template (9 steps, 4 plan reviewers incl. reconstructed `plan-risk`) and `bugfix-chain` (implement → plan → plan review → fix → E2E → human merge) | seeded per project |
| Goals / gauntlet loop: DoD draft + human approval, orchestrator after every session, spend / time / stuck-at-N rails | UI → Goals |
| Inbox: text + multiple-choice questions, reply resumes the waiting session, web push | UI → Inbox |
| Least privilege: per-agent MCP / repo / env / filesystem-folder / collaboration / network grants; default deny | UI → Agents, Environments, MCPs, Repos, Secrets |
| Model-driven cloud routing (BYOK): `claude-*` → Anthropic, `deepseek-*` → DeepSeek, workers default to `deepseek-chat` | `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` · UI → Agents (model) · `src/runners/routing.ts` |
| Persistent filesystem (R2-style): folder ACLs with separate read/write/delete, file browser + editor | UI → Files · MCP `r2-fs` |
| Webhook triggers (HMAC-signed) + cron automations | UI → Triggers, Automations · `POST /hooks/:id` |
| Live session viewer (SSE tool-call stream) + persisted tool logs + global activity feed | UI → Sessions, Activity |
| YAML-as-code (`agentos.yml`) with push/pull | `agentos push/pull` |
| PWA: installable, mobile-responsive inbox, web push | served by the same server |

## Architecture

```
 Human ── spec / task / goal / inbox reply
    ▼
 AgentOS control plane (this repo)      ┌──────────────┐
   UI · API · CLI · YAML · webhooks     │ persistence  │
   Kanban · Goals/orchestrator · Inbox  │ SQLite (drizzle) — Postgres-ready model
   Sessions · Scheduler · Secrets vault │ local blob dir (R2 stand-in, bucketKey)
    └───────────┬───────────────────────┴──────────────┘
                ▼
   Runner interface (§16): CloudClaudeRunner (Agent SDK, needs
   ANTHROPIC_API_KEY) · DeepseekRunner (BYOK, needs DEEPSEEK_API_KEY) ·
   LocalVmRunner (worker process) · SimulatedRunner (demo/test, same MCP servers)
                ▼
   Ephemeral session: fresh work dir → clone granted repos → inject
   listed env secrets → attach granted MCPs → run → commit if git-write
   → DESTROY. Nothing survives except git commits and fs-MCP writes.
```

**Environment adaptations (labeled in code, blueprint §3.4/§24):**

- **SQLite + Drizzle** instead of Postgres + Prisma — same relationships/fields
  (§19); swap `sqliteTable` → `pgTable` to move.
- **Local encrypted vault** (AES-256-GCM, `providerRef: local-vault://<id>`)
  instead of Google Secret Manager — never store raw tokens.
- **Local blob dir** (with `bucketKey` columns) instead of Cloudflare R2 — swap
  `FileService` blob methods for an R2 client.
- **Simulated runner** stands in for the cloud runner when no API key is
  present; sessions are labeled accordingly.

## Development

```bash
pnpm build          # tsc → dist/
pnpm dev            # tsx watch server on :3000
cd apps/web && pnpm dev   # Vite dev server on :5173, proxies /api
pnpm test           # acceptance tests (test/*.test.ts) — all §22 items
pnpm test:functional # boots the BUILT server + CLI and drives the live
                     # HTTP surfaces (auth, task→inbox→done, webhook, goal
                     # loop, YAML round trip) — the §22 manual-demo script,
                     # automated via the simulated runner
```

CI (`.github/workflows/ci.yml`) runs these as staged jobs: `verify`
(typecheck + acceptance tests) → `build` (artifacts) → `functional`
(E2E against the built artifact) → `deploy` (only on `v*` tags).

## Releases

Pushing a version tag (`v0.1.0`) makes CI publish a **GitHub Release** with a
runnable bundle `agentos-<version>.tar.gz` (+ sha256) built from the staged
pipeline's artifacts:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The bundle contains the compiled server + CLI + PWA web UI plus the run
instructions (`RUNNING.md` inside the tarball): extract, `pnpm install --prod
--frozen-lockfile`, then `AGENTOS_DATA_DIR=./data node dist/api/server.js`.

## Docker

Prebuilt images are published to GHCR on version tags:

```bash
docker pull ghcr.io/lokeshyadav559/agentos:v0.1.0
docker run -d --name agentos -p 3000:3000 \
  -v agentos-data:/data \
  ghcr.io/lokeshyadav559/agentos:v0.1.0
docker logs agentos   # operator token printed at boot
```

Data (SQLite DB, vault keys, blobs, work dirs) lives in the `/data` volume.
The container runs as an unprivileged user. Pass your API keys with
`-e ANTHROPIC_API_KEY=... -e DEEPSEEK_API_KEY=...` and pin the operator token
with `-e AGENTOS_OPERATOR_TOKEN=...`.

`AGENTOS_DATA_DIR` overrides the data directory (default `./data`).

## Blueprint conformance

Phases 0–7 of §21 are implemented in order; §22's 14 acceptance items are
covered by the test suite (`test/01-mvp … 08-orchestrator`). Unknowns/deferred
items follow §23 (labeled, not faked). Build rules §24 are followed: least
privilege is first-class, no extra chat products, no persisted containers, no
raw cloud credentials in agent hands, reconstructed prompts labeled.
