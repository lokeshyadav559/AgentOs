/**
 * Web Push for the PWA (§12): push on "needs help" (open inbox message) and
 * on task/goal completion. Uses web-push with VAPID keys from config.
 * Failures are logged and swallowed — push is best-effort.
 */
import webpush from "web-push";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { pushSubscriptions } from "../db/schema.js";
import type { DB } from "../db/client.js";
import type { Config } from "../config.js";

export class PushService {
  private ready = false;

  constructor(
    private db: DB,
    private config: Config,
  ) {
    try {
      webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
      this.ready = true;
    } catch {
      this.ready = false;
    }
  }

  async subscribe(endpoint: string, keys: { p256dh: string; auth: string }): Promise<void> {
    const existing = await this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .get();
    if (existing) return;
    await this.db
      .insert(pushSubscriptions)
      .values({ id: randomUUID(), endpoint, keys, createdAt: new Date().toISOString() })
      .run();
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
  }

  async notify(title: string, body: string, url?: string): Promise<void> {
    if (!this.ready) return;
    const subs = await this.db.select().from(pushSubscriptions).all();
    const payload = JSON.stringify({ title, body, url });
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: s.keys },
            payload,
          );
        } catch (err) {
          // 404/410 → subscription dead; drop it.
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) {
            await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, s.endpoint)).run();
          }
        }
      }),
    );
  }
}
