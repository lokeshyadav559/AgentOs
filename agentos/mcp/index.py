from __future__ import annotations
"""
MCP factory. Port of src/mcp/index.ts.
Builds the tool servers a session may call from its manifest connection list.
"""
from agentos.mcp.agentos import create_agentos_mcp_server
from agentos.mcp.context import McpServer, McpTool, create_mcp_server
from agentos.mcp.fs import create_fs_mcp_server
from agentos.mcp.inbox import create_inbox_mcp_server


def create_front_mcp_server() -> McpServer:
    """Stand-in Front support MCP (labeled). Read-only conversation access."""
    async def list_conversations(rt, args):
        entries = await rt.services.files.list(rt.manifest.projectId, "/front/inbox")
        convos = [{"id": e["path"].split("/")[-1], "path": e["path"], "updatedAt": e.get("updatedAt")}
                  for e in entries if e["type"] == "file"]
        if not convos:
            convos = [{"id": "demo-support-1", "path": "/front/inbox/demo-support-1.txt", "updatedAt": None}]
        return {"conversations": convos}

    async def read_conversation(rt, args):
        cid = args["id"]
        entries = await rt.services.files.list(rt.manifest.projectId, "/front/inbox")
        found = next((e for e in entries if e["path"].split("/")[-1] == cid), None)
        if found:
            _, content = await rt.services.files.read(rt.manifest.projectId, found["path"])
            return {"conversation": {"id": cid, "transcript": content.decode(errors="replace")}}
        if cid == "demo-support-1":
            return {"conversation": {"id": cid, "transcript": "customer: my invoice is missing\ncustomer: please help\nagent_note: needs billing team assignment"}}
        raise ValueError(f"conversation not found: {cid}")

    return create_mcp_server("front", [
        McpTool("front.list_conversations", "List support conversations (read-only).", list_conversations),
        McpTool("front.read_conversation", "Read one support conversation transcript (read-only).", read_conversation),
    ], network_hosts=["api.front.com"])


_BUILTINS = {
    "agentos": create_agentos_mcp_server,
    "inbox": create_inbox_mcp_server,
    "r2-fs": create_fs_mcp_server,
}
_EXTERNALS = {
    "front": create_front_mcp_server,
}


def servers_for_manifest(mcp_connection_names: list[str]) -> list[McpServer]:
    out: list[McpServer] = []
    seen: set[str] = set()
    for name in mcp_connection_names:
        factory = _BUILTINS.get(name) or _EXTERNALS.get(name)
        if factory and name not in seen:
            out.append(factory())
            seen.add(name)
    return out
