# Phase 4 — Utility (plan)

> **Implementation status — 2026-08-17.** All ten modules in §1 are built, registered and wired.
> **Twenty-seven modules register.** The repo is green on `bun run typecheck` (37/37) and
> `bun run lint`, and `bun test` reports **3241 pass, 26 fail — every failure is a
> `*.integration.test.ts` reporting "Could not find a working container runtime strategy"**, the
> same 26 as before Phase 4 started. Read §0 and §7: **no gate can be claimed from this host**,
> because the integration suites have still never executed. §8 records the adversarial review that
> followed, which found seventeen real defects in this phase's own code — all since fixed.

Companion to `docs/PLAN.md`. Planned against the codebase **as it actually exists**, per PLAN.md §0
("later phases get planned when their turn comes"). PLAN.md stays authoritative; where this file
adds detail it is detail, and where it deviates it says so and why.

Discord facts below need re-verifying against `docs.discord.com` at implementation time — CLAUDE.md
requires it and several of these surfaces moved during 2026.

---

## 0. Preconditions

The working copy at the start of Phase 4 held Phase 3 plus `automod`, uncommitted, across 119 paths.
Establishing a baseline before touching anything found:

- `bun run typecheck` — 27/27 green.
- `bun run lint` — **two formatting failures**, in `packages/core/src/actions/scheduled-action-sweeper.ts`
  and `packages/db/test/scheduled-action-store.integration.test.ts`. Formatted.
- `bun test` — 2507 pass, 28 fail. Twenty-six are `Could not find a working container runtime
  strategy`. **Two were real**: `/ban > names the missing permission when the bot cannot ban` and
  `/kick > names KickMembers when it is missing`.

Those two were a genuine stale-test regression, not a flake. The uncommitted rewrite of
`resolvePrecheckContext` made `hints.appPermissions` apply **only** to channel-scoped kinds — a
guild-scoped ban must not be judged by the `app_permissions` of the channel it was typed in, because
a channel overwrite cannot actually take `BAN_MEMBERS` away from the bot. The code is right; the
tests were still taking the permission away through the hint and asserting the reply named the
*channel*. Fixed by giving the harness a `botPermissions` override that lowers the bot's **role**
permissions, and asserting the reply names the **guild**.

**Gate 3 is still not proven, and Gate 4 cannot be claimed from this host.** Every
`*.integration.test.ts` in the repo has never executed here: Bun cannot open Windows named pipes, so
Testcontainers cannot reach Docker Desktop (CLAUDE.md, and confirmed again by the 26 failures above).
A skipped suite is not a passing suite. Every criterion in §5 that depends on Postgres or Redis is
**written but unproven** until it runs in WSL, in CI, or against `DOCKER_HOST=tcp://localhost:2375`.

---

## 1. What Phase 4 delivers

PLAN.md §8: tickets, giveaways, tags, suggestions, embed builder, scheduled announcements, reminders,
temp VCs, counters, native Discord polls. `automod` was filed under this phase and landed early
(PHASE-3.md §8), so it is not repeated here.

**Ten new modules.** Seventeen existing become twenty-seven.

| Module | Category | Backed by | Limit key |
|---|---|---|---|
| `tags` | utility | table `tags` | `tags` |
| `reminders` | utility | table `reminders` | `remindersPerUser` |
| `embeds` | utility | config | `savedEmbeds` |
| `announcements` | utility | config | `announcements` |
| `polls` | utility | table `polls` | `activePolls` |
| `giveaways` | engagement | tables `giveaways`, `giveaway_entries` | `activeGiveaways` |
| `suggestions` | engagement | tables `suggestions`, `suggestion_votes` | — |
| `tickets` | utility | table `tickets` + config panels | `ticketPanels`, `openTicketsPerUser` |
| `tempvc` | utility | config creator channels + Postgres state, Redis presence | `tempVcHubs` |
| `counters` | utility | config | `counters` |

`packages/core/src/entitlements/limits.ts` already names all ten limit keys and has since Phase 3.
Nothing has ever read them (§2, G2). Phase 4 is the phase where that stops being decoration.

### Config-backed vs row-backed — the decision that shapes everything

A module can **read** its config and **cannot write it**. There is no config-write port on
`ModuleContext` and adding one would let any module rewrite any guild's settings from an event
handler. So the split is forced, not stylistic:

- Things an **admin** authors and a guild has few of — saved embeds, scheduled announcements,
  counter channels, temp-VC hubs, ticket panels — live in **module config**, authored in the
  dashboard, with a bespoke panel where the shape is an array of objects (PLAN.md §9 puts arrays of
  objects outside the form generator's v1 vocabulary by design).
- Things **members** create constantly and unboundedly — tags, reminders, giveaways, suggestions,
  open tickets, running polls — live in **module-owned tables**.

The one place this bites is `/embed create`: an embed authored in Discord cannot be *saved*, only
posted. So the embed builder ships saved embeds in config (dashboard-authored, with preview) and a
`/embed send` that opens a modal, composes one embed and posts it immediately. Named openly rather
than smuggled in as a limitation nobody wrote down.

---

## 2. The framework gaps that come first

Phase 4 inherits far more framework than Phase 3 did — modals, autocomplete, poll events, durable
module schedules, `ActionResult.body`, the interaction respond helpers and the custom-id codec all
landed in the Phase 3/automod groundwork. What is left is small and specific.

### G1 — `create_channel` cannot carry permission overwrites

`createChannelPayloadSchema` was written for backup restore and carries
`{name, type, parentId, position, topic, nsfw, rateLimitPerUser}`. Tickets need a channel that is
private **at creation**, and temp VCs need `user_limit` and `bitrate`. Creating a public channel and
patching it a moment later is a visible leak: for the width of one round trip everyone in the guild
can read a ticket.

Add `permissionOverwrites`, `userLimit` and `bitrate`. `permission_overwrites` on create requires
`MANAGE_ROLES` on top of `MANAGE_CHANNELS` — Discord refuses to let a bot grant permissions it is not
allowed to manage — so it belongs in `PAYLOAD_PERMISSIONS`, alongside the identical rule
`edit_channel` already has.

### G2 — a guild's tier is unreadable at runtime

`checkLimit(tier, key, current)` is pure and tested. `TIER_LIMITS` names every Phase 4 key. And
nothing anywhere reads `guilds.tier` outside the API's own row: `RegistryEnvironment.tier` is
supplied by the dashboard for `registry.evaluate`, never by the worker, and `ModuleContext` has no
tier at all. Ten modules that all need "is this guild allowed one more?" cannot answer it.

Close it along the path config already travels, because that path is already cached, already
invalidated on `proton.config_changed`, and already reaches every module surface (command, listener,
scheduled handler):

- `ModuleConfigView` gains `tier`, read from `guilds.tier`.
- `GET /guilds/:guildId/modules/:moduleId` returns it.
- `HttpConfigProvider` carries it into `ModuleConfigSnapshot`.
- `ModuleContext.tier?: EntitlementTier`, defaulted to `free` by every consumer.

Optional on the context, because a `ModuleContext` built by a test harness should not have to know
about billing to call a listener.

### G3 — per-guild sequential numbers

Tickets and suggestions both want "#12", the same way cases have a case number. `DrizzleCaseRecorder`
does it with an inline `select coalesce(max(...), 0) + 1` in the insert, guarded by a unique index on
`(guild_id, case_number)`. That is the pattern; it is repeated per table rather than abstracted,
because the abstraction would be one function taking a table and a column and reading worse than the
three lines it replaced.

### G4 — reminders deliver in-channel, not by DM

A DM needs `POST /users/@me/channels` and then a send against the returned id — two calls, where
`toRestCall` maps one kind to exactly one `RestCall`. Modelling that would mean either a two-step
action kind or a `create_dm` kind whose result feeds a second request, and neither is worth it for
one feature.

**Decision: reminders post in the channel they were set in**, mentioning the member, with
`allowed_mentions: { parse: [], users: [userId] }` so nothing else can be pinged. Recorded here so
the next reader knows it was decided rather than missed.

### G5 — `interaction.modal` and `interaction.autocomplete` have no consumers

Both are normalised, both have fixtures, and no manifest subscribes to either. Phase 4 is their first
consumer (`tags` autocomplete, `embeds`/`tickets`/`suggestions` modals). Nothing to build — but the
registry's "somebody emits this" assertion has never been exercised for these two, so the first
subscriber is also the first proof the arm works.

### G6 — storage

Six new tables in the core drizzle set, following the precedent PHASE-3.md §7 settled on (module
packages own the Drizzle table definition; the DDL lives in `packages/db/drizzle/*.sql` with a
`meta/_journal.json` entry, because `manifest.migrations` was deleted rather than repaired):

```
tags              (guild_id, name, content, created_by, uses, created_at, updated_at)
                  PK (guild_id, name)
reminders         (id, guild_id, user_id, channel_id, remind_at, content, created_at, delivered_at)
                  INDEX (guild_id, user_id), INDEX (remind_at) WHERE delivered_at IS NULL
giveaways         (id, guild_id, channel_id, message_id, prize, winner_count, ends_at, ended_at,
                   created_by, requirements JSONB, winner_ids TEXT[])
giveaway_entries  (giveaway_id, user_id, entered_at)  PK (giveaway_id, user_id)
suggestions       (id, guild_id, number, channel_id, message_id, thread_id, author_id, content,
                   status, decided_by, decided_at, decision_reason, created_at)
                  UNIQUE (guild_id, number)
suggestion_votes  (suggestion_id, user_id, vote)  PK (suggestion_id, user_id)
tickets           (id, guild_id, number, panel_id, channel_id, opener_id, status, opened_at,
                   closed_at, closed_by, close_reason)
                  UNIQUE (guild_id, number), INDEX (guild_id, opener_id) WHERE status = 'open'
polls             (guild_id, channel_id, message_id, created_by, question, ends_at, ended_at,
                   announce_channel_id)  PK (guild_id, message_id)
```

Temp-VC live state is Redis, not Postgres: a channel that exists only while someone is sitting in it
is exactly the ephemeral-and-hot case Phase 3 used Redis for.

### G7 — dashboard

Nothing structural. Bespoke panels for the five array-of-object configs (`embeds.saved`,
`announcements.scheduled`, `counters.counters`, `tempvc.hubs`, `tickets.panels`) following
`RoleMenusPanel`, and read-only view tabs for the four row-backed surfaces an admin genuinely needs
to see (`tags`, `giveaways`, `suggestions`, `tickets`) following the leaderboard, each with a typed
Zod search-param schema and an `apps/api` endpoint behind it.

---

## 3. Slices

Ordered so each one ends somewhere shippable.

### 4.A — Framework

G1 channel-create overwrites · G2 tier on the config path · G3 numbering precedent · G6 migrations
and tables. No user-visible feature; proof is that the first module compiles against it.

### 4.B — `tags`

The cheapest module in the phase, and the one that proves autocomplete. `/tag <name>` with
autocomplete, `/tag create|edit|delete|list|info`. Uses counted on recall. Limit `tags`.

### 4.C — `reminders`

`/remind <duration> <text>`, `/reminders list`, `/reminders cancel <id>`. Durable module schedule
per reminder, cancelled through `ctx.cancel`. Limit `remindersPerUser` — per member, so the check is
a count scoped to `(guild_id, user_id)`, not the guild.

### 4.D — `embeds` and `announcements`

Two config-backed modules sharing one dashboard idiom. `embeds`: saved embeds in config, `/embed post
<name> [channel]`, `/embed send` (modal, one-off). `announcements`: scheduled posts in config, each
one a durable schedule keyed on its id, reconciled on `proton.config_changed` — add, edit, remove and
disable must all reach the schedule table, and a stale schedule for a deleted announcement must be
cancelled rather than left to fire against nothing.

### 4.E — `polls`

`/poll create` sends a native poll (`send` with a `poll` payload — the kind, the permission bit and
the caps are all already in `payloads.ts`). `/poll end` uses `end_poll`. A durable schedule announces
results after the deadline. Limit `activePolls`.

### 4.F — `giveaways`

`/giveaway start|end|reroll|list`. An Enter button on the message; entrants in `giveaway_entries`;
winners drawn at the deadline by a durable schedule. **The draw takes an injected RNG**, because a
winner-selection test that cannot fix the seed asserts nothing. Limit `activeGiveaways`.

### 4.G — `suggestions`

`/suggest <text>` posts an embed with vote buttons and optionally opens a thread;
`/suggestion accept|deny|implement <number> [reason]` edits it and records who decided. Votes are
buttons, not reactions, because a button interaction carries the member and a reaction does not carry
a stable event id (PHASE-3.md G1/R3).

### 4.H — `tickets`

Panels in config; a button opens a private channel with overwrites set **at creation** (G1);
`/ticket close|add|remove|rename`; transcript posted to a log channel on close; auto-close by durable
schedule after configurable inactivity. Limits `ticketPanels` and `openTicketsPerUser`.

### 4.I — `tempvc` (Temporary Voice Channels)

Creator channels in config, each with its own settings: name template, default limit, bitrate,
privacy, the eleven owner controls, ownerless behaviour, temporary role, delete delay, per-member
cap, creation cooldown and permission sync. `voice.state_updated` on a creator channel makes a
channel, moves the member and posts the control panel into it. Buttons and modals for the owner,
`/voice` for the same actions by command. Limit `tempVcHubs`.

Ownership, access (trust/block) and roles Proton granted live in Postgres — `temp_voice_channels`,
`temp_voice_access`, `temp_voice_roles` — because a TTL is the wrong lifetime for a fact somebody's
permissions depend on. Redis keeps only presence, which reconcile rebuilds.

**The failure mode to design against:** the create is not one step. A row is reserved *before*
Discord is called, so a create that dies half-way leaves evidence rather than a channel nothing can
find; the reservation also enforces the per-member cap in the same statement, which is what makes
two joins in the same millisecond yield one channel. Deletion is deferred and re-checked, because
Discord fires leave-then-join whenever a member switches channel and an immediate delete races the
rejoin. Recovery has three legs, because no one of them covers a restart: `guild.available`
reconciles against `GUILD_CREATE`'s `voice_states` (fresh IDENTIFY only), `channel.deleted` forgets
a channel somebody removed by hand (without it that member's slot stays occupied forever), and a
rolling per-guild patrol re-arms itself every minute while the guild has live channels — that is
what catches a channel emptied while the worker was down, which fires no event at all.

**Not a moderation action.** Every temp-voice write passes `record: false`: the case ledger is the
product's headline feature and channel churn would bury it.

### 4.J — `counters`

Counter channels in config, refreshed by a cron `job`. **Channel renames are rate-limited far more
tightly than ordinary edits** — the well-known bucket is 2 per 10 minutes per channel — so the
refresh cadence is 10 minutes and is not configurable downward, and the module skips a write when the
rendered name has not changed. Getting this wrong burns the guild's channel-edit bucket and the
symptom is other features mysteriously stalling.

### 4.K — Dashboard and API

The panels and views from G7, the endpoints behind them, and `docs/PLAN.md` updated.

---

## 4. What is deliberately not in Phase 4

- **DM delivery** (G4).
- **Ticket transcripts as downloadable files.** The transcript is posted as a message; an uploaded
  HTML file needs the multipart path plus a retention decision, and retention is a legal surface.
- **The visual rule builder.** PLAN.md §8 files it after the engine is stable, not here.
- **Discord-side authoring of saved embeds/announcements/counters/hubs/panels** (§1).

---

## 5. Gate 4 acceptance

Patterned on Gates 0–3. Every criterion proven by command output, not assertion.

1. `docker compose up -d && bun install && bun run typecheck && bun run lint && bun test` green,
   **with integration suites running** — from WSL, CI, or `DOCKER_HOST=tcp://localhost:2375`.
2. `/tag` autocomplete answers within Discord's deadline and recalls the right body; a tag name that
   does not exist says so instead of failing silently.
3. A guild at its `tags` limit is refused with the tier, the limit and what to do about it.
4. A reminder set for T+2s fires once, in the channel it was set in, pinging only its owner; a
   cancelled reminder does not fire; a replayed schedule does not double-deliver.
5. A scheduled announcement fires on its cron; deleting it from config cancels its schedule.
6. `/poll create` sends a native poll; `/poll end` expires it; the result announcement fires once.
7. A giveaway with a fixed RNG seed draws a reproducible winner set; entering twice records one
   entry; the draw at the deadline fires exactly once under a replayed schedule.
8. A suggestion records one vote per member per suggestion, and `accept` edits the original message.
9. A ticket channel is created **private in one call** — asserted on the request body, not on a
   follow-up patch; a second ticket by the same member is refused by `openTicketsPerUser`; a bot
   without `ManageChannels` names that permission.
10. A replayed `voice.state_updated` join on a hub creates one channel and moves the member; the last
    member leaving deletes it; a worker restart mid-session neither leaks the channel nor deletes an
    occupied one.
11. A counter renders its name, skips the write when unchanged, and never exceeds one rename per
    channel per refresh.
12. Every new module has an integration test for its happy path **and** its permission-failure path
    (PLAN.md §12, Gates 3–5).
13. Ten modules were added without changing the module framework beyond §2. If the framework had to
    move for module N, it is named in §7.

---

## 6. Risks

- **R1 — channel-rename rate limits.** The tightest bucket in the phase (4.J). Measure, do not guess.
- **R2 — temp VCs leak channels on restart.** Mitigated by Redis TTL + `guild.available`
  reconciliation (4.I). This is the criterion most likely to be quietly broken.
- **R3 — ten modules is a lot of surface for one phase.** The framework check in PLAN.md §12 says a
  module should take under a day. If it does not, the framework is the bug.
- **R4 — entitlement limits become load-bearing.** Until Phase 5 there is no billing, so every guild
  is `free` and every limit is a hard cap nobody can lift. That is correct but will surprise someone.
- **R5 — integration suites remain dark on this host.** Unchanged from Phases 2 and 3.
- **R6 — tickets and suggestions store member-authored content.** Same GDPR surface as message logs
  (PLAN.md §6). Retention needs a decision before launch.

---

## 7. Questions for the owner (§14 style — answer before shipping)

1. `[ASK]` Retention for ticket channels and their transcripts, and for suggestion bodies.
   *(Proposal: transcripts follow the message-log posture — opt-in, 30 days.)*
2. `[ASK]` Which Phase 4 modules, if any, are premium (`requiredEntitlement`)? The field exists;
   retrofitting a gate after guilds have used a free feature is worse than declaring it now.
3. `[ASK]` Ticket channels or ticket threads as the default? Channels are implemented; threads are
   cheaper against the 500-channel guild cap and would be a config option.
4. `[ASK]` Counter refresh cadence — 10 minutes is the rate-limit floor. Is that acceptable, or
   should counters be premium-gated to a shorter interval later?

---

## 7. What was built, and what was not

### Built

| Slice | State | Tests | Notes |
|---|---|---|---|
| 4.A framework | done | — | `create_channel` overwrites, tier on the config path, `configLimits`, `checkListLimit` |
| 4.B `tags` | done | 34 | the reference module for the phase; first consumer of `interaction.autocomplete` |
| 4.C `reminders` | done | 60 | durable schedule per reminder, cancel by autocomplete, in-channel delivery (G4) |
| 4.D `embeds` | done | 101 | saved embeds in config, `/embed send` composes one-off through a modal |
| 4.D `announcements` | done | 123 | `at` + `every` instead of cron (§7 deviations); reconcile is a pure function |
| 4.E `polls` | done | 76 | native Discord polls; result announcement links rather than restates (§7 deviations) |
| 4.F `giveaways` | done | 91 | inside-out Fisher–Yates over an injected RNG, so a winner set is reproducible |
| 4.G `suggestions` | done | 75 | buttons not reactions; tallies recomputed from the vote table, never incremented |
| 4.H `tickets` | done | 57 | private in the create call (G1); inactivity auto-close; reserve → create → attach |
| 4.I `tempvc` | done | 119 | reserve → create → attach; deferred re-checked delete; patrol; panel + `/voice` |
| 4.J `counters` | done | 60 | 10-minute floor, unchanged names skipped |
| 4.K dashboard | partial | — | see below |

Three things the plan did not anticipate:

- **`ChannelState.name`.** Counters must not rewrite a name that already reads correctly, and
  comparing needs the current name. It comes from `GUILD_CREATE`/`CHANNEL_UPDATE` for free and is
  optional, so an older snapshot reads as "not known" and the counter writes anyway — one wasted
  edit rather than a counter frozen at a stale number.
- **`send` derives `EmbedLinks` and `AttachFiles` from its payload.** `REQUIRED_PERMISSIONS.send`
  is `ViewChannel | SendMessages`, so a bot without `EmbedLinks` passed the precheck and was
  refused by Discord instead — exactly the "the bot did nothing" failure §7 of PLAN.md exists to
  kill. It now joins `SendPolls` in `PAYLOAD_PERMISSIONS`.
- **`allowed_mentions` on interaction replies.** A recalled tag is written once and posted by
  anyone, so a stored `@everyone` would otherwise be a button any member could press. The field
  existed on `send` and not on `interaction_reply`/`interaction_followup`.

### Deviations, stated openly

1. **Announcements take `at` + `every`, not cron.** The durable scheduler wants an explicit
   next-run `Date`, `cron-parser` is only a transitive BullMQ dependency, and a duration covers the
   real cases. A cron vocabulary can be added later without moving the storage.
2. **A poll result announcement links the poll instead of restating the tallies.** Reading final
   counts needs a REST read, and a module has no read port (I2). Saying "see the poll" is honest;
   printing counts Proton cannot see would not be.
3. **Reminders deliver in-channel** (G4), and **saved embeds, announcements, counters, hubs and
   ticket panels are dashboard-authored** (§1). Both follow from ports that deliberately do not
   exist.

### Not built

1. **Integration tests have never run.** Every `*.integration.test.ts` in the repo — Phase 4's
   included — is unexecuted on this host. Docker's TCP endpoint on 2375 is closed and CLAUDE.md
   rules out the named-pipe path for Bun.
2. **Gate 4 acceptance is therefore unproven.** §5's criteria 1, 4, 5, 6, 7, 9, 10 all depend on a
   real Postgres or Redis. The behaviour they describe is covered by in-process tests against the
   real `DefaultActionExecutor` and a fake REST upstream, which is not the same thing.
3. **Row-browsing dashboard tabs exist for `tags` only.** G7 planned four. `tags` ships the whole
   path — `tagQuerySchema`, `GET /guilds/:guildId/tags`, a server fn behind `requireGuildAccess`,
   and a filterable, sortable, paged tab — and is the template. `giveaways`, `suggestions` and
   `tickets` have their settings pages and their Discord commands, but no dashboard list; each
   needs a query schema, an API endpoint and a view entry, following what `tags` now demonstrates.
4. **No live embed preview beyond the dashboard's own.** The saved-embed editor renders title,
   description, colour and footer from the stored values; it is not a Components-V2-accurate
   renderer. PLAN.md §9 lists that as a premium-feel feature, not a Phase 4 deliverable.
5. **`drizzle-kit generate` still does not see module-owned tables.** All six new tables follow the
   established precedent — the Drizzle definition lives in the module package, the DDL is
   hand-written in `packages/db/drizzle/*.sql`. Unchanged from Phase 3, and worth closing before the
   set grows again.

---

## 8. The review, and what it found

After the ten modules were built and green, four independent reviewers went over the riskiest
seams — idempotency, permission math, entitlement limits, and storage. Every finding was then handed
to a separate refuter whose default answer was "refuted" and whose instructions were to close it
unless it could read the code and confirm the failure.

**Seventeen findings survived.** That number is the useful part of this section: a phase can be
typecheck-clean, lint-clean and 3300 tests green and still ship this many real defects, because
tests written alongside the code inherit its assumptions.

Three root causes accounted for almost all of them.

### R1 — Commit the transition, then lose the side effects

`closeTicket`, `endGiveaway` and `closePoll` each committed a state change with a conditional
`UPDATE` and then gated the work that follows — transcript, message edit, announcement, channel
deletion — behind "did I win that update?". A crash, a lease lapse, or a transient Redis error
between the two left the row in its final state and the work permanently undone: the retry read the
row, saw it already closed, and did nothing. A closed ticket kept its channel with no transcript and
no way to reach it, because `byChannel` filters on `status = 'open'`.

The fix is the same everywhere: the side effects run off the already-committed row, and their
idempotency keys derive from the **entity** rather than the caller, so a genuine concurrent close
collapses in the executor instead of posting twice. Re-keying had to come first — replaying
caller-keyed actions would have doubled the closing message in the very race the guard existed for.

### R2 — `skipped_duplicate` treated as success, then new state written off it

A redelivered `/giveaway start` minted a fresh id, watched the post come back
`skipped_duplicate`, counted that as success, and inserted a second giveaway with no message — which
held an `activeGiveaways` slot and later announced "nobody entered" beside the real winners. A
redelivered `/remind` booked two reminders that both fired. A redelivered ticket-panel press told the
member their ticket had failed after the first delivery opened it.

`skipped_duplicate` means *somebody already did this*, and is the one status that must never lead to
a new write. `suggestions` and `polls` already got this right; the others did not.

### R3 — Rebuilding a replace-everything array from scratch

`edit_channel` replaces the whole permission-overwrite array. `/ticket add` rebuilt it from the panel
each time, silently revoking everyone added before; `/vc unlock` sent a bare `[]`, discarding every
overwrite on the channel. Both now start from the channel's live overwrites. The first attempt at
that fix was **worse than the bug** — an empty or cold channel cache would have stripped the
`@everyone` deny and made a ticket world-readable — so it merges the live list with the invariants
the panel requires instead of choosing one of them.

### Permission math

Two gaps that would have produced Discord 403s naming nothing, which is exactly what I8 exists to
prevent: `move_member` never judged the destination channel and never asked for `Connect`, and a
channel created or edited with overwrites did not require the bits those overwrites hand out —
Discord refuses to let a bot grant a permission it does not itself hold. Both are now derived in
`PAYLOAD_PERMISSIONS`, and `move_member` is channel-scoped on its payload's channel.

Correcting this made two module harnesses fail, because their fake bots were under-permissioned
against the corrected rules. The harnesses were widened; the rule was not weakened.

### Limits that could never be released

A poll Discord refused to expire, and a ticket channel deleted by hand rather than closed, each left
a row that counted against `activePolls` / `openTicketsPerUser` forever. Polls now stop counting a
row past its own deadline — Discord expires the poll itself whether or not Proton's job ran — and
tickets gained `/ticket close number:<n>` so a stranded row can be cleared from anywhere.

### Still open, and owned

- **`/ticket` has no `default_member_permissions`.** Close-by-number and `/ticket panel` inherit
  whatever gate the guild sets. `CommandContext` carries `userId` but no member permissions or role
  ids, so a module cannot check staff status in a handler. Closing this needs either member
  permissions on `CommandContext` or a second gated command, the way `verification` splits `/verify`
  from `/quarantine`. Named rather than guessed at.
- **Nothing reconciles ticket rows against `channel.deleted`.** The escape hatch above is a recovery
  path, not a cure; a listener on that event would remove the need for a human to notice.
- **A same-session re-join of the same hub is a no-op.** The voice event's natural key is
  `(guild, user, session, channel)`, so a genuine re-join is indistinguishable from a redelivery —
  the same trade the reaction arm documents (PHASE-3 R3). It is now non-destructive rather than
  destructive, which is the part that mattered.
