# AgentOS __VERSION__

Runnable bundle (compiled server + CLI + PWA web UI). Platform-agnostic;
runtime dependencies are fetched at install time.

## Run

    pnpm install --prod --frozen-lockfile
    AGENTOS_DATA_DIR=./data node dist/api/server.js

Open http://127.0.0.1:3000 and log in with the operator token printed at
boot (or set AGENTOS_OPERATOR_TOKEN beforehand). Without an API key the
system runs in demo/test mode with the simulated runner; set
ANTHROPIC_API_KEY (Claude) and/or DEEPSEEK_API_KEY (DeepSeek BYOK) to route
real sessions.

## CLI

    export AGENTOS_URL=http://127.0.0.1:3000 AGENTOS_TOKEN=<operator token>
    node dist/cli/cli.js help
