# Proton — Implementation Specification (Agent Edition)

Audience: Claude Code, operating in plan mode before execution.
Companions: `CLAUDE.md` (drop in repo root), `KICKOFF_PROMPT.md` (the human pastes this to start),
`HUMAN_PLAN.md` (the original narrative plan — background reading, not authoritative where it conflicts with this file).

## 0. How to use this document

- Decisions in §2 are **LOCKED**. Do not re-litigate them in your plan. Items marked `[ASK]` in §14 must be answered by the human before execution.
- Build **vertical slices**. Each phase gate (§12) has acceptance criteria you must prove by running the listed commands, not by asserting completion.
- Verify external facts against live sources before coding — your training data on Discord's API is likely stale. Primary sources: Discord docs MCP server at `https://docs.discord.com/mcp`, index at `https://docs.discord.com/llms.txt`, TanStack docs (each page has a `.md` mirror; site exposes `llms.txt`).
- **Do not** scaffold all modules up front. Do not add speculative abstractions. The module framework earns its keep only if adding module N+1 is cheap; prove that with 2–3 real modules first.
- In plan mode: output for **Phase 0 only** (plus the §14 questions). Later phases get planned when their turn comes, with the codebase as it actually exists.

## 1. Product

Proton: one Discord bot + web dashboard combining the feature surface of MEE6 (engagement/leveling), Sapphire (moderation/utility), and Wick (security/anti-nuke). All features are original implementations — no copied code, assets, embed layouts, or branding from those products. Success metric is *predictable degradation*, not "flawless": when Discord's API misbehaves, Proton queues instead of drops and tells admins exactly which permission or intent is missing instead of failing silently.

## 2. Locked decisions

| Area | Decision | Notes |
|---|---|---|
| Language / runtime | TypeScript strict, ESM, Bun latest | discord.js 14.27+ |
| Discord library | discord.js ^14.27 | plus `@discordjs/ws` directly in the gateway service |
| Monorepo | pnpm workspaces + Turborepo | layout in §5 |
| Event bus | **Redis Streams** behind an `EventBus` interface | NATS is a possible future impl; do not build it now |
| Database | PostgreSQL 17 + Drizzle ORM | migrations via drizzle-kit, owned per-module (§7) |
| Cache / rate windows | Redis 7 | local dev: one container, separate logical DBs; prod: separate instances |
| Analytics store | **Deferred.** `AnalyticsStore` interface with a Postgres impl | ClickHouse is a Phase-3+ swap decided then, not now |
| Jobs | BullMQ | scheduled unbans, reminders, giveaways, feeds |
| API service | Hono on Bun | owns all domain logic; called by both workers and dashboard |
| Dashboard framework | TanStack Start (RC) + Router + Query v5 | **Vite** build. Pin **exact versions** for all `@tanstack/*` packages; caret elsewhere |
| Forms | TanStack Form driven by module Zod schemas | generator spec in §9 |
| Tables / big lists | TanStack Table v8 + Virtual v3 | |
| UI kit | Tailwind + shadcn/ui | swap any `next/link`/`next/image` imports in copied blocks for Router `Link` / `<img>` |
| Charts | Recharts | TanStack Charts too new — revisit later |
| Client DB | **Not** TanStack DB in v1 | Query only; revisit for the rule builder post-1.0 |
| Auth | Better Auth with Discord social provider | guild/staff-role resolution is custom code on top |
| Validation | Zod 4 (standard-schema) | single source of truth per §4-P4 |
| Lint/format | Biome | one tool, fast, agent-friendly |
| Tests | Vitest + Testcontainers (Postgres, Redis) + fast-check | strategy in §11 |
| CI | GitHub Actions | typecheck, lint, unit, integration, build |
| Monetization v1 | Discord App Subscriptions (entitlements) only | Stripe later; confirm in §14 |
| Deploy target | Docker images; Fly.io first, K8s later | confirm in §14 |
| Command registration | guild-scoped in dev (instant propagation), global in prod | driven by env var |
| Deferred entirely | Music, economy, AI features, mobile, i18n beyond en (but externalize strings), self-hosting | §13 |

## 3. Invariants — never violate these

I1. **Every** state-changing Discord operation goes through `ActionExecutor`. No module ever calls `guild.ban()`, `member.timeout()`, `channel.delete()` etc. directly. Enforce with a lint rule or wrapper-only exports if practical.
I2. **Every** Discord REST call from any process goes through the REST proxy service. No worker holds its own REST client against discord.com.
I3. Modules never import each other. Cross-module effects travel over the event bus.
I4. Every event handler and every `ActionExecutor` call carries an **idempotency key**; gateway RESUME redelivers events, and double-banning a user is a catastrophic bug class. Dedupe in Redis with TTL.
I5. Module config is validated against the module's Zod schema on **every** read and write; configs carry `schema_version` and are lazily migrated on read.
I6. All dashboard permission checks happen **server-side** on every mutation. A client-supplied guild ID is never trusted. The browser never talks to Discord directly.
I7. Every dashboard mutation writes an `audit_trail` row with before/after diffs — implemented as server-fn middleware so it cannot be forgotten.
I8. `ActionExecutor` prechecks: bot permission in target channel, role hierarchy (bot above target), target is not the guild owner, target is not the bot itself. Failures return a structured reason surfaced to the invoker.
I9. All interactions are acknowledged within 3 seconds — defer by default for anything that touches the DB or REST proxy. Interaction tokens last 15 minutes; long jobs must edit the deferred reply or follow up.
I10. Secrets live only in `.env` files (gitignored) validated by a Zod env schema per package; the real bot token never appears in tests, fixtures, or committed files.
I11. Tests never call the real Discord API. Integration tests run against the mocked REST proxy and recorded gateway payload fixtures.
I12. In development, destructive actions (`ban`, `kick`, channel/role delete, restore) default to `dry_run: true` unless explicitly overridden.
I13. The gateway service stores shard session/resume state in Redis and is deployed independently of workers. Worker deploys must not cause identifies (session starts are capped at 1000/day).

## 4. The four primitives (build order)

Everything else is configuration on top of these. Build them in this order.

### P1 — Normalised event bus
Gateway service consumes raw gateway dispatches, normalises to internal events (`member.joined`, `message.created`, `audit.channel.deleted`, `xp.level_gained`, `schedule.fired`, …) and publishes to Redis Streams. Modules subscribe via consumer groups; a Discord payload change touches one adapter.

```ts
interface ProtonEvent<T = unknown> {
  id: string;            // ulid — also the dedupe key
  type: EventType;
  guildId: string | null;
  occurredAt: number;
  payload: T;
}
interface EventBus {
  publish(e: ProtonEvent): Promise<void>;
  subscribe(group: string, types: EventType[],
            handler: (e: ProtonEvent) => Promise<void>): Subscription; // ack on success, retry w/ backoff, DLQ after N
}
```

### P2 — Rule engine (trigger → conditions → actions)
One engine powers automod, anti-nuke, autorole, level rewards, welcome, raid detection, custom responders. Triggers are event types + cron. Conditions are a small typed predicate set (channel-in, role-has/lacks, account-age, content-pattern, rate-over-window, is-premium). Actions are `ActionExecutor` kinds. Sliding-window rate conditions are atomic Redis Lua counters keyed by `(guildId, ruleId, actorId)`.
Phase 1 ships **preset** rules only (warn-escalation ladders as ordinary module config). The generic user-facing rule builder UI is later; the engine's data model must support it from day one.

### P3 — Action ledger + ActionExecutor
Every state change writes a `cases` row (§6). Executor pipeline: validate → precheck (I8) → dedupe (I4) → execute via REST proxy → record → schedule reversal if `expiresAt`.

```ts
interface ActionRequest {
  guildId: string; moduleId: string;
  kind: ActionKind;                  // 'ban' | 'timeout' | 'add_role' | 'send' | 'quarantine' | ...
  targetId?: string; actorId: string; reason?: string;
  payload?: unknown; expiresAt?: Date;
  dryRun: boolean; idempotencyKey: string;
}
interface ActionResult {
  caseId?: string;
  status: 'executed' | 'dry_run' | 'skipped_duplicate' | 'failed_precheck' | 'failed_api';
  failure?: { code: string; humanReason: string };   // surfaced to invoker per §1
}
```

### P4 — Config schema registry
One Zod schema per module generates: slash-command options, runtime validation, the dashboard form (via the descriptor pipeline in §9), config diffs for audit, and API types. Adding a field updates all surfaces; drift is impossible. This is the highest-leverage subsystem in the project.

## 5. Monorepo layout

```
proton/
  CLAUDE.md
  docs/PLAN.md                    # this file
  docker-compose.yml              # postgres:17, redis:7
  packages/
    core/          # ProtonEvent types, EventBus, ActionExecutor, ModuleManifest, permission math, env schema helper
    db/            # drizzle schema (core tables), migration runner, AnalyticsStore interface + pg impl
    modules/       # one folder per module: ping/, cases/, logging/, ...
  apps/
    gateway/       # @discordjs/ws shards, normaliser, publisher; session state in Redis
    worker/        # bus consumers, module runtime, BullMQ processors
    rest-proxy/    # single shared-bucket Discord REST egress
    api/           # Hono; domain logic; auth for dashboard sessions
    dashboard/     # TanStack Start
  tooling/         # biome config, tsconfig base, vitest config, test fixtures (recorded gateway payloads)
```

## 6. Data model (core tables)

```sql
guilds (id, name, locale, tier, joined_at, left_at, shard_id)

guild_modules (guild_id, module_id, enabled, config JSONB, schema_version,
               updated_by, updated_at)

cases (id, guild_id, case_number, type, actor_id, target_id, moderator_id,
       reason, module_id, payload JSONB, expires_at, reverted_at,
       reverted_by, dry_run, idempotency_key, created_at)
  UNIQUE (guild_id, case_number)
  UNIQUE (idempotency_key)
  INDEX (guild_id, target_id, created_at DESC)
  INDEX (expires_at) WHERE expires_at IS NOT NULL AND reverted_at IS NULL

members (guild_id, user_id, xp, level, last_xp_at, message_count,
         voice_seconds, joined_at, sticky_roles BIGINT[])
  PRIMARY KEY (guild_id, user_id)

rules (id, guild_id, module_id, trigger, conditions JSONB, actions JSONB,
       enabled, priority, created_by)

scheduled_actions (id, guild_id, run_at, kind, payload JSONB,
                   attempts, locked_until, idempotency_key UNIQUE)

audit_trail (id, guild_id, actor_id, source, action, before JSONB,
             after JSONB, ip_hash, created_at)     -- dashboard changes, not Discord's audit log

backups (id, guild_id, version, snapshot JSONB, s3_key, created_by, created_at)

entitlements (guild_id, sku_id, tier, source, expires_at, discord_entitlement_id)
```

Message logs never go in these tables: daily-partitioned Postgres table with TTL job in v1; per-guild opt-in; content retention is a legal surface (GDPR/DSA — Proton is a data controller), so retention defaults are an `[ASK]`.

## 7. Module contract

```ts
export interface ModuleManifest<C extends z.ZodTypeAny> {
  id: string; name: string;
  category: 'moderation' | 'security' | 'engagement' | 'utility' | 'logging';
  configSchema: C; defaultConfig: z.infer<C>;
  requiredIntents: GatewayIntentBits[];
  requiredPermissions: bigint[];
  requiredEntitlement?: 'free' | 'plus' | 'pro';
  dependsOn?: string[];
  commands?: CommandDefinition[];
  listeners?: EventListener[];       // bus subscriptions
  rules?: RuleDefinition[];          // trigger/action registrations
  jobs?: ScheduledJob[];
  migrations: Migration[];           // module owns its own tables
  dashboard?: { icon: string; sections: SectionDescriptor[] };
}
```

Framework-enforced behaviour: a module missing a required intent **disables itself and reports why** in the dashboard; a module lacking a Discord permission surfaces *which* permission and *where* ("the bot did nothing" is the #1 support ticket in this category — kill it structurally); entitlement gating is declared, not hand-coded per module.

## 8. Module catalog → phase mapping

- **Phase 0 (foundation):** `ping` only — the vertical-slice proof.
- **Phase 1 (moderation core):** `cases`, `logging`, `permissions`, `rules` (preset rules), standard mod commands (ban/kick/timeout/purge/slowmode/lockdown), temp actions with auto-reversal, warn escalation, dashboard v1.
- **Phase 2 (security):** anti-nuke (per-actor sliding windows on channel/role/webhook/emoji delete + mass ban/kick; circuit breaker strips roles first, investigates after; maintenance-mode bypass for legit bulk admin work), anti-raid (join-rate, account-age, avatarless heuristics), verification gate, quarantine, backup/restore (**obfuscation-aware from day one**, §10), phishing-link detection via community blocklist feeds.
- **Phase 3 (engagement):** leveling + XP curves, rank cards (Satori/Resvg — not headless Chrome), role rewards, leaderboards, welcome/goodbye cards, autorole, sticky roles, reaction/button/dropdown roles, starboard.
- **Phase 4 (utility):** tickets, giveaways, tags, suggestions, embed builder, scheduled announcements, reminders, temp VCs, counters. Native Discord polls, native AutoMod delegation for keyword/mention-spam (runs at Discord's edge, zero intent cost).
- **Phase 5 (commercial):** entitlements/billing, premium gating, sharding hardening, App Verification, privileged intent application, SLOs, status page.
- **After engine is stable, high priority:** visual rule builder — worth more than any three modules.

## 9. Dashboard spec

- Start server functions are a thin RPC layer: authenticate → authorise → audit → delegate to the API service. **No business logic in server functions** — workers and dashboard must share one definition of every domain operation.
- Middleware chain pattern (this exact shape):

```ts
const requireGuildAccess = createMiddleware().server(async ({ next, data }) => {
  const session = await getSession();
  const access = await resolveGuildAccess(session.userId, data.guildId);
  if (!access) throw new Error('forbidden');
  return next({ context: { session, access } });
});

export const updateModuleConfig = createServerFn({ method: 'POST' })
  .middleware([requireGuildAccess, requirePermission('MANAGE_GUILD'), auditTrail])
  .validator(moduleConfigInput)
  .handler(({ data, context }) => api.modules.update(data, context));
```

- OAuth scopes: `identify` + `guilds`; `guilds.members.read` to resolve dashboard access by staff role rather than Manage Server only.
- Router search-param schemas (Zod) hold all table filter state — case type, moderator, date range, sort, page — typed and shareable by URL.
- **Form generator v1 scope (do not exceed):** walk Zod schema → emit `FieldDescriptor[]` → render via a registry keyed by field type. Supported v1 field types: `string`, `number`, `boolean`, `enum`, `channel-id`, `role-id`, `duration`, and flat arrays of those. Objects nest one level. **No** discriminated unions, no recursive schemas — the rule builder is a bespoke UI later, not generated.
- No websockets in v1; Query `refetchInterval` for module-health panels.
- Premium-feel features (build in this order after basics): live Components-V2-accurate embed preview → config diff/history/rollback → dry-run preview of rules against last 24h of events → module health (intents granted, permissions missing, last error, events/sec).

## 10. Discord platform constraints (verified August 2026 — re-verify before coding)

Hard deadlines and behaviours that shape the design:

1. **Channel obfuscation — mandatory 16 Nov 2026.** Channels the bot can't `VIEW_CHANNEL`: gateway delivers them with `name: "___hidden___"`, sensitive fields nulled, flag `CHANNEL_OBFUSCATED` (`1 << 17`); `GET /guilds/{id}/channels` omits them. Breaks naive backup/restore and permission auditing. Backup module must detect obfuscated channels and surface "these N channels can't be backed up" to admins. Testable now: `capabilities: 1 << 15` in Identify, or dev-portal toggle.
2. **Privileged intents (since 10 Jun 2026):** threshold is 10,000 **users** (not servers); below it, toggle in portal; above it, apply; **reapply annually** (calendar it); App Verification is now a separate process. Modules degrade gracefully when an intent is absent (§7). Read Discord's "You Might Not Need a Privileged Intent" guide before assuming.
3. **Permission splits (live since 23 Feb 2026):** `PIN_MESSAGES` (1<<51), `CREATE_GUILD_EXPRESSIONS` (1<<43), `CREATE_EVENTS` (1<<44), `SET_VOICE_CHANNEL_STATUS` (1<<48). Compute the invite-URL permission integer from module manifests, not by hand.
4. **Rate limits:** Request Guild Members (all-members form) = 1/guild/bot per 30s — maintain incremental member cache from `GUILD_MEMBER_*` events, never brute-force. Session starts 1000/day shared across shards (hence I13). Read `max_concurrency` from `GET /gateway/bot`.
5. **Use, don't rebuild:** invites that grant roles (`role_ids`) and target-user restriction (Jan 2026) → verification/gated access; `Search Guild Messages` endpoint (Mar 2026, needs Message Content + `READ_MESSAGE_HISTORY`); `Get Guild Role Member Counts` (Dec 2025); per-guild bot `banner`/`avatar`/`bio` via Modify Current Member (easy premium feature); resolved-channel `app_permissions` in interactions (Jul 2026) for cheap prechecks; native AutoMod; native polls; context-menu limit is now 15/type.
6. **Components V2** (`IS_COMPONENTS_V2`, flag 1<<15): Container/Section/Separator/Text Display/Thumbnail/Media Gallery/File; ≤40 components; `content`, `embeds`, `poll`, `stickers` disabled under the flag. Modals support Label-wrapped selects, Radio Group, Checkbox Group, Checkbox, File Upload (with `file_types` filter as of Aug 2026) — build config flows in-Discord, a real edge over MEE6.
7. **Gotchas:** `channel.application_id` now nullable; message forwarding requires content access; subscription statuses `INACTIVE = 1`, `ENDING = 2` (docs had them swapped pre-Jun-2026).

## 11. Testing & verification strategy

- **Unit (Vitest):** permission math gets exhaustive tests — role order, category inheritance, explicit allow/deny, `ADMINISTRATOR` short-circuit, timeout state — plus fast-check property tests. Zod schemas: round-trip config → validate → migrate.
- **Integration (Testcontainers):** Postgres + Redis per suite. Bus: publish → kill consumer mid-handling → restart → assert effectively-once via dedupe. Executor: idempotency (same key twice → one case row), precheck failures return structured reasons, temp action auto-reversal fires.
- **Gateway fixtures:** recorded raw dispatch payloads in `tooling/fixtures/`; a replayer feeds them to the normaliser. No live Discord in CI (I11).
- **REST proxy:** mock Discord upstream; assert two workers share one bucket; assert 429 + `Retry-After` handling and global-limit behaviour.
- **Dashboard:** server-fn middleware tests (forbidden without access; `audit_trail` row on every mutation); form generator snapshot per supported field type.
- **CI gates every PR:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

## 12. Phase gates

### Gate 0 — Foundation (plan-mode scope; ~3–4 weeks of work)
Deliverables: monorepo scaffold; docker-compose; gateway service (shards, Redis session state, normaliser, publisher); REST proxy; `EventBus`; `ActionExecutor`; core Drizzle schema + migrations; `ModuleManifest` runtime; form-generator descriptor pipeline with **three** field types (`boolean`, `string`, `channel-id`); dashboard shell with Discord OAuth (Better Auth) + guild picker + `requireGuildAccess`; `ping` module.
Acceptance — all proven by command, not assertion:
- `docker compose up -d && pnpm i && pnpm typecheck && pnpm lint && pnpm test` green.
- Kill the worker mid-event in the integration test; event redelivered, handled effectively once.
- Two worker processes issue REST calls; proxy test proves shared bucket + correct 429 handling.
- `ping` end-to-end: toggle on in dashboard → `/ping` responds in the test guild → `guild_modules` row valid against schema → `audit_trail` row with diff.
- Restarting the worker app does **not** cause a gateway identify (check session-start count / gateway logs).
- Adding a second trivial module takes < 1 day. If it doesn't, fix the framework before Phase 1.

### Gate 1 — Moderation core
All standard mod commands via ActionExecutor with structured failure reasons; `cases` browsing in dashboard (Table + typed search params); temp ban/timeout auto-reversal proven by integration test with a clock; warn-escalation preset works end-to-end; message edit/delete logging behind per-guild opt-in with TTL. *This alone is a usable product.*

### Gate 2 — Security
Anti-nuke integration test: replayed audit-log fixture of 20 channel deletions in 5s trips the breaker; breaker action is role-strip-first; maintenance mode suppresses it. Backup snapshot marks obfuscated channels and restore skips them with a report. Verification gate uses role-granting invites where possible.

### Gates 3–5
Plan when reached; criteria patterned on the above (every feature has an integration test proving its happy path and its permission-failure path).

## 13. Non-goals for v1

Music (DAVE E2EE is mandatory for voice since 1 Mar 2026; large, legally exposed, shares nothing with the rest), economy/mini-games, AI features, custom rank-card editor (ship 3 presets), mobile app, localisation beyond English (externalize strings anyway), self-hosting support, NATS, ClickHouse, TanStack DB, live websocket dashboard.

## 14. Questions for the human — ask before executing, do not assume

1. `[ASK]` Discord application ID + a dedicated **test guild** ID (agent must never test against a real community).
2. `[ASK]` Bot public name/branding ("Proton" may collide — check availability) and dashboard domain (needed for OAuth redirect URIs).
3. `[ASK]` Hosting confirmation: Fly.io first as locked in §2, or straight to K8s?
4. `[ASK]` Monetization confirmation: Discord App Subscriptions only for v1?
5. `[ASK]` Message-log retention default (proposal: opt-in, 30 days) and where the privacy policy will live.
6. `[ASK]` Which privileged intents to toggle on now (proposal: Server Members + Message Content; skip Presence).
7. `[ASK]` License / repo visibility (proprietary private assumed).
8. `[ASK]` Team size and weekly hours — phase estimates assume 1–3 experienced devs and should be rescaled.

## 15. Known failure modes to design against

- **Anti-nuke is a race you can lose:** audit-log delivery is eventually consistent and unordered. Value = speed + restore quality, not perfect prevention. You cannot stop the guild owner; don't try.
- **Idempotency is not a patch:** design it in from the first handler (I4).
- **Config migrations:** schemas will change after thousands of guilds have saved configs. `schema_version` + forward migrations from day one (I5).
- **Proton is itself an attack vector:** re-auth for destructive dashboard ops, rate-limit mass actions, refuse to act on owner/self/above-role targets (I8).
- **Permission math is where bugs hide:** one implementation in `core`, exhaustively tested (§11), always surfacing *why* an action failed.
