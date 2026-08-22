"""Push notifications service. Port of src/services/push.ts."""
import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, delete

from agentos.db.client import get_session
from agentos.db.models import PushSubscription


class PushService:
    def __init__(self, vapid_subject: str, vapid_public_key: str, vapid_private_key: str) -> None:
        self._subject = vapid_subject
        self._public_key = vapid_public_key
        self._private_key = vapid_private_key
        self._ready = bool(vapid_public_key and vapid_private_key)

    async def subscribe(self, endpoint: str, keys: dict) -> None:
        async with get_session() as db:
            result = await db.execute(select(PushSubscription).where(PushSubscription.endpoint == endpoint))
            if result.scalar_one_or_none():
                return
            db.add(PushSubscription(
                id=str(uuid.uuid4()),
                endpoint=endpoint,
                keys=keys,
                created_at=datetime.now(timezone.utc).isoformat(),
            ))
            await db.commit()

    async def unsubscribe(self, endpoint: str) -> None:
        async with get_session() as db:
            await db.execute(delete(PushSubscription).where(PushSubscription.endpoint == endpoint))
            await db.commit()

    async def notify(self, title: str, body: str, url: str | None = None) -> None:
        if not self._ready:
            return
        payload = json.dumps({"title": title, "body": body, "url": url})
        async with get_session() as db:
            result = await db.execute(select(PushSubscription))
            subs = result.scalars().all()

        dead: list[str] = []
        for sub in subs:
            try:
                from pywebpush import webpush, WebPushException  # type: ignore[import-untyped]
                webpush(
                    subscription_info={"endpoint": sub.endpoint, "keys": sub.keys},
                    data=payload,
                    vapid_private_key=self._private_key,
                    vapid_claims={"sub": self._subject},
                )
            except Exception as e:
                status = getattr(e, "response", None)
                code = getattr(status, "status_code", None) if status else None
                if code in (404, 410):
                    dead.append(sub.endpoint)

        if dead:
            async with get_session() as db:
                for ep in dead:
                    await db.execute(delete(PushSubscription).where(PushSubscription.endpoint == ep))
                await db.commit()
