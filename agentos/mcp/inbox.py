from __future__ import annotations
"""Inbox MCP. Port of src/mcp/inbox.ts."""
from agentos.mcp.context import McpServer, McpTool, create_mcp_server


def create_inbox_mcp_server() -> McpServer:
    async def inbox_send(rt, args):
        msg = await rt.services.inbox.send(
            from_="agent", agent_id=rt.manifest.agent.id, session_id=rt.session_id,
            task_id=rt.manifest.task.id if rt.manifest.task else None,
            goal_id=rt.manifest.goal.id if rt.manifest.goal else None,
            body=args["body"],
        )
        await rt.on_inbox_note(msg)
        return {"ok": True, "messageId": msg["id"]}

    async def inbox_ask(rt, args):
        msg = await rt.services.inbox.send(
            from_="agent", agent_id=rt.manifest.agent.id, session_id=rt.session_id,
            task_id=rt.manifest.task.id if rt.manifest.task else None,
            goal_id=rt.manifest.goal.id if rt.manifest.goal else None,
            kind="multiple-choice", body=args["body"], choices=args["choices"],
        )
        await rt.on_inbox_question(msg)
        return {"ok": True, "messageId": msg["id"], "paused": True}

    async def inbox_read(rt, args):
        msgs = await rt.services.inbox.open_for_session(rt.session_id)
        return {"messages": msgs}

    return create_mcp_server("inbox", [
        McpTool("inbox.send", "Send a message to the human (fire-and-forget).", inbox_send),
        McpTool("inbox.ask", "Send a multiple-choice question; session pauses until answered.", inbox_ask),
        McpTool("inbox.read", "Read open messages in this session's thread.", inbox_read),
    ])
