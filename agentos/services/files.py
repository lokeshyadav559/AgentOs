from __future__ import annotations
"""
Persistent filesystem service. Port of src/services/files.ts.
Local blob dir stand-in for Cloudflare R2 — swap write_blob/read_blob for an R2 client to move.
"""
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select, and_

from agentos.acl.grants import normalize_path
from agentos.db.client import get_session
from agentos.db.models import File as FileRow

_MIME_MAP = {
    ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
    ".yaml": "application/yaml", ".yml": "application/yaml",
    ".ts": "text/typescript", ".tsx": "text/typescript",
    ".js": "text/javascript", ".py": "text/x-python",
    ".html": "text/html", ".css": "text/css",
    ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
}


def _guess_mime(p: str) -> str:
    return _MIME_MAP.get(os.path.splitext(p)[1].lower(), "application/octet-stream")


class FileService:
    def __init__(self, blob_dir: str) -> None:
        self._blob_dir = blob_dir

    def _blob_path(self, bucket_key: str) -> Path:
        return Path(self._blob_dir) / bucket_key

    async def write(self, project_id: str, raw_path: str,
                    content: bytes | str, mime: str | None = None) -> dict:
        p = normalize_path(raw_path)
        if not p:
            raise ValueError(f"invalid path: {raw_path}")
        buf = content if isinstance(content, bytes) else content.encode()
        bucket_key = str(uuid.uuid4())
        Path(self._blob_dir).mkdir(parents=True, exist_ok=True)
        self._blob_path(bucket_key).write_bytes(buf)
        now = datetime.now(timezone.utc).isoformat()

        async with get_session() as db:
            result = await db.execute(
                select(FileRow).where(and_(FileRow.project_id == project_id, FileRow.path == p))
            )
            existing = result.scalar_one_or_none()
            if existing:
                try:
                    self._blob_path(existing.bucket_key).unlink(missing_ok=True)
                except Exception:
                    pass
                existing.bucket_key = bucket_key
                existing.mime = mime or _guess_mime(p)
                existing.size = len(buf)
                existing.updated_at = now
                await db.commit()
                return _row_to_dict(existing)
            row = FileRow(
                id=str(uuid.uuid4()), project_id=project_id, path=p,
                bucket_key=bucket_key, mime=mime or _guess_mime(p),
                size=len(buf), updated_at=now,
            )
            db.add(row)
            await db.commit()
            return _row_to_dict(row)

    async def read(self, project_id: str, raw_path: str) -> tuple[dict, bytes]:
        p = normalize_path(raw_path)
        if not p:
            raise ValueError(f"invalid path: {raw_path}")
        async with get_session() as db:
            result = await db.execute(
                select(FileRow).where(and_(FileRow.project_id == project_id, FileRow.path == p))
            )
            row = result.scalar_one_or_none()
        if not row:
            raise FileNotFoundError(f"file not found: {p}")
        bp = self._blob_path(row.bucket_key)
        content = bp.read_bytes() if bp.exists() else b""
        return _row_to_dict(row), content

    async def get_by_id(self, file_id: str) -> dict | None:
        async with get_session() as db:
            result = await db.execute(select(FileRow).where(FileRow.id == file_id))
            row = result.scalar_one_or_none()
        return _row_to_dict(row) if row else None

    async def delete(self, project_id: str, raw_path: str) -> None:
        p = normalize_path(raw_path)
        if not p:
            raise ValueError(f"invalid path: {raw_path}")
        async with get_session() as db:
            result = await db.execute(
                select(FileRow).where(and_(FileRow.project_id == project_id, FileRow.path == p))
            )
            row = result.scalar_one_or_none()
            if row:
                self._blob_path(row.bucket_key).unlink(missing_ok=True)
                await db.delete(row)
                await db.commit()

    async def list(self, project_id: str, raw_path: str) -> list[dict]:
        p = normalize_path(raw_path) or "/"
        prefix = "/" if p == "/" else p + "/"
        async with get_session() as db:
            result = await db.execute(select(FileRow).where(FileRow.project_id == project_id))
            rows = result.scalars().all()

        out: dict[str, dict] = {}
        for row in rows:
            if p != "/" and not row.path.startswith(prefix):
                continue
            rest = row.path[1:] if p == "/" else row.path[len(prefix):]
            if not rest:
                continue
            seg = rest.split("/")[0]
            full = "/" + seg if p == "/" else p + "/" + seg
            if "/" in rest:
                if full not in out:
                    out[full] = {"path": full, "type": "dir", "size": 0, "updatedAt": None}
            else:
                out[full] = {"path": full, "type": "file", "size": row.size,
                             "updatedAt": row.updated_at, "file": _row_to_dict(row)}

        return sorted(out.values(), key=lambda e: (0 if e["type"] == "dir" else 1, e["path"]))

    async def all(self, project_id: str) -> list[dict]:
        async with get_session() as db:
            result = await db.execute(select(FileRow).where(FileRow.project_id == project_id))
            return [_row_to_dict(r) for r in result.scalars().all()]


def _row_to_dict(r: FileRow) -> dict:
    return {
        "id": r.id, "projectId": r.project_id, "path": r.path,
        "bucketKey": r.bucket_key, "mime": r.mime, "size": r.size,
        "updatedAt": r.updated_at,
    }
