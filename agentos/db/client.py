"""
Async SQLAlchemy engine + session factory.

Uses aiosqlite for SQLite. To move to Postgres: swap the engine URL to
`postgresql+asyncpg://...` — no model changes needed.
"""
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from .models import Base

_engine = None
_session_factory: async_sessionmaker | None = None


def init_engine(db_path: str) -> None:
    global _engine, _session_factory
    _engine = create_async_engine(
        f"sqlite+aiosqlite:///{db_path}",
        echo=False,
        connect_args={"check_same_thread": False},
    )
    _session_factory = async_sessionmaker(_engine, expire_on_commit=False)


async def create_tables() -> None:
    assert _engine is not None, "call init_engine first"
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


@asynccontextmanager
async def get_session() -> AsyncGenerator[AsyncSession, None]:
    assert _session_factory is not None, "call init_engine first"
    async with _session_factory() as session:
        yield session
