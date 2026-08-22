"""
AgentOS server entry point. Port of src/api/server.ts.
Boots the FastAPI app, initialises the DB, starts the scheduler.
"""
import asyncio
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI

from agentos.config import load_config
from agentos.db.client import create_tables, init_engine


def _print_operator_token(config) -> None:
    token_path = Path(config.data_dir) / "operator-token.key"
    first_boot = not token_path.exists() or token_path.stat().st_size == 0
    print(f"\nAgentOS control plane")
    print(f"  URL:   http://{config.host}:{config.port}")
    if first_boot:
        print(f"  Token: {config.operator_token}  ← save this")
    else:
        print(f"  Token: (set in {token_path})")
    runner_note = []
    if config.anthropic_api_key:
        runner_note.append("claude")
    if config.deepseek_api_key:
        runner_note.append("deepseek")
    if not runner_note:
        runner_note.append("simulated (no API key)")
    print(f"  Runner: {', '.join(runner_note)}")
    print()


def build_app() -> FastAPI:
    config = load_config()
    services_holder: dict = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_engine(config.db_path)
        await create_tables()

        from agentos.services.registry import build_services
        svc = await build_services(config)
        services_holder["svc"] = svc

        _print_operator_token(config)
        svc.scheduler.start()
        yield
        svc.scheduler.stop()

    from agentos.api.app import create_app
    app = create_app(services_holder)
    app.router.lifespan_context = lifespan
    return app


def main() -> None:
    config = load_config()
    app = build_app()
    uvicorn.run(app, host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    main()
