"""
Secret storage service. Port of src/services/secrets.ts.
Values are AES-256-GCM encrypted at rest; DB holds only references.
"""
import base64
import hashlib
import os
import uuid
from datetime import datetime, timezone

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from agentos.db.client import get_session
from agentos.db.models import Secret as SecretRow


class SecretService:
    def __init__(self, hmac_secret: str) -> None:
        self._key = hashlib.sha256(f"agentos-vault:{hmac_secret}".encode()).digest()

    def encrypt(self, plain: str) -> str:
        nonce = os.urandom(12)
        aesgcm = AESGCM(self._key)
        ct = aesgcm.encrypt(nonce, plain.encode(), None)
        # ct includes the 16-byte GCM tag appended by cryptography
        return (
            base64.urlsafe_b64encode(nonce).rstrip(b"=").decode()
            + "."
            + base64.urlsafe_b64encode(ct).rstrip(b"=").decode()
        )

    def decrypt(self, payload: str) -> str:
        nonce_b, ct_b = payload.split(".", 1)
        nonce = base64.urlsafe_b64decode(nonce_b + "==")
        ct = base64.urlsafe_b64decode(ct_b + "==")
        aesgcm = AESGCM(self._key)
        return aesgcm.decrypt(nonce, ct, None).decode()

    async def create_ref(self, project_id: str, name: str, purpose: str,
                         value: str | None = None) -> dict:
        ref_id = str(uuid.uuid4())
        row = SecretRow(
            id=ref_id,
            project_id=project_id,
            name=name,
            provider_ref=f"local-vault://{ref_id}",
            purpose=purpose,
            value_enc=self.encrypt(value) if value is not None else None,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        async with get_session() as db:
            db.add(row)
            await db.commit()
        return {"id": ref_id, "projectId": project_id, "name": name,
                "providerRef": row.provider_ref, "purpose": purpose}

    async def set_value(self, ref_id: str, value: str) -> None:
        async with get_session() as db:
            result = await db.execute(select(SecretRow).where(SecretRow.id == ref_id))
            row = result.scalar_one_or_none()
            if row:
                row.value_enc = self.encrypt(value)
                await db.commit()

    async def get_value(self, ref_id: str) -> str | None:
        async with get_session() as db:
            result = await db.execute(select(SecretRow).where(SecretRow.id == ref_id))
            row = result.scalar_one_or_none()
        if not row or not row.value_enc:
            return None
        try:
            return self.decrypt(row.value_enc)
        except Exception:
            return None

    async def list(self, project_id: str) -> list[dict]:
        async with get_session() as db:
            result = await db.execute(select(SecretRow).where(SecretRow.project_id == project_id))
            rows = result.scalars().all()
        return [{"id": r.id, "projectId": r.project_id, "name": r.name,
                 "providerRef": r.provider_ref, "purpose": r.purpose} for r in rows]

    async def delete(self, ref_id: str) -> None:
        async with get_session() as db:
            await db.execute(delete(SecretRow).where(SecretRow.id == ref_id))
            await db.commit()
