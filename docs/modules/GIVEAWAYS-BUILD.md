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
