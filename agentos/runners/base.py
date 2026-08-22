"""
Runner base types. Port of src/runners/types.ts.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class SessionOutcome:
    status: str  # "ok" | "failed"
    summary: str | None
    cost_usd: float | None
    commit_shas: list[str] = field(default_factory=list)
    error: str | None = None


class RunnerHandle(ABC):
    @property
    @abstractmethod
    def done(self):
        """Awaitable that resolves to SessionOutcome."""
        ...

    @abstractmethod
    async def inject_reply(self, answer: dict) -> None: ...

    @abstractmethod
    async def destroy(self) -> None: ...


class Runner(ABC):
    kind: str

    @abstractmethod
    async def provision(self, *, session_id: str, manifest: Any,
                        runtime: Any, cwd: str, script: Any = None) -> RunnerHandle: ...
