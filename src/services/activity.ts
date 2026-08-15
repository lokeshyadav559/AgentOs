/**
 * Global activity feed (§13): agent actions, inbox, task transitions,
 * triggers, automations, sessions.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { activityEvents } from "../db/schema.js";
import type { DB } from "../db/client.js";
import type { ActivityEvent } from "../domain/types.js";

export class ActivityService {
  constructor(private db: DB) {}

  async emit(
    e: Omit<ActivityEvent, "id" | "at">,
  ): Promise<ActivityEvent> {
    const row: ActivityEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...e,
    };
    await this.db.insert(activityEvents).values(row).run();
    // Keep feed bounded.
    const all = await this.db.select().from(activityEvents).all();
    if (all.length > 500) {
      const excess = all.slice(0, all.length - 500);
      for (const x of excess) {
        await this.db.delete(activityEvents).where(eq(activityEvents.id, x.id)).run();
      }
    }
    return row;
  }

  async list(limit = 100): Promise<ActivityEvent[]> {
    const rows = await this.db.select().from(activityEvents).all();
    return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }
}
