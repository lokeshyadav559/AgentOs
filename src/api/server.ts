/**
 * AgentOS server entry: control-plane API + (when built) the web UI.
 */
import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { openMigratedDb } from "../db/client.js";
import { ProjectService } from "../services/projects.js";
import { TaskService } from "../services/tasks.js";
import { FileService } from "../services/files.js";
import { GoalService } from "../services/goals.js";
import { InboxService } from "../services/inbox.js";
import { SessionService } from "../services/sessions.js";
import { ActivityService } from "../services/activity.js";
import { PushService } from "../services/push.js";
import { SecretService } from "../services/secrets.js";
import { SchedulerService } from "../services/scheduler.js";
import { TriggerService } from "../services/triggers.js";
import type { Services } from "../services/registry.js";
import { createApp } from "./app.js";

export async function main(): Promise<void> {
  const config = loadConfig();
  const db = openMigratedDb(config);

  const services: Services = {
    db,
    config,
    projects: new ProjectService(db),
    tasks: new TaskService(db),
    files: new FileService(db, config),
    goals: new GoalService(db),
    inbox: new InboxService(db),
    activity: new ActivityService(db),
    push: new PushService(db, config),
    secrets: new SecretService(db, config.secret),
    sessions: undefined as unknown as SessionService,
    scheduler: undefined as unknown as SchedulerService,
    triggers: undefined as unknown as TriggerService,
  };
  // Circular wiring: services need each other.
  services.scheduler = new SchedulerService(db, services);
  services.sessions = new SessionService(db, config, services);
  services.triggers = new TriggerService(db, services);

  const app = createApp(config, services);

  // Request log: every hit prints one line so the operator can see exactly
  // what the browser asked for (diagnosing "nothing loads" issues).
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    console.log(`  ${new Date().toISOString().slice(11, 19)} ${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
  });

  // Serve the built web app when present (production single-server mode).
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(__dirname, "../../apps/web/dist");
  const hasWeb = existsSync(path.join(webDist, "index.html"));
  if (hasWeb) {
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".webmanifest": "application/manifest+json",
    };
    app.use("*", async (c, next) => {
      if (c.req.path.startsWith("/api") || c.req.path.startsWith("/hooks")) return next();
      const url = c.req.path === "/" ? "/index.html" : c.req.path;
      const file = path.join(webDist, url);
      const target = existsSync(file) ? file : path.join(webDist, "index.html");
      const ext = path.extname(target);
      return c.body(readFileSync(target), 200, {
        "content-type": mime[ext] ?? "application/octet-stream",
      });
    });
  } else {
    // No built UI: tell the operator how to build it instead of a bare 404.
    app.use("*", async (c, next) => {
      if (c.req.path.startsWith("/api") || c.req.path.startsWith("/hooks")) return next();
      return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>AgentOS</title></head>
<body style="font-family:system-ui;background:#111318;color:#e7e9ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="max-width:520px">
<h1 style="color:#6ee7b7">AgentOS control plane is running</h1>
<p>The API is live — but the web UI has not been built yet. Build it with:</p>
<pre style="background:#181b22;padding:12px;border-radius:8px">cd apps/web && pnpm install && pnpm build</pre>
<p>…then restart <code>pnpm start</code>. API health: <a href="/api/health">/api/health</a></p>
</div></body></html>`);
    });
  }

  services.scheduler.start();

  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
    console.log(`\n  AgentOS control plane → http://${host}:${info.port}`);
    console.log(`  Operator token:     ${config.operatorToken}`);
    console.log(`  Data dir:           ${config.dataDir}`);
    console.log(`  Runners:            Claude${config.anthropicApiKey ? " (cloud)" : " (simulated — no ANTHROPIC_API_KEY)"} · DeepSeek${config.deepseekApiKey ? " (cloud, BYOK)" : " (simulated — no DEEPSEEK_API_KEY)"}`);
    console.log(`\n  Open http://${host}:${info.port} in your browser and log in with the operator token.`);
    console.log("");
  });

  const shutdown = () => {
    services.scheduler.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
