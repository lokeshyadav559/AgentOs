#!/usr/bin/env node
/**
 * AgentOS functional smoke — drives the BUILT artifact (dist/) through the
 * real HTTP surface, the same way the blueprint's §22 manual/demo script
 * does (create project → task → run → inbox reply → done; webhook trigger;
 * goal loop; CLI), but automated and deterministic via the simulated runner
 * (no API keys required).
 *
 * Usage: pnpm build && pnpm test:functional
 * Exit code 0 = all checks passed; non-zero = a functionality check failed.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.FUNCTIONAL_PORT ?? 43717);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = path.join(root, "data", `functional-${Date.now().toString(36)}`);

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(method, urlPath, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined && raw === undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(250);
  }
}

const server = spawn(process.execPath, ["dist/api/server.js"], {
  cwd: root,
  env: { ...process.env, AGENTOS_DATA_DIR: dataDir, PORT: String(PORT), AGENTOS_PUBLIC_URL: BASE },
  stdio: ["ignore", "pipe", "pipe"],
});
let bootLog = "";
server.stdout.on("data", (d) => (bootLog += d));
server.stderr.on("data", (d) => (bootLog += d));

let token;
let projectId;
try {
  console.log(`Functional smoke → ${BASE} (data: ${dataDir})`);

  // --- Boot -----------------------------------------------------------------
  await waitFor(async () => {
    try {
      return (await fetch(`${BASE}/`)).status === 200;
    } catch {
      return false;
    }
  }, 20_000, "server boot");
  check("server boots and serves the control plane", true);

  // --- Auth wall ------------------------------------------------------------
  const anon = await api("GET", "/api/projects");
  check("unauthenticated API call is rejected", anon.status === 401, `got ${anon.status}`);

  token = readFileSync(path.join(dataDir, "operator-token.key"), "utf8").trim();

  // --- Project + seeded catalog ---------------------------------------------
  const proj = await api("POST", "/api/projects", { token, body: { name: "func" } });
  check("project created with seeded agents/templates", proj.status === 201 && !!proj.json?.id, `got ${proj.status}`);
  projectId = proj.json?.id;
  const agents = await api("GET", `/api/projects/${projectId}/agents`, { token });
  const agentNames = (agents.json ?? []).map((a) => a.name);
  check(
    "seeded catalog present (default, plan, customer-support)",
    ["default", "plan", "customer-support"].every((n) => agentNames.includes(n)),
    `missing: ${["default", "plan", "customer-support"].filter((n) => !agentNames.includes(n)).join(",")}`,
  );
  const defaultAgent = (agents.json ?? []).find((a) => a.name === "default");

  // --- Task → session → done (default agent, no human needed) ----------------
  const task = await api("POST", `/api/projects/${projectId}/tasks`, {
    token,
    body: { name: "Functional task", assigneeAgentId: defaultAgent.id },
  });
  check("task created (todo)", task.status === 201 && task.json?.status === "todo", `got ${task.status}`);
  const taskId = task.json?.id;

  const run = await api("POST", `/api/projects/${projectId}/tasks/${taskId}/run`, { token });
  check("task run starts a session", [200, 202].includes(run.status) && !!run.json?.sessionId, `got ${run.status}`);
  const sessionId = run.json?.sessionId;

  const live = await fetch(`${BASE}/api/sessions/${sessionId}/live`, { headers: { authorization: `Bearer ${token}` } });
  check(
    "live session viewer streams SSE",
    live.status === 200 && (live.headers.get("content-type") ?? "").startsWith("text/event-stream"),
    `content-type=${live.headers.get("content-type")}`,
  );
  live.body?.cancel();

  const doneTask = await waitFor(async () => {
    const t = await api("GET", `/api/projects/${projectId}/tasks/${taskId}`, { token });
    return t.json?.status === "done" ? t.json : null;
  }, 20_000, "task done");
  check("default-agent task completes to done via the simulated runner", !!doneTask, "task never done");

  // --- Inbox: spec agent asks a multiple-choice question; reply resumes --------
  const specAgent = (agents.json ?? []).find((a) => a.name === "spec");
  const specTask = await api("POST", `/api/projects/${projectId}/tasks`, {
    token,
    body: { name: "Spec review", assigneeAgentId: specAgent.id },
  });
  const specRun = await api("POST", `/api/projects/${projectId}/tasks/${specTask.json?.id}/run`, { token });
  const specSessionId = specRun.json?.sessionId;
  const question = await waitFor(async () => {
    const inbox = await api("GET", "/api/inbox", { token });
    return (inbox.json ?? []).find((m) => m.sessionId === specSessionId && m.kind === "multiple-choice") ?? null;
  }, 20_000, "spec agent's multiple-choice question");
  check("spec agent asks a multiple-choice inbox question", !!question, "no question");
  check(
    "question carries the choice options",
    Array.isArray(question?.choices) && question.choices.length === 2,
    `choices=${JSON.stringify(question?.choices)}`,
  );

  const reply = await api("POST", `/api/inbox/${question.id}/reply`, { token, body: { selectedChoiceId: "c0" } });
  check("choice reply accepted", reply.status === 200 && reply.json?.ok === true, `got ${reply.status}`);
  const doneSpec = await waitFor(async () => {
    const t = await api("GET", `/api/projects/${projectId}/tasks/${specTask.json?.id}`, { token });
    return t.json?.status === "done" ? t.json : null;
  }, 20_000, "spec task done after reply");
  check("reply resumes the session and the task reaches done", !!doneSpec, "spec task never done");

  // --- Webhook trigger (HMAC) ------------------------------------------------
  const trig = await api("POST", `/api/projects/${projectId}/triggers`, {
    token,
    body: { name: "support-inbound", agentId: (agents.json ?? []).find((a) => a.name === "customer-support")?.id },
  });
  check("trigger created", trig.status === 201 && !!trig.json?.id, `got ${trig.status}`);
  const triggerId = trig.json?.id;
  const webhookSecret = trig.json?.webhookSecret;

  const bad = await api("POST", `/hooks/${triggerId}`, { raw: '{"n":1}', body: undefined });
  check("webhook with no signature is rejected", bad.status === 401, `got ${bad.status}`);
  const sig = createHmac("sha256", webhookSecret).update('{"n":1}').digest("hex");
  const good2 = await fetch(`${BASE}/hooks/${triggerId}`, {
    method: "POST",
    headers: { "x-agentos-signature": sig, "content-type": "application/json" },
    body: '{"n":1}',
  });
  const goodJson = await good2.json();
  check("signed webhook fires a task", good2.status === 201 && !!goodJson?.taskId, `got ${good2.status}`);

  // --- Goal loop (DoD approval → specialists → done) --------------------------
  const goal = await api("POST", `/api/projects/${projectId}/goals`, {
    token,
    body: { title: "Functional goal", spec: "ship it", definitionOfDone: ["a", "b"], spendCapUsd: 5 },
  });
  check("goal created with drafted DoD", goal.status === 201 && goal.json?.definitionOfDone?.length === 2, `got ${goal.status}`);
  const goalId = goal.json?.id;
  const approved = await api("POST", `/api/projects/${projectId}/goals/${goalId}/approve-dod`, { token });
  check("DoD approval accepted", approved.status === 200, `got ${approved.status}`);
  const goalDone = await waitFor(async () => {
    const g = await api("GET", `/api/projects/${projectId}/goals/${goalId}`, { token });
    return g.json?.status === "completed" ? g.json : null;
  }, 45_000, "goal loop completion");
  check("goal loop spawned specialists and completed the DoD", !!goalDone, "goal never completed");

  // --- CLI --------------------------------------------------------------------
  const runCli = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, ["dist/cli/cli.js", ...args], {
        cwd: root,
        env: { ...process.env, AGENTOS_URL: BASE, AGENTOS_TOKEN: token },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => resolve({ code, out }));
    });
  const cliProj = await runCli(["project", "create", "cli-func"]);
  check("CLI: project create", cliProj.code === 0 && /project created/.test(cliProj.out), cliProj.out.trim().slice(0, 120));
  const cliTask = await runCli(["task", "create", "cli-func", "--name", "CLI task", "--agent", "default"]);
  check("CLI: task create", cliTask.code === 0 && /task created/.test(cliTask.out), cliTask.out.trim().slice(0, 120));
  // YAML-as-code round trip through the CLI: push a file, pull it back, compare.
  const yamlIn = path.join(dataDir, "in.yml");
  const yamlOut = path.join(dataDir, "out.yml");
  writeFileSync(
    yamlIn,
    "project: cli-func\nagents:\n  default:\n    model: claude-sonnet-4\n    runner: inherit\n",
  );
  const cliPush = await runCli(["push", "cli-func", yamlIn]);
  const cliPull = await runCli(["pull", "cli-func", "-o", yamlOut]);
  const roundTripOk =
    cliPush.code === 0 && cliPull.code === 0 && existsSync(yamlOut) && readFileSync(yamlOut, "utf8") === readFileSync(yamlIn, "utf8");
  check("CLI: YAML push→pull round trip is identical", roundTripOk, cliPull.out.trim().slice(0, 120));
} catch (err) {
  failed++;
  console.error(`  ✗ smoke aborted — ${err.message}`);
} finally {
  try {
    server.kill("SIGTERM");
    await Promise.race([new Promise((r) => server.once("exit", r)), sleep(5_000)]);
  } catch {
    /* already gone */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* scratch cleanup best-effort */
  }
}

console.log(`\nFunctional smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("--- server boot log tail ---\n" + bootLog.slice(-2000));
  process.exit(1);
}
process.exit(0);
