/**
 * AgentOS configuration.
 *
 * Environment-driven settings with safe defaults. All paths are relative to
 * the AgentOS data directory so the whole system is portable.
 */
import { randomBytes, createHash, createHmac } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import webpush from "web-push";

export interface Config {
  /** Directory for the SQLite DB, blob store (R2 stand-in), vault key, etc. */
  dataDir: string;
  /** Where the SQLite database file lives. */
  dbPath: string;
  /** Where file blobs (Cloudflare R2 stand-in) live. */
  blobDir: string;
  /** Where git repo clones for sessions live (local runner stand-in). */
  workDir: string;
  /** HTTP port for the control-plane API + web. */
  port: number;
  /** Bind host; 0.0.0.0 makes the UI reachable from other machines. */
  host: string;
  /** Public base URL used in webhook URLs and push payloads. */
  publicUrl: string;
  /** HMAC secret used to sign cookies / session tokens / webhook secrets. */
  secret: string;
  /** Operator token (single-user auth). Auto-generated if not set. */
  operatorToken: string;
  /** If set, the real Claude Agent SDK cloud runner is enabled. */
  anthropicApiKey?: string;
  /** If set, the DeepSeek BYOK cloud runner is enabled (deepseek-* models). */
  deepseekApiKey?: string;
  /** DeepSeek API base URL (OpenAI-compatible). */
  deepseekBaseUrl?: string;
  /** VAPID keys for web push (generated + persisted if absent). */
  vapid: { subject: string; publicKey: string; privateKey: string };
  /** Whether the local (Hetzner-style VM) runner backend is enabled. */
  localRunnerEnabled: boolean;
}

function mustSecret(dataDir: string, name: string, bits = 48): string {
  const p = path.join(dataDir, `${name}.key`);
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  const v = randomBytes(bits).toString("base64url");
  writeFileSync(p, v, { mode: 0o600 });
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.AGENTOS_DATA_DIR ?? path.join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(dataDir, "blobs"), { recursive: true });
  mkdirSync(path.join(dataDir, "work"), { recursive: true });

  const secret = env.AGENTOS_SECRET ?? mustSecret(dataDir, "hmac");
  const operatorToken =
    env.AGENTOS_OPERATOR_TOKEN ?? mustSecret(dataDir, "operator-token");

  // VAPID keys for Web Push (PWA). Persisted so subscriptions survive restarts.
  const vapidPath = path.join(dataDir, "vapid.json");
  let vapid: Config["vapid"];
  if (existsSync(vapidPath)) {
    vapid = JSON.parse(readFileSync(vapidPath, "utf8"));
  } else {
    const keys = webpush.generateVAPIDKeys();
    vapid = {
      subject: env.AGENTOS_PUSH_SUBJECT ?? "mailto:operator@agentos.local",
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    };
    writeFileSync(vapidPath, JSON.stringify(vapid), { mode: 0o600 });
  }

  return {
    dataDir,
    dbPath: path.join(dataDir, "agentos.db"),
    blobDir: path.join(dataDir, "blobs"),
    workDir: path.join(dataDir, "work"),
    port: Number(env.PORT ?? env.AGENTOS_PORT ?? 3000),
    host: env.AGENTOS_HOST ?? "0.0.0.0",
    publicUrl: env.AGENTOS_PUBLIC_URL ?? `http://127.0.0.1:${env.PORT ?? env.AGENTOS_PORT ?? 3000}`,
    secret,
    operatorToken,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    deepseekApiKey: env.DEEPSEEK_API_KEY,
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    vapid,
    localRunnerEnabled: env.AGENTOS_LOCAL_RUNNER !== "0",
  };
}

export function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time compare to avoid timing attacks on tokens/secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return ha.equals(hb);
}
