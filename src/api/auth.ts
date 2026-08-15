/**
 * Single-operator auth (§3.4, §20).
 *
 * UI: session cookie with an HMAC-signed token. CLI: bearer token (the
 * operator token, or a signed personal token). Agents never use HTTP auth
 * directly — their session-scoped ACL is enforced inside the in-process MCP
 * servers (equivalent to the blueprint's session-scoped MCP tokens).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import type { Config } from "../config.js";
import { safeEqual } from "../config.js";
import { HttpError } from "./errors.js";

export const COOKIE_NAME = "agentos_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export interface SessionClaims {
  sub: "operator";
  exp: number;
}

export function signToken(config: Config, claims: SessionClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", config.secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(config: Config, token: string | undefined | null): SessionClaims | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", config.secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionClaims;
    if (claims.sub !== "operator") return null;
    if (claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Operator auth: cookie OR bearer (operator token OR signed token). */
export async function requireOperator(c: Context, config: Config): Promise<SessionClaims> {
  const cookie = c.req.header("cookie");
  const cookieToken = cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(COOKIE_NAME + "="))
    ?.slice(COOKIE_NAME.length + 1);
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const claims = verifyToken(config, cookieToken) ?? verifyToken(config, bearer);
  if (claims) return claims;
  if (bearer && safeEqual(bearer, config.operatorToken)) {
    return { sub: "operator", exp: Math.floor(Date.now() / 1000) + 3600 };
  }
  throw new HttpError(401, "operator authentication required");
}

export function authMiddleware(config: Config) {
  return async (c: Context, next: Next) => {
    try {
      const claims = await requireOperator(c, config);
      c.set("operator", claims);
      await next();
    } catch (e) {
      if (e instanceof HttpError) {
        return c.json({ error: e.message }, e.status as 400);
      }
      throw e;
    }
  };
}

export function setSessionCookie(c: Context, config: Config): void {
  const token = signToken(config, { sub: "operator", exp: Math.floor(Date.now() / 1000) + MAX_AGE });
  c.header(
    "set-cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`,
  );
}

export function clearSessionCookie(c: Context): void {
  c.header("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
