/**
 * Inbox service (§12): the ONLY human interrupt channel. Agents send text
 * messages or multiple-choice questions; the human replies in the UI and the
 * waiting session resumes with the answer.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { inboxMessages } from "../db/schema.js";
import type { DB } from "../db/client.js";
import type { InboxMessage, InboxChoice } from "../domain/types.js";
import { HttpError } from "../api/errors.js";

export interface InboxSendInput {
  from: "agent" | "human";
  agentId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  goalId?: string | null;
  kind?: "text" | "multiple-choice";
  body: string;
  choices?: string[];
}

export class InboxService {
  constructor(private db: DB) {}

  async send(input: InboxSendInput): Promise<InboxMessage> {
    const row: InboxMessage = {
      id: randomUUID(),
      from: input.from,
      agentId: input.agentId ?? null,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      goalId: input.goalId ?? null,
      kind: input.kind ?? "text",
      body: input.body,
      choices: (input.choices ?? []).map((c, i) => ({ id: `c${i}`, label: c }) satisfies InboxChoice),
      selectedChoiceId: null,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    await this.db.insert(inboxMessages).values(row).run();
    return row;
  }

  async list(): Promise<InboxMessage[]> {
    const rows = await this.db.select().from(inboxMessages).all();
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<InboxMessage | null> {
    const row = await this.db.select().from(inboxMessages).where(eq(inboxMessages.id, id)).get();
    return row ?? null;
  }

  async openForSession(sessionId: string): Promise<InboxMessage[]> {
    const rows = await this.db.select().from(inboxMessages).where(eq(inboxMessages.sessionId, sessionId)).all();
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Human reply. Records the reply (choice or text) and returns the message
   * the reply answers. The session service resumes the waiting session.
   */
  async reply(
    messageId: string,
    input: { body?: string; selectedChoiceId?: string },
  ): Promise<InboxMessage> {
    const msg = await this.get(messageId);
    if (!msg) throw new HttpError(404, "message not found");
    if (msg.status !== "open") throw new HttpError(409, "message already answered");
    if (msg.kind === "multiple-choice" && !input.selectedChoiceId) {
      throw new HttpError(400, "multiple-choice message requires selectedChoiceId");
    }
    if (input.selectedChoiceId && !msg.choices.some((c) => c.id === input.selectedChoiceId)) {
      throw new HttpError(400, "invalid choice id");
    }
    const answer: InboxMessage = {
      id: randomUUID(),
      from: "human",
      agentId: msg.agentId,
      sessionId: msg.sessionId,
      taskId: msg.taskId,
      goalId: msg.goalId,
      kind: "text",
      body: input.body ?? `(selected: ${msg.choices.find((c) => c.id === input.selectedChoiceId)?.label ?? input.selectedChoiceId})`,
      choices: [],
      selectedChoiceId: null,
      status: "closed",
      createdAt: new Date().toISOString(),
    };
    await this.db.insert(inboxMessages).values(answer).run();
    const updated = { ...msg, status: "answered" as const, selectedChoiceId: input.selectedChoiceId ?? null };
    await this.db.update(inboxMessages).set(updated).where(eq(inboxMessages.id, msg.id)).run();
    return updated;
  }

  async close(messageId: string): Promise<void> {
    await this.db.update(inboxMessages).set({ status: "closed" }).where(eq(inboxMessages.id, messageId)).run();
  }
}
