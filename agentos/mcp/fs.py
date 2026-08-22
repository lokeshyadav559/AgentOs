"""R2 filesystem MCP. Port of src/mcp/fs.ts."""
from agentos.acl.grants import check_fs_op, normalize_path
from agentos.mcp.context import McpServer, McpTool, create_mcp_server


def create_fs_mcp_server() -> McpServer:
    def _assert(rt, op, path):
        ok, reason = check_fs_op(rt.manifest.filesystemGrants, op, path)
        if not ok:
            raise PermissionError(f"fs.{op} denied: {reason}")

    async def fs_list(rt, args):
        path = args.get("path", "/")
        _assert(rt, "list", path)
        entries = await rt.services.files.list(rt.manifest.projectId, path)
        return {"entries": [{"path": e["path"], "type": e["type"], "size": e["size"]} for e in entries]}

    async def fs_read(rt, args):
        _assert(rt, "read", args["path"])
        file, content = await rt.services.files.read(rt.manifest.projectId, args["path"])
        return {"path": file["path"], "mime": file["mime"], "size": file["size"],
                "content": content.decode(errors="replace")}

    async def fs_write(rt, args):
        _assert(rt, "write", args["path"])
        file = await rt.services.files.write(
            rt.manifest.projectId, args["path"], args["content"], args.get("mime")
        )
        return {"ok": True, "path": file["path"], "size": file["size"]}

    async def fs_mkdir(rt, args):
        _assert(rt, "mkdir", args["path"])
        return {"ok": True, "path": normalize_path(args["path"])}

    async def fs_delete(rt, args):
        _assert(rt, "delete", args["path"])
        await rt.services.files.delete(rt.manifest.projectId, args["path"])
        return {"ok": True}

    return create_mcp_server("r2-fs", [
        McpTool("fs.list", "List entries under a folder path.", fs_list),
        McpTool("fs.read", "Read a file's UTF-8 content.", fs_read),
        McpTool("fs.write", "Write (create or replace) a UTF-8 text file.", fs_write),
        McpTool("fs.mkdir", "Validate a folder path (requires write grant).", fs_mkdir),
        McpTool("fs.delete", "Delete a file (requires delete grant).", fs_delete),
    ])
