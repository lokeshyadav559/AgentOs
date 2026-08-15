/**
 * Inbox MCP (§12): inbox.send (fire-and-forget note + push), inbox.ask
 * (multiple-choice question, pauses the session until answered), inbox.read.
 */
import { z } from "zod";
import { createMcpServer, type McpServer } from "./context.js";

export function createInboxMcpServer(): McpServer {
  return createMcpServer("inbox", [
    {
      name: "inbox.send",
      description:
        "Send a message to the human. Use ONLY when stuck or a decision is needed — never for routine progress.",
      inputSchema: z.object({ body: z.string().min(1) }),
      handler: async (rt, { body }) => {
        const msg = await rt.services.inbox.send({
          from: "agent",
          agentId: rt.manifest.agent.id,
          sessionId: rt.sessionId,
          taskId: rt.manifest.task?.id ?? null,
          goalId: rt.manifest.goal?.id ?? null,
          body,
        });
        await rt.onInboxNote(msg);
        return { ok: true, messageId: msg.id };
      },
    },
    {
      name: "inbox.ask",
      description:
        "Send a multiple-choice question to the human. The session pauses until the human answers; the answer resumes it.",
      inputSchema: z.object({
        body: z.string().min(1),
        choices: z.array(z.string().min(1)).min(2),
      }),
      handler: async (rt, { body, choices }) => {
        const msg = await rt.services.inbox.send({
          from: "agent",
          agentId: rt.manifest.agent.id,
          sessionId: rt.sessionId,
          taskId: rt.manifest.task?.id ?? null,
          goalId: rt.manifest.goal?.id ?? null,
          kind: "multiple-choice",
          body,
          choices,
        });
        await rt.onInboxQuestion(msg);
        return { ok: true, messageId: msg.id, paused: true };
      },
    },
    {
      name: "inbox.read",
      description: "Read the open messages in this session's thread.",
      inputSchema: z.object({}),
      handler: async (rt) => {
        const msgs = await rt.services.inbox.openForSession(rt.sessionId);
        return { messages: msgs };
      },
    },
  ]);
}
