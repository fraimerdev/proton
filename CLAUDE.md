# CLAUDE.md — Proton

Discord bot platform (moderation + security + engagement) with a TanStack Start dashboard.
The authoritative spec is `docs/PLAN.md`. Read it before planning any non-trivial change.
Where this file and PLAN.md conflict, PLAN.md wins — **except** for the explicitly recorded
decisions below, which the project owner has taken since PLAN.md was written.

## Recorded decisions that supersede PLAN.md

- **Bun for everything** — package manager, test runner, and service runtime. This replaces
  §2's "pnpm workspaces" and "Vitest". Turborepo is retained as the task orchestrator.
  Gate 0's acceptance command is therefore `bun install && bun run typecheck && bun run lint && bun test`.
- **Development happens inside WSL2 (Ubuntu), at `~/proton`.** Testcontainers reaches the
  Docker daemon over a unix socket; a Windows-side process cannot. Verified: `bun test`
  runs fast-check and Testcontainers (Postgres 17 + Redis 7) in WSL.
- **Monetization**: Discord App Subscriptions **and** Stripe in v1 (§2 said Stripe later).
- **Deploy target**: deferred to Gate 5. No Dockerfiles or Fly/K8s config before then.
- **Privileged intents**: Server Members + Message Content. Presence is not used.
- **Message-log retention**: opt-in, 30 days.
- **`@tanstack/react-table` is v9**, not §2's v8 — not a dependency until Gate 1.

## Commands

```bash
docker compose up -d      # postgres:17 + redis:7 (required for dev & integration tests)
bun install
bun run dev               # turbo: gateway, worker, rest-proxy, api, dashboard
bun run typecheck
bun run lint              # biome
bun test                  # integration suites use testcontainers
bun run db:migrate        # drizzle-kit
bun run build
```

## Running the integration suites

`bun test` runs everything, but every `*.integration.test.ts` needs Docker via Testcontainers,
and **they do not run on this Windows host**: Bun cannot open Windows named pipes, so
Testcontainers cannot reach Docker Desktop even when `docker version` works from the same shell.
`DOCKER_HOST=npipe:...` does not help — it is the same pipe.

They fail with `Could not find a working container runtime strategy`, which in a CI log is
indistinguishable from a real regression. **A skipped suite is not a passing suite.** Before
claiming a phase gate, run them somewhere Docker is reachable and show the output:

```bash
DOCKER_HOST=tcp://localhost:2375 bun test
```

That needs Docker Desktop → Settings → General → "Expose daemon on tcp://localhost:2375 without
TLS" (Bun handles TCP fine). Otherwise run them in CI, or in WSL with Bun installed.

## Architecture invariants (full list: PLAN.md §3)

- All state-changing Discord operations go through `ActionExecutor` — never call `guild.ban()`,
  `member.timeout()`, `channel.delete()` etc. from module code.
- All Discord REST calls go through `apps/rest-proxy`. No other process creates a REST client
  against discord.com. **Corollary: never construct a discord.js `Client` anywhere** — it owns
  both a REST client and a gateway connection, violating this and the gateway invariant below.
  discord.js is a dependency only for `PermissionFlagsBits`, `GatewayIntentBits` and builders;
  `apps/gateway` drives `@discordjs/ws` directly.
- Modules never import other modules. Cross-module effects go over the event bus.
- Every handler and executor call carries an idempotency key. Gateway RESUME redelivers events;
  assume every event arrives at least twice.
- Module config is validated against its Zod schema on every read/write and carries `schema_version`.
- Dashboard: all permission checks server-side per mutation; browser never talks to Discord;
  every mutation passes through the `auditTrail` middleware.
- Interactions are deferred within 3 seconds if the handler touches DB or REST.
- Gateway session state lives in Redis; worker deploys must never trigger a gateway identify.

## Code style

- TypeScript strict, ESM only. No `any` without an inline justification comment.
- Zod schemas are the single source of truth (config, env, search params, API IO). Derive types
  with `z.infer`; never hand-write a parallel interface.
- Each package validates its env at boot via a Zod env schema; fail fast with a readable message.
- Pin exact versions for all `@tanstack/*` packages; caret elsewhere. `@tanstack/react-start`
  pins `@tanstack/react-router` exactly, so a caret there breaks the peer relationship.
- No tsconfig `baseUrl`/`paths` — TypeScript 7 deprecates `baseUrl`. Cross-package imports go
  through Bun workspaces and package `exports`.
- Errors returned to users/admins name the missing permission or intent and where it's missing —
  "the bot did nothing" is a bug.

## Testing rules

- Never call the real Discord API from tests. Use recorded gateway fixtures (`tooling/fixtures/`)
  and the mocked REST upstream.
- The real bot token exists only in gitignored `.env` files — never in code, fixtures, tests, logs.
- New module = integration test for its happy path AND its permission-failure path, minimum.
- Permission math changes require accompanying property tests (fast-check).
- Destructive actions default to `dry_run: true` in development.

## Safety rails for the agent

- Only ever operate against the designated test guild ID from `.env`. Never invite the bot to,
  or act on, any other guild.
- Do not scaffold modules ahead of the current phase. Do not add speculative abstractions.
- Discord API knowledge from training is likely stale — verify against the Discord docs MCP
  (`https://docs.discord.com/mcp`) or `https://docs.discord.com/llms.txt` before implementing an
  endpoint, permission bit, or gateway behaviour. Note `discord.com/developers/docs/*` now
  redirects to `docs.discord.com/developers/*`.
- Before marking a phase gate complete, run its acceptance commands from PLAN.md §12 and show
  the output.

## Map

```
packages/core       event types, EventBus, ActionExecutor, ModuleManifest, permission math
packages/db         drizzle schema, migrations
packages/modules/*  one folder per module
apps/gateway        shards, normaliser, publisher (deploys rarely — see invariants)
apps/worker         bus consumers, module runtime
apps/rest-proxy     shared-bucket Discord REST egress
apps/api            Hono; ALL domain logic lives here
apps/dashboard      TanStack Start; server fns are thin auth/audit/delegate wrappers only
```
