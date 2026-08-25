# Giveaways — build record

Companion to `docs/modules/GIVEAWAYS.md` (the spec) and `docs/PLAN.md`. Records what was actually
built, what deviates from the spec and why, and what is proven versus written-but-unproven.

**Answers to the spec's §8 `[ASK]` questions**, given by the owner before implementation:
button-only entry · `leveling.messages` defaults to `30d` · claim window off by default, 24h when
enabled · `no_recent_wins` guild-wide at 7 days · no multipliers premium-gated · no entrant cap.

---

## 1. What landed

Two separable deliverables, in this order.

### A — the shared provider registry (`packages/core/src/providers/`)

| File | What it is |
|---|---|
| `types.ts` | `MemberContext`, `ConditionResult`, `ConditionProvider`, `MultiplierProvider`, `ModuleAvailability` |
| `registry.ts` | `ProviderRegistry` — duplicate-id rejection, namespace enforcement, `listAvailable(guildId)` |
| `evaluate.ts` | batch orchestrators, multiplier stacking, `describeRequirements`/`describeMultipliers` |
| `member-context.ts` | adapters from rule facts, from a gateway member payload, and for a departed member |
| `rest-member-context.ts` | `RestMemberContextLoader` (one member) and `BulkMemberContextLoader` (one page per 1000) |
| `builtins.ts` | `core.has_role`, `core.lacks_role`, `core.account_age`, `core.member_age`, `core.is_booster`, `core.has_avatar`, `core.is_premium` |

`ModuleManifest` gains `providers?: Provider[]`; `ModuleRegistry.register()` forwards them, so a
bad provider fails the same boot a bad `defaultConfig` fails.

**The rule engine now shares one predicate implementation.** `ruleConditionSchema` gained
`{kind:'provider', providerId, config}`; `rules/migrate.ts` rewrites the four legacy member-scoped
kinds (`role-has`, `role-lacks`, `account-age`, `is-premium`) to `core.*` providers on read, with no
data migration (PLAN.md I5). `channel-in` and `content-pattern` stay in the engine — they judge the
event, not the member — and `rate-over-window` stays because it is a counter keyed by rule id.
Conditions now evaluate cheapest-first: facts → providers → rate window.

Provider packs: `leveling` (5 conditions, 3 multipliers), `cases` (2 conditions), `giveaways`
(2 conditions, 4 multipliers).

**`member_activity_daily`** (migration `0015`) is the table that makes the 30d default possible at
all — `members.message_count` and `members.voice_seconds` are lifetime running totals and always
were. The rollup is written by the *same statement* that awards XP, so a crash cannot leave the two
disagreeing by more than the row that failed.

### B — the giveaways module (`packages/modules/giveaways/`)

A rewrite of the Phase-4 module, not a new one. Seven tables (migration `0016`, in-place ALTER with
backfill), Components V2 messages, weighted entries, seeded reproducible draws, claim windows,
blacklist, templates, and boot reconciliation.

---

## 2. Deviations from the spec

Everything below departs from `GIVEAWAYS.md` or `PLAN.md §10` and is deliberate.

**Verified against `docs.discord.com` during implementation:**

1. **There is no numeric modal component.** §2 and §6 assume "number inputs" in modals. Text Input
   has two styles (Short, Paragraph) and no numeric variant, and no Label child is numeric. Numbers
   are Short text inputs parsed on submit.
2. **A modal holds 1–5 top-level components**, so a provider's `builder` is capped at five fields.
   `ProviderRegistry` rejects a sixth at boot rather than discovering it as a 400.
3. **`IS_COMPONENTS_V2` disables five fields, not four** — `content`, `embeds`, `sticker_ids`,
   `poll` *and* `shared_client_theme`. `sendPayloadSchema` now refuses a V2 payload carrying any of
   them, naming the field.
4. **A deferred response cannot create a V2 message, and a modal cannot follow a defer.** The public
   giveaway message is a fresh `send`; the ephemeral builder deliberately stays on legacy action
   rows.
5. **There is no documented per-route rate limit for message edits.** Discord's own guidance is not
   to hard-code limits. The "≤1 edit / 5s / message" budget is Proton's, and is described as such.

**Design deviations:**

6. **The durable schedule, not BullMQ.** §2 says "BullMQ delayed job plus a boot-time sweep". This
   repo schedules module work through `ModuleContext.schedule()` → `scheduled_actions` →
   `ScheduledActionSweeper`, which already survives downtime. Adding BullMQ would have been a second
   scheduler. A giveaway-specific `reconcile()` still ships for rows whose schedule was never
   written.
7. **`MemberContext` fields are nullable** (`member`, `roleIds`, `hasAvatar`), and `ConditionResult`
   gained `indeterminate`. A non-null `roleIds: []` reads as "holds no roles", which fails
   `has_role` closed and `lacks_role` **open** — it would enter somebody the host excluded on
   purpose. `partial: true` marks a context built from a dispatch, so a null boost date means "not
   carried" rather than "not boosting".
8. **`kind`, `cost` and `tier` added to the provider interface.** `kind` discriminates condition
   from multiplier; `cost: 'query'` without `batchEvaluate` is a boot error, which turns §7's batch
   requirement into a structural guarantee; `tier` carries the guild's entitlement so `is_premium`
   and `premium_bonus` do not each read it.
9. **The Discord-native conditions are `core.*`, not `giveaways.*`.** §4 namespaces `account_age`,
   `member_age`, `has_role`, `lacks_role`, `is_booster` and `has_avatar` under `giveaways`. They are
   registered by the registry itself instead, because §1's principle is one implementation: if
   `giveaways` owned them, switching that module off would take `account_age` away from automod.
   `giveaways.no_recent_wins` and `giveaways.entered_before` stay in the module — they read giveaway
   tables.
10. **`no_recent_wins` is guild-scoped only.** §4 offers `scope: 'guild' | 'template'`. A
    `ConditionProvider` receives a `MemberContext` and nothing else, so it cannot know which giveaway
    it is being evaluated for — a template scope would silently behave as a guild one. Left out
    rather than shipped wrong. Guild-wide at 7 days is the chosen default anyway.
11. **`leveling.level_tier` is one tier per entry, repeated under `mode: 'max'`.** §4 specifies
    `tiers: [{minLevel, amount}]`, an array of objects, which PLAN.md §9 puts outside the form
    generator by design. `max` already means "highest matching wins", which is what a tier ladder is.
12. **`leveling.messages_in_channels` is deferred.** It needs a `guild × member × channel × day`
    table — the only genuinely expensive one in the catalog — for no capability the other five
    activity conditions do not already give. Flagged rather than dropped.
13. **§7's fairness gate is split.** "A user with weight `w` wins at a frequency within tolerance of
    `w / Σw`" is exactly true only for one winner. A-ExpJ draws a weighted sample *without*
    replacement, so for k>1 the marginal is the successive-sampling distribution, not `k·w/Σw`. The
    gate now asserts `w/Σw` exactly for k=1 and the successive-sampling property for k>1 — both over
    100k trials. Asserting the naive formula would have forced either a wrong algorithm or a flaky
    gate.
14. **`giveaway_draw` is a new ledger-only `ActionKind`.** §5 requires every draw to write a `cases`
    row via `ActionExecutor`. Borrowing `warn` would have mislabelled the case type.
15. **`create_dm` is a new `ActionKind`, and a DM is two executor calls.** PHASE-4.md §G4 declined
    to model DMs because `toRestCall` maps one kind to one request. `create_dm` opens the channel
    and returns its id in `ActionResult.body`; the module then sends into it. Both calls still go
    through the executor and the REST proxy, so nothing about I1 or I2 bends. It is deliberately
    **not** `targetsMember`: a DM has no role hierarchy, and flagging it would refuse to message a
    winner who outranks the bot.

---

## 3. The five named risks, as built

**Draw algorithm.** `Reservoir` implements A-ExpJ (Efraimidis–Spirakis) with keys held as
`ln(u)/w` rather than `u^(1/w)`: the orderings are identical because `ln` is monotonic, but
`u^(1/w)` collapses to 1 for any large weight in float64, and every heavy entrant would tie. The
replacement draw uses `expm1`/`log1p` so `r` is uniform on `(T^w, 1)` at both ends. Weights are
never expanded — a member worth nine entries is one record with weight 9.

`sampleWeightedAsync` streams chunks, so peak memory is O(winners), not O(entrants).

**Seed and reproducibility.** 128 crypto-random bits, 32 hex chars, stored in
`giveaway_draws.seed`. `snapshot_hash` is SHA-256 over `userId:totalEntries` lines **in ascending
user-id order** — the draw consumes the RNG once per entrant, so the order is part of what the hash
attests to. `store.entrants()` orders by `user_id` and `canonicalOrder()` does the same for a
replay. This was not theoretical: the determinism test caught the mismatch when the two disagreed.

**`batchEvaluate` fan-out.** One `MemberContext` load per chunk shared by every provider; one
provider call per distinct `(providerId, config)` per chunk, never per entrant; keyset paging on
`user_id`. Proven: 10,000 entrants × 3 requirements = **3 provider calls**.

**Debounced counter.** The dirty flag is a Redis set and the flush right is a `SET NX PX` lease, so
the ≤1-edit-per-window budget holds across *all* workers, not one per process. A restart loses
nothing because the flag was never in the process. The flag is cleared *before* the edit so a join
landing during it leaves the giveaway dirty again. Proven: 5,000 joins over 60s ⇒ ≤12 edits.

**Exactly-once.** Four layers: `beginDraw` is a conditional `UPDATE … WHERE status='running'
RETURNING`; `UNIQUE (giveaway_id, draw_number)`; a derived ActionExecutor key; and
`stalledDraws()`, which distinguishes a crash that wrote a draw row (finish forward) from one that
did not (release and re-draw). Re-drawing one that already produced winners is the bug that
asymmetry exists to prevent.

**Boot reconciliation.** `reconcile()` runs at boot and on a slow schedule: overdue giveaways get
re-scheduled (never drawn inline, so the draw still goes through the one path holding the lock),
stalled draws are resolved per above, expired claims are forfeited and rerolled, and every running
giveaway is marked dirty so a count stale from an outage self-heals. Every branch is a conditional
update, so running it on every worker at once is safe.

---

## 4. Verification

Run on this host, 2026-08-21:

```
bun run typecheck   37/37 packages green
bun run lint        clean
bun test            3896 pass · 26 fail
```

**All 26 failures are `*.integration.test.ts` reporting "Could not find a working container runtime
strategy"** — the documented Windows/Docker limitation in `CLAUDE.md`. No named test fails. The
pre-change baseline was 3590 pass / 37 fail.

Migrations `0015` and `0016` **have been applied** to the Neon database `DATABASE_URL` points at,
and the Drizzle store was exercised against it directly: create with requirements and multipliers,
25 entries, keyset paging in ascending user-id order, two concurrent draws resolving to exactly one
draw row, `topEntrants` ordering, and template save/load/delete. That is not a substitute for the
Testcontainers suites — they spin up ephemeral Postgres and Redis and still cannot run here — but
the schema and the store are no longer unexercised.

**A skipped suite is not a passing suite.** Nothing here claims a phase gate. The integration
suites have still never executed on this host and must be run in WSL, in CI, or against
`DOCKER_HOST=tcp://localhost:2375` before any gate is claimed — including the two new migrations
(`0015`, `0016`), which no test on this host has applied.

To keep §7's gates from being dark behind that, the behavioural ones are backed by an in-memory
`GiveawayStore` that models the same concurrency semantics as the Drizzle one — a conditional
`beginDraw` and a duplicate-refusing `recordDraw`. Those **do** run here.

### §7 coverage

| §7 requirement | Where | Runs here |
|---|---|---|
| Draw fairness (100k trials) | `draw-fairness.test.ts` | yes |
| Determinism / reproduce from audit row | `draw-determinism.test.ts` | yes |
| Exactly-once under concurrent end | `draw-behaviour.test.ts` | yes |
| Weighted sampling without replacement | `draw-fairness.test.ts`, `draw-determinism.test.ts` | yes |
| Requirement logic (`any`/`all`) | `join.test.ts`, `core/test/providers/evaluate.test.ts` | yes |
| Stacking + `maxEntriesPerUser` | `core/test/providers/evaluate.test.ts`, `join.test.ts` | yes |
| Draw-time revalidation | `draw-behaviour.test.ts` | yes |
| Degraded provider | `draw-behaviour.test.ts` | yes |
| Rate limiting (5,000 joins ⇒ ≤12 edits) | `join.test.ts` | yes |
| Batch evaluation (10,000 entrants) | `draw-behaviour.test.ts` | yes |
| Failure messaging (every failed requirement) | `join.test.ts` | yes |

---

## 5. The in-Discord builder

`/giveaway create` opens an ephemeral builder (`src/builder/`), which is where the shared registry
stops being an abstraction and starts paying for itself: the requirement picker is
`registry.listAvailable(guildId)`, and picking one generates its modal from that provider's
`FieldDescriptor[]`. Nothing in the builder knows what a level or a role bonus is.

| File | What it is |
|---|---|
| `state.ts` | the draft, and where it lives (Redis, one per host per guild, 1h TTL) |
| `modal.ts` | `FieldDescriptor[]` → Label-wrapped modal, and the submitted values back to config |
| `screens.ts` | the builder message: two pickers, a remove list, and the button row |
| `handler.ts` | pure routing — no Discord calls, so all of it is testable |
| `interactions.ts` | the Discord half: modal vs update vs followup |

Four verified Discord constraints shape it, and each one is a comment where it bites:

- **A modal cannot follow a defer**, so opening one *is* the 3-second ack and nothing before it may
  touch the database.
- **A modal holds 1–5 components**, which is why `ProviderRegistry` rejects a wider `builder` at
  boot rather than at the moment a host opens the picker.
- **There is no numeric modal component**, so a number is a Short text input, and the range check
  Discord cannot do lives in `readDescriptorValues` and names the bound it broke.
- **A callback cannot create a Components V2 message**, so `Preview` — which must render the *real*
  public message — defers and sends the preview as a followup.

Two smaller consequences worth knowing: a provider with no settings (`core.is_booster`) is added on
selection rather than opening an empty modal Discord would reject, and a disabled picker still
carries one filler option for the same reason.

## 6. Not built

- **The dashboard giveaways tab.** `GET /guilds/:guildId/providers` exists and is tested; no UI
  reads it yet. Hosts configure requirements in Discord.
- **`recurrence`.** The column exists and is carried through templates; nothing schedules a repeat.
- **`leveling.messages_in_channels`** — deferred, see deviation 12.
- **Reaction entry** — deliberately out, per the owner's §8 answer.

---

# Part two — the Dasu-parity pass (2026-08-25)

A second pass against a 100-point brief asking for Dasu-level parity. Audited first: ten parallel
readers over the module and every system it consumes, then a gap matrix. Most of the brief's
architecture — the shared provider registry, weighted A-ExpJ draws, seeded reproducibility,
exactly-once ending, the debounced counter, claim windows, the blacklist, templates — was already
built by part one and is untouched here.

## 7. The bugs the audit found

These were live defects, not gaps. Each is fixed and each has a test that fails without the fix.

1. **The entire ops layer was dead code.** The manifest declared four schedules and only ever wrote
   one. `flush-counts`, `reconcile` and `claim-expiry` had handlers, were listed in `schedules`,
   and were **never passed to `ctx.schedule`** by anything. In production that meant live entry
   counts never updated, a giveaway whose worker died mid-draw stayed in `drawing` forever, and no
   claim window ever expired. Fixed with `armPatrols()` plus a `guild.available` /
   `proton.config_changed` listener, each handler re-arming itself in a `finally`.

2. **`finishDraw` had no status predicate.** `update … where guild_id = ? and id = ?` and nothing
   else. Combined with (3) this falsified the exactly-once guarantee `beginDraw` exists to provide.
   It now takes a `from: GiveawayStatus[]` guard.

3. **`rerollGiveaway` rejected only `'running'`.** A **cancelled** giveaway could be rerolled back
   to life and award a prize the host had deliberately withdrawn; a giveaway in `drawing` could be
   yanked back to `running` beside the draw already in flight, so two draws both wrote winners.
   Reroll now accepts only `'ended'`, and the previously-unreachable `'cancelled'` outcome is
   constructed.

4. **`cancelGiveaway` was read-then-write.** It lost to an in-flight draw and told the host "nobody
   was drawn" while the draw it lost to announced winners. Now a conditional update.

5. **`rerolled_at` was never written**, so the reroll exclusion's `.filter(win => win.rerolledAt === null)`
   was a tautology. It is written now — and the exclusion no longer depends on it, because a
   superseded winner must stay excluded, not become eligible again.

6. **`claim()` ignored `claim_deadline`.** A winner could claim past their window until the expiry
   sweep ran — and the sweep never ran, per (1).

7. **The claim sweep bucketed by giveaway, not by draw.** A giveaway whose second draw also went
   unclaimed had those winners forfeited against the first draw's id, matching nothing. The prize
   was silently lost.

8. **Four sweep queries had no `guild_id` predicate** but ran from a per-guild `ModuleContext`:
   `overdue`, `running`, `stalledDraws`, `expiredClaims`. Guild A's tick could draw guild B's
   giveaway using guild A's channel, config and ledger. The dirty-count set was one global Redis
   key. All five are now guild-scoped.

9. **`enter()` had no status guard.** A press landing between the caller's read and the insert
   entered a giveaway that had since been paused, cancelled or drawn. The insert now carries
   `where exists (… status = 'running')`, and `join()` reports the new `'closed'` outcome rather
   than telling the member they are in a draw they are not in.

10. **The autocomplete title filter did not escape LIKE metacharacters.** Typing `%` matched every
    giveaway in the guild.

11. **A cancelled giveaway was never repainted** — `endedMessage`'s `cancelled` branch had zero
    callers, so a cancelled giveaway kept a live Enter button forever. **A reroll never repainted
    either**, so the original winners stood on the message while a different set was announced
    below it.

12. **`draw-fairness.test.ts` had a latent flake** — 100k draws sat on Bun's 5s default, passing
    alone and timing out under a full-suite run. Given an explicit budget.

## 8. What was added

| Area | What |
|---|---|
| Lifecycle | `paused` status with `paused_at`/`paused_by`/`pause_reason`/`paused_ms`; resume pushes `ends_at` by exactly the time held. Scheduled start (`START_JOB_ID` + `activate()`), which existed as a dead status and column. `patch()` for edit/extend/shorten, all rescheduling the draw with `replace: true` |
| Commands | `/giveaway pause · resume · extend · shorten · edit · info` |
| Presentation | `src/embed.ts` — a state-aware builder with `buildScheduled/buildActive/buildPaused/buildDrawing/buildEnded/buildCancelled/buildNoWinners/buildRerolled`. `message.ts` is now primitives only |
| Entry | Leave button (soft `left_at`, never a DELETE, so entry history stays honest); Requirements and Multipliers buttons answering per-presser with a tick or cross per rule |
| Access | `managerRoleIds`, `bypassRoleIds`, `blacklistRoleIds` in module config. Bypass is decided once in the authorization layer, not threaded through every provider — and multipliers still apply, because skipping the rules is not forfeiting earned entries |
| Identity | Short public codes (`G-7X29`) on a confusable-free alphabet, resolved by `store.resolve()` and shown in autocomplete. ULIDs stay the primary key — every custom id and idempotency key roots on them |
| Indexes | Migration `0021` — `giveaways_guild_running_idx` was predicated on `ended_at` and unusable by any query that filters `status`, so nothing indexed `guild_id`. `priorEntryCounts` and `recentWinCounts` filter `user_id` and seq-scanned the whole cross-guild table on a button press |

## 9. Deviations, part two

13. **`max` stacking was left alone.** The brief calls the semantic ambiguous and asks for it to be
    made explicit. `GIVEAWAYS.md` §4 already specifies it — "`max` mode takes the single highest
    instead of stacking within its group" — and the code matches: the max group collapses to its
    largest member, which then contributes once alongside the add sum. The defect was that this was
    undocumented and untested, not that it was wrong. It is now stated as a formula at the site and
    pinned by `packages/core/test/providers/multiplier-stacking.test.ts`, including a fast-check
    property that reordering specs cannot change the total — otherwise a giveaway's odds would
    depend on the order somebody clicked through a builder.

14. **Invite requirements refused.** The brief asks for invite counts, and for a tracking service if
    none exists. There is no invites table, no `inviter_id` anywhere, and `GuildInvites` is not in
    `DEFAULT_INTENTS` — so `INVITE_CREATE` is not even delivered, and serverlog's invite catalogue
    entries are already dead code. Discord provides no field linking a join to an invite;
    attribution means snapshot-diffing `uses`, which is racy under concurrent joins and wrong for
    vanity URLs and exhausted invites. It also needs `MANAGE_GUILD` + `MANAGE_CHANNELS`. That is its
    own module, not a giveaway provider, and shipping a number hosts would read as fact is worse
    than not shipping it.

15. **`status` gained a CHECK constraint** (`0022`). It was plain text with no constraint and a
    blind cast on read.

## 10. Verification, part two

Run on this host, 2026-08-25:

```
bunx turbo run typecheck --force    37/37 packages green (cache bypassed)
bun test                            5179 pass · 29 fail
biome check <every file touched>    clean
```

**All 29 failures are `*.integration.test.ts`** — every one reports "Could not find a working
container runtime strategy", the documented Windows/Docker limitation. No named test fails. The
pre-change baseline on this host was 5140 pass / 29 fail.

`bun run lint` is red on one file: `apps/api/test/invite.test.ts`, an **untracked** file belonging
to the in-progress tickets work. It is an import-ordering complaint, it is not mine, and it was
left alone rather than editing somebody else's work in flight.

**Migrations `0021` and `0022` have NOT been applied anywhere.** They are written and mirrored in
`table.ts` by eye, and no test on this host has run them. **A skipped suite is not a passing
suite** — they must be applied and the integration suites run in WSL, in CI, or against
`DOCKER_HOST=tcp://localhost:2375` before any gate is claimed.

## 11. Still not built (superseded by §15)

Ordered by value. Nothing below is blocked by anything above.

- **Bonus entries** (`/giveaway bonus`) — needs a `giveaway_bonus_entries` table, and `reweigh()`
  must stop clobbering `total_entries` wholesale or a manual grant is erased at the draw. Note
  `reweigh` also recomputes from `base = 1` rather than the stored `base_entries`.
- **Nested requirement trees** (ALL/ANY/NONE with groups). Storage decision still open — jsonb on
  `giveaways` matches how templates already store the identical structure; adjacency keeps per-node
  ids for the builder's edit routes. Whichever wins, the evaluator must flatten to distinct leaves
  and batch-evaluate once per leaf per chunk, or a 10k draw becomes 30k queries.
- **The multi-step builder.** Today it is one screen at its 5-button/4-row ceiling.
  `descriptorsToModal`'s `current` parameter already implements full prefill and is never passed,
  so per-item edit is nearly free. `colour` fields are broken end-to-end and will bite the moment
  an appearance step exists.
- **Serverlog integration.** Zero giveaway entries in the catalogue; the manifest has no `emits`
  key at all. A draw currently logs as a generic `proton.action_executed` with no winners or prize.
- **`giveaway_events`** history table, entrant pagination, CSV export, `/giveaway stats`.
- **Drop giveaways** — first eligible clicker wins, via a conditional insert as the race winner.
  Must not go through `beginDraw`/`recordDraw`, which assume a deferred sample.
- **Message/channel deletion handling.** `message_id` is never cleared, so a deleted message means
  a PATCH that 404s and retries forever. `store.byMessage` exists with zero callers.
- **Provider catalogue expansion.** `user.bot` and `communicationDisabledUntil` are already carried
  on `MemberContext` and read by nobody; name matching and server tag need it widened.
- **Multiple prizes, role rewards, recurrence.** `recurrence` is still a column nothing branches on.
  A role reward needs `add_role` added to the manifest's `actionKinds` or the executor throws.

---

# Part three — bonus entries, cleanup, providers, logging, reports (2026-08-25)

Continues part two. Same rules: each package leaves the repo green on its own.

## 12. One more bug, found while building

**The draw would have included members who left the giveaway.** Adding `left_at` in part two
updated the memory store's live-entrant filters but not the Drizzle one, whose `entrants()` keyset
walk — the query the draw itself reads — still filtered only `disqualified_at`. The leave tests
passed against the fake and would have failed against Postgres: exactly the divergence
`GIVEAWAYS-BUILD.md` §4 warns the in-memory store can hide. `entrantCount`, `entrantCounts`,
`entrants` and `topEntrants` all now carry `AND left_at IS NULL`, matching the partial index.

## 13. What was added

### Bonus entries (migration `0023`)

`giveaway_bonus_entries` with a persisted amount, reason, granter and revocation stamp;
`/giveaway bonus add|remove|list`. Deliberately **no composite FK** to `giveaway_entries`:
`(giveaway_id, user_id)` is that table's primary key, so an FK would forbid pre-granting a bonus to
somebody who has not entered yet — which is exactly what a host does when rewarding event
participation before a giveaway opens. A pre-grant lands when the member joins.

`total_entries` stays the authoritative cache the draw reads. Grants and revocations move it in the
same transaction that writes the grant, and **`reweigh` now writes `computed + live bonus sum`**
rather than the computed figure alone — the previous version overwrote it wholesale, erasing a
manual grant at the one moment it has to count. `reweigh` also became a single
`UPDATE … FROM (VALUES …)`; it was one round trip per entrant inside an open transaction, so a
500-row chunk was 500 sequential statements.

### Message and channel deletion (§92, §93)

`src/cleanup.ts` listens on `message.deleted`, `message.bulk_deleted` and `channel.deleted`, and
clears `message_id`. Without it a deleted message left every later edit — the debounced count, the
ended card, a reroll repaint — 404ing forever, with `report()` swallowing each failure as a warn so
nothing ever stopped trying. The giveaway itself is kept: the entries are real and the draw can
still run.

### Provider catalogue (§18, §19)

`MemberContext` widened with `user.username`, `user.globalName` and `member.nickname` — null means
"not carried", never "empty". Four new `core.*` conditions: `not_bot`, `not_timed_out`,
`role_count`, `name_matches`. `user.bot` and `communicationDisabledUntil` were already carried and
read by nobody. **27 providers now ship** (11 core, 8 leveling, 2 cases, 6 giveaways).

`core.name_matches` supports contains / starts-with / ends-with / equals against username, display
name or nickname, case-insensitively. **No regex**, per part two's §C6 reasoning: a host-authored
pattern run against every entrant at draw time is a ReDoS vector inside the draw, and a test asserts
that metacharacters match literally rather than compiling.

### Serverlog integration (§64)

The manifest had **no `emits` key at all**, and a draw logged only as a generic
`proton.action_executed` with no winners, prize or seed. Now nine event types
(`giveaways.created|started|edited|paused|resumed|cancelled|ended|rerolled|bonus_granted`), Zod
payloads in `packages/core/src/events/giveaways.ts`, a `render/giveaways.ts` in serverlog, and nine
`proton.giveaway_*` catalogue specs.

Publishing is best-effort and never blocks what it reports — a serverlog outage must not stop a
giveaway being drawn, and `giveaway_draws` holds the audit row regardless. Draw logs carry the seed
and snapshot hash, so a disputed result is reproducible from the log alone. Skipped (degraded)
providers are named, never silent.

### Reports (§62, §63, §89)

`/giveaway entrants` (paged), `/giveaway export` (CSV as an ephemeral attachment) and
`/giveaway stats`. The export is bounded at `EXPORT_ROW_MAX` and **says so when the cap bites** — a
silently truncated export reads as a complete one. Paging walks the same keyset iterator the draw
uses, so what a host is shown and what is drawn cannot disagree.

## 14. Verification, part three

```
bunx turbo run typecheck --force    37/37 packages green (cache bypassed)
bun test                            5307 pass · 29 fail
biome check <every file touched>    clean
```

All 29 failures are `*.integration.test.ts` — zero non-integration failures, confirmed by
attribution rather than by eye. The giveaways module is at **291 tests**, up from 125 before this
work started.

**Migrations `0021`, `0022` and `0023` have still NOT been applied anywhere**, and no test on this
host has run them. They must be applied and the integration suites run in WSL, in CI, or against
`DOCKER_HOST=tcp://localhost:2375` before any gate is claimed.

## 15. Still not built (superseded by §19)

- **Nested requirement trees** (ALL/ANY/NONE with groups). Storage decision still open.
- **The multi-step builder.** Still one screen at its 5-button/4-row ceiling.
  `descriptorsToModal`'s `current` parameter implements prefill and is still never passed; `colour`
  fields are still broken end-to-end.
- **`giveaway_events`** — the per-giveaway history table. The bus events above cover the log; this
  would cover the queryable timeline.
- **Drop giveaways** — first eligible clicker wins, via a conditional insert as the race winner.
- **Multiple prizes, role rewards, recurrence.** `recurrence` is still a column nothing branches on.
  A role reward needs `add_role` added to the manifest's `actionKinds` or the executor throws.
- **The dashboard giveaways surface.** Read-only browse remains the recommendation.

---

# Part four — history, drops, prizes, rule trees, the stepped builder (2026-08-25)

Completes the brief. Same rules as before: each package leaves the repo green on its own.

## 16. Two more bugs, found while building

1. **Two edits in the same millisecond collapsed into one history line.** The idempotency key for
   an edit was `…:edited:<updatedAt>`, and `updatedAt` is `new Date()` in both stores. Extending
   and then shortening a giveaway inside one millisecond recorded once. The key now carries the
   changed fields and the resulting `ends_at`, so a genuine redelivery still dedupes and two
   different edits do not.

2. **A degraded provider would have failed the tree closed.** The first cut of the tree fold
   treated "provider unavailable" and "provider ran but could not answer" as the same state, so a
   giveaway whose `leveling` module was switched off disqualified *every* entrant.
   `GIVEAWAYS.md` §2 is explicit that an unavailable provider is skipped and the draw marked
   degraded. The fold is now four-valued — `pass` / `fail` / `unknown` / `skip` — and an existing
   test caught the regression before it landed.

## 17. What was added

### Per-giveaway history (migration `0024`, §38, §65)

`giveaway_events` — a timeline of every transition, with the actor, a jsonb detail blob and a
partial unique index on `idempotency_key`. **Deliberately no foreign key**: every other giveaway
table cascades from `giveaways` which cascades from `guilds`, and an audit trail that deletes
itself when the thing it audits goes away is not an audit trail. `/giveaway history` reads it.

One call per transition writes both halves — the durable timeline and the serverlog bus event —
sharing an idempotency key, so a redelivered transition is a no-op in both. Draw lines carry the
seed and snapshot hash, so a disputed result is reproducible from the timeline alone.

### Drop giveaways (§85)

`entry_method = 'drop'`, `/giveaway drop`, and its own card with no countdown and no entry count —
a drop has no deadline anybody watches and nobody is entered. **The conditional `running → ended`
update *is* the race**: two hundred simultaneous presses land on it and Postgres lets exactly one
row match, and that caller is the winner. Deliberately not routed through `beginDraw`/`recordDraw`,
which assume a deferred sample. A test asserts one winner from 200 concurrent presses.

### Nested rule trees (migration `0025`, §20)

`requirement_tree` jsonb on `giveaways`, backfilled from the flat rows. ALL / ANY / NONE with
groups nested up to four deep, bounded by the Zod schema itself rather than checked afterwards — a
hand-edited blob nesting a thousand groups is refused by the parse, not walked.

`evaluateTree` **flattens to distinct leaves, batch-evaluates each once per chunk, then folds the
tree per member**. The two halves are separate on purpose: folding is pure and cheap, evaluation is
the expensive part, and doing them together means walking the tree per entrant and querying inside
the walk. Proven: 10,000 entrants through a three-leaf tree is three provider calls, and two
branches asking the same question are one evaluation.

There is one evaluation path either way — a giveaway written before nested rules existed is read
as a one-level tree rather than taking a different branch. An unparseable stored tree falls back to
the flat rows rather than throwing inside a button press.

### Prizes, role rewards, recurrence (migration `0026`, §53, §54, §87)

An ordered `prizes` list where winner *i* takes prize *i*, with the winner count winning over a
short list rather than handing somebody `undefined`. `reward_role_id` granted through the executor,
which hierarchy-checks `add_role` — and a refusal reaches the host in the log channel, because a
reward that silently never lands is worse than no reward.

Recurrence is an interval plus a **required** bound (runs or an end date): `ScheduledJob` cron is
guild-agnostic in this repo, so a recurring giveaway chains through the per-guild `ctx.schedule`
row mechanism instead, and each run schedules only its successor with a decremented counter. §87
warns against an endless recursive scheduler; the chain stops on its own rather than relying on
anything remembering to stop it. An unbounded recurrence is refused by the schema.

### The stepped builder (§6, §79–82)

Six steps — prize & timing, requirements, bonus entries, appearance, winner settings, review —
routed by a navigation select that every screen carries. The old builder was one screen at its
5-button/4-row ceiling; the step router keeps every screen inside Discord's five action rows, which
is exactly why it is stepped: everything a giveaway can be configured with does not fit in one
modal.

- **Categorised pickers** (§79) grouped by the owning module, so a pack added later appears rather
  than vanishing from a hand-kept list.
- **Per-item edit** (§80) finally passes `descriptorsToModal`'s `current` argument, which has
  always existed and was never used — editing a rule meant deleting it and rebuilding it.
- **Conflict detection** (§82): requiring and excluding the same role under ALL is *blocking* and
  stops publishing; the same pair under ANY is merely redundant, because either branch carries the
  entry on its own. A builder that cries wolf gets clicked through, so the non-blocking cases warn
  and let the host proceed.
- **Multiplier modes** are now selectable. `handler.ts` hardcoded `'add'` with a comment pointing at
  a dashboard that does not exist.
- **`REQUIREMENTS_MAX` / `MULTIPLIERS_MAX` are enforced in the builder**, not only in the template
  schema — a host could previously add past the cap and discover it when saving a template.
- Appearance, scheduled start, winner settings and reward role are all reachable, and all were
  columns nothing wrote.

**`colour` fields were broken end-to-end** and are fixed: `readDescriptorValues` stored the typed
string into a `z.number()`, which sailed past the modal and failed at `parseConfig`. It now parses
hex or decimal to a number and renders back as hex. A `#` prefix forces hex — without that,
`#12345` fell through to the decimal branch and became the colour 12345, from an input that was
plainly a mistyped hex code.

## 18. Verification, part four

```
bunx turbo run typecheck --force    37/37 packages green (cache bypassed)
bun test                            5457 pass · 29 fail
biome check <every file touched>    clean
```

Zero non-integration failures, confirmed by attributing every failure to its file rather than by
eye. All 29 are `*.integration.test.ts` reporting the documented Windows/Docker limitation. The
giveaways module is at **417 tests**, up from 125 before this work began.

`apps/dashboard` was being edited concurrently during this work and transiently failed typecheck on
its own half-written files. No dashboard file was touched by this change.

**Migrations `0021`–`0026` have NOT been applied anywhere.** They are written and mirrored in
`table.ts` by eye, and no test on this host has run them. **A skipped suite is not a passing
suite** — apply them and run the integration suites in WSL, in CI, or against
`DOCKER_HOST=tcp://localhost:2375` before claiming a gate.

## 19. Still not built

- **The dashboard giveaways surface.** Read-only browse remains the recommendation; write-side
  authoring needs a bus-handoff pattern that does not exist anywhere in the API yet (part two §C8).
- **`giveaway_requirements` / `giveaway_multipliers` retirement.** The tree supersedes them and
  they are still written for backward compatibility. Retire once nothing reads the flat path.
- **Invite requirements** — refused, see part two §14. Unchanged.
- **Badge and banner requirements** — refused, see part two §C1/§C2. Unchanged.
