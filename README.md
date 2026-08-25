# Proton

Discord bot platform (moderation + security + engagement) with a TanStack Start dashboard.

The authoritative specification is [`docs/PLAN.md`](docs/PLAN.md). Agent-facing working
rules are in [`CLAUDE.md`](CLAUDE.md).

## Development environment

Proton is developed **inside WSL2 (Ubuntu)**, not on the Windows filesystem.

That is not a preference — Testcontainers drives every integration suite (PLAN.md §11)
and talks to the Docker daemon directly via a unix socket. With Docker running inside
WSL and no Docker Desktop named pipe on Windows, a Windows-side test process cannot
reach the daemon at all. Developing in WSL also matches the Linux containers Proton
ships as, and avoids the file-locking problems Bun hits on Windows (`bun install` there
requires `--backend=copyfile` and rebuilds native modules slowly).

Repository lives at `~/proton`.

## Requirements

- Bun ≥ 1.3.14
- Docker with a reachable daemon (`docker info` must succeed as your user)

## Commands

```bash
docker compose up -d   # postgres:17 + redis:7 — required for dev and integration tests
bun install
bun run dev            # turbo: gateway, worker, rest-proxy, api, dashboard
bun run typecheck
bun run lint           # biome
bun test               # bun's test runner; integration suites use testcontainers
bun run db:migrate     # drizzle-kit
bun run build
```

## Deployment

Proton runs on a single Ubuntu VPS behind nginx, supervised by pm2. The runbook is
[`docs/DEPLOY.md`](docs/DEPLOY.md); the pm2, nginx and environment artefacts are in
[`deploy/`](deploy/).

## Layout

```
packages/core       event types, EventBus, ActionExecutor, ModuleManifest, permission math
packages/db         drizzle schema, migrations
packages/modules/*  one folder per module
apps/gateway        shards, normaliser, publisher (deploys rarely — see CLAUDE.md)
apps/worker         bus consumers, module runtime
apps/rest-proxy     shared-bucket Discord REST egress
apps/api            Hono; ALL domain logic lives here
apps/dashboard      TanStack Start
tooling/            shared tsconfig, test fixtures
```
