# Module Spec — `giveaways`

Status: Phase 4. **Hard dependency on Phase 3** (`leveling`) for activity providers.
Parent spec: `docs/PLAN.md`. All invariants in PLAN.md §3 apply. Where this file and PLAN.md conflict, PLAN.md wins.
Reference product: Dasu giveaway bot (feature reference only — no copied code, copy, or embed layout).

---

## 1. The architectural decision that shapes this module

Naive version: giveaways owns its own requirement checker with a `switch` over requirement types, and reaches into the leveling module's tables to read XP. **That violates PLAN.md I3** (modules never import each other) and produces a second predicate system parallel to the rule engine (PLAN.md §4-P2).

**Locked design instead:**

> Giveaway requirements are **member-scoped conditions from the shared condition registry**. Any module can register condition providers. `giveaways` never imports `leveling`, `cases`, or `security` — it consumes whatever providers are registered.

Consequences:
- The rule engine (P2) and giveaways share one predicate implementation. Adding `leveling.level` as a condition gives it to automod, autorole, level rewards, *and* giveaway requirements simultaneously.
- `ModuleManifest` gains `providers?: Provider[]`. Leveling ships `level`, `xp`, `messages`, `voice_minutes`. Cases ships `no_active_case`, `no_warns_in`. Security ships `passed_verification`, `not_flagged_alt`. Giveaways itself ships `no_recent_wins`.
- Multipliers are giveaway-specific (they return a number, not a boolean) so `MultiplierProvider` is a separate interface, but it shares the same registry, config-schema, and rendering pipeline.

This is the single most important thing to get right in this module. Build the registry first; the giveaway is the second thing built.

---

## 2. Locked decisions

| Area | Decision |
|---|---|
| Entry model | **Weighted entries.** Base 1 entry; multipliers add/multiply. Draw is weighted sampling without replacement. |
| Draw algorithm | Seeded PRNG (`xoshiro128**`) + A-ExpJ weighted reservoir sampling. **Never** expand entries into an array. |
| Auditability | Every draw stores its seed + a hash of the entry snapshot, so any draw is reproducible and verifiable |
| Entry methods | Button (default) and Reaction (legacy; requires `GuildMessageReactions`, degrade per PLAN.md §7 if absent) |
| Requirement logic | `any` (≥1) or `all`, per giveaway — matches Dasu's `requirement_type` |
| Re-verification | `verify_on: 'join' \| 'draw' \| 'both'`, default `both` |
| Live entry count | Debounced batched message edit, max 1 edit / 5s / message. Never edit per join. |
| Message format | Components V2 (`IS_COMPONENTS_V2`). Note `embeds`/`content`/`poll` are disabled under that flag — build the whole message from components |
| Builder UX | Ephemeral component builder (Dasu-style) **and** dashboard. Use 2026 modal components (Label-wrapped role/channel selects + number inputs in one modal) to collapse Dasu's multi-step flow |
| Draw exactly-once | DB state machine + `UNIQUE (giveaway_id, draw_number)`. Idempotency key per PLAN.md I4 |
| Scheduling | BullMQ delayed job **plus** a boot-time reconciliation sweep for missed/late jobs |
| Provider unavailable at draw | Skip the requirement, mark the draw `degraded`, record which providers were missing in the draw audit row, notify the host in the log channel. **Do not** silently fail-open or block the draw |
| Blacklist | Per-guild user and role blacklist, evaluated before requirements |

---

## 3. Provider interfaces (`packages/core`)

```ts
/** Everything a provider needs to judge one member. Loaded once, reused across all providers. */
interface MemberContext {
  guildId: string;
  userId: string;
  member: {
    joinedAt: Date | null;
    roleIds: string[];
    premiumSince: Date | null;      // server booster
    communicationDisabledUntil: Date | null;
  };
  user: { createdAt: Date; hasAvatar: boolean; bot: boolean };
  now: Date;
}

interface ConditionResult {
  passed: boolean;
  /** For progress messaging: "47 / 100 messages". Optional. */
  progress?: { current: number; required: number; unit: string };
}

interface ConditionProvider<C extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;                       // 'leveling.level' — namespaced by owning module
  moduleId: string;
  label: string;                    // "Level"           → select-menu title
  description: string;              // "Must be at least a certain level" → select-menu description
  emoji?: string;
  configSchema: C;
  /** Rendered in the in-Discord builder and auto-generated in the dashboard (PLAN.md §9 field types). */
  builder: FieldDescriptor[];

  evaluate(ctx: MemberContext, config: z.infer<C>): Promise<ConditionResult>;
  /** REQUIRED where evaluate hits the DB. Draw-time revalidation of 10k entrants must not be 10k queries. */
  batchEvaluate?(ctxs: MemberContext[], config: z.infer<C>): Promise<Map<string, ConditionResult>>;

  /** Public embed line: "Be level 5 or higher." */
  describe(config: z.infer<C>, locale: string): string;
  /** Private failure line: "You are level 3 — you need level 5." */
  describeFailure(config: z.infer<C>, result: ConditionResult, locale: string): string;
}

interface MultiplierProvider<C extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;                       // 'leveling.level_tier'
  moduleId: string;
  label: string; description: string; emoji?: string;
  configSchema: C;
  builder: FieldDescriptor[];

  /** Returns the entry contribution for this multiplier, or 0 if it doesn't apply. */
  evaluate(ctx: MemberContext, config: z.infer<C>): Promise<number>;
  batchEvaluate?(ctxs: MemberContext[], config: z.infer<C>): Promise<Map<string, number>>;
  describe(config: z.infer<C>, locale: string): string;   // "Users with @Nivel 5 get +5 entries."
}
```

`ModuleManifest` gains:
```ts
providers?: (ConditionProvider | MultiplierProvider)[];
```

Registry lives in `packages/core/src/providers/`. It must reject duplicate ids at boot and expose `listAvailable(guildId)` — a provider whose owning module is disabled for that guild is **not** available.

---

## 4. Provider catalog

Namespaced `moduleId.providerId`. Ship the Dasu five plus the activity set; the rest are marked as later.

### Conditions — `giveaways` (Discord-native, no cross-module dependency)
| id | Config | Notes |
|---|---|---|
| `giveaways.account_age` | `days` | Dasu "Account Older" |
| `giveaways.member_age` | `days` | Dasu "Member Older" |
| `giveaways.has_role` | `roleIds[]`, `mode: any\|all` | Dasu "Role", extended to multiple |
| `giveaways.lacks_role` | `roleIds[]` | Dasu "Not Role" |
| `giveaways.is_booster` | — | |
| `giveaways.has_avatar` | — | cheap alt heuristic |
| `giveaways.no_recent_wins` | `days`, `scope: guild\|template` | **self-referential — high value.** Stops the same five people winning everything |
| `giveaways.entered_before` | `count`, `days` | loyalty-style |

### Conditions — `leveling` (Phase 3 — the activity set)
| id | Config | Notes |
|---|---|---|
| `leveling.level` | `min` | |
| `leveling.xp` | `min` | |
| `leveling.messages` | `min`, `window: lifetime\|7d\|30d` | Dasu "Messages" is lifetime-only. **Windowed is the anti-farm version — default to `30d`** |
| `leveling.messages_in_channels` | `min`, `channelIds[]`, `window` | |
| `leveling.voice_minutes` | `min`, `window` | |
| `leveling.rank_top` | `n` | top-N on the leaderboard |

### Conditions — `cases` / `security`
| id | Config |
|---|---|
| `cases.no_active_case` | `types[]` (e.g. mute, warn) |
| `cases.no_cases_in` | `days`, `types[]` |
| `security.passed_verification` | — |
| `security.not_flagged_alt` | — |

### Multipliers
| id | Config | Notes |
|---|---|---|
| `giveaways.role_bonus` | `roleIds[]`, `amount`, `mode` | Dasu's model (image 4) |
| `giveaways.booster_bonus` | `amount` | |
| `giveaways.premium_bonus` | `tier`, `amount` | Proton entitlement tiers |
| `giveaways.loss_streak` | `perLoss`, `cap` | pity bonus for repeat non-winners — strong retention feature |
| `leveling.level_tier` | `tiers: [{minLevel, amount}]`, `mode` | |
| `leveling.per_messages` | `per`, `amount`, `cap`, `window` | e.g. +1 entry per 100 messages in 30d, cap +10 |
| `leveling.per_voice_minutes` | `per`, `amount`, `cap`, `window` | |

**Stacking:** each multiplier has `mode: 'add' | 'multiply' | 'max'`. Evaluation order: all `add` summed onto base → all `multiply` applied → `max` mode takes the single highest instead of stacking within its group. Global `maxEntriesPerUser` cap applied last. Store the full breakdown per entrant (§5) so the UI can show "1 base +5 role +3 level = 9 entries".

---

## 5. Data model

```sql
giveaways (
  id, guild_id, channel_id, message_id, host_id,
  title, description, banner_url, color, emoji, button_color,
  entry_method,            -- 'button' | 'reaction'
  winner_count,
  requirement_logic,       -- 'any' | 'all'
  max_entries_per_user,
  verify_on,               -- 'join' | 'draw' | 'both'
  starts_at, ends_at,
  status,                  -- 'scheduled'|'running'|'drawing'|'ended'|'cancelled'|'degraded'
  claim_window_seconds,    -- null = no claim required
  dm_winners, win_message,
  template_id, recurrence, -- null | cron expression
  created_at, updated_at
)

giveaway_requirements (id, giveaway_id, provider_id, config JSONB, position)
giveaway_multipliers  (id, giveaway_id, provider_id, config JSONB, mode, position)

giveaway_entries (
  giveaway_id, user_id,
  base_entries, total_entries,
  breakdown JSONB,          -- [{providerId, label, amount, mode}]
  joined_at, revalidated_at,
  disqualified_at, disqualify_reason,
  PRIMARY KEY (giveaway_id, user_id)
)
  INDEX (giveaway_id) WHERE disqualified_at IS NULL

giveaway_draws (
  id, giveaway_id, draw_number, seed, snapshot_hash,
  entrant_count, total_entries, winner_ids TEXT[],
  degraded_providers TEXT[], drawn_at, drawn_by, reason,
  UNIQUE (giveaway_id, draw_number)
)

giveaway_wins (giveaway_id, draw_id, user_id, claimed_at, forfeited_at, rerolled_at)
giveaway_templates (id, guild_id, name, payload JSONB, created_by)
giveaway_blacklist (guild_id, subject_type, subject_id, added_by, reason)
```

Every draw and reroll also writes a `cases` row via `ActionExecutor` (PLAN.md I1) — giveaways are state changes and belong in the ledger like everything else.

---

## 6. Behaviour specifications

### Join flow (button click)
1. Defer ephemeral immediately (PLAN.md I9).
2. Redis token bucket per `(userId, giveawayId)` — reject button spam before any DB work.
3. Blacklist check → requirements evaluated with the configured logic.
4. **On failure:** ephemeral listing *every* failed requirement with progress, via `describeFailure` — "You need level 5 (you're level 3)" and "You've sent 47 of 100 messages in the last 30 days". Never a bare "you don't qualify".
5. **On pass:** compute multipliers, write the entry with its full breakdown, ephemeral confirmation showing the breakdown.
6. Mark the message dirty for the debounced count updater.

### Live count updater
One worker job per active giveaway message holds a dirty flag. Flush at most every 5s, only if dirty. All edits go through the REST proxy (PLAN.md I2). A giveaway with 5,000 joins in a minute produces ≤12 edits.

### Draw
1. Transition `running → drawing` with a row lock; a second attempt sees `drawing` and aborts (exactly-once).
2. If `verify_on` includes `draw`: load all entrants, build `MemberContext` batch, call `batchEvaluate` per distinct requirement. Entrants who left the guild or now fail are marked disqualified with a reason.
3. Recompute multipliers (roles change).
4. Snapshot surviving entries, hash it, generate a crypto seed, run A-ExpJ weighted sampling for `winner_count`.
5. Write `giveaway_draws` + `giveaway_wins`, announce, DM winners if configured.
6. If `claim_window_seconds` set: winners must click **Claim**; unclaimed winners are forfeited and auto-rerolled once the window expires.

### Reroll
`/giveaway reroll <id> [count] [reason]` → new `draw_number`, excludes prior winners unless `--allow-repeat`, same audit trail.

### Commands
```
/giveaway create              → opens the ephemeral builder
/giveaway quick <title> <length> <winners> [channel]
/giveaway end <id>            /giveaway cancel <id>
/giveaway reroll <id> [count] /giveaway list
/giveaway entries <id> [user] → breakdown for a user, or top entrants
/giveaway template save|load|list|delete
/giveaway blacklist add|remove|list
```

### Builder
Ephemeral, Dasu-shaped (image 2): Basic Settings / Requirements / Multipliers summary, with `Add Requirement`, `Add Multiplier`, `Remove Item`, `Preview`, `Start`. Requirement picker is a string select populated from `registry.listAvailable(guildId)` (image 3). Selecting one opens a **modal generated from that provider's `builder` descriptors** — 2026 modals support Label-wrapped role/channel selects alongside text inputs, so one modal replaces Dasu's multi-step round trips. `Preview` renders the exact public message.

### Public message (image 4 as reference, original layout)
Components V2 container: title, description, `<t:ts:R>` end time, requirements section rendered from `describe()` with an `any`/`all` note, multipliers section, winner count + host, then `Join Giveaway` button and a disabled count button. Optional banner via Media Gallery.

---

## 7. Test requirements (gate for this module)

- **Draw fairness:** fast-check property test — over 100k simulated draws, a user with weight `w` wins at a frequency within tolerance of `w / Σw`. Non-negotiable; a biased draw is the worst possible bug here.
- **Determinism:** same seed + same snapshot ⇒ identical winners. Reproduce a stored draw from its audit row.
- **Exactly-once:** two concurrent `end` calls produce exactly one `giveaway_draws` row.
- **Weighted sampling without replacement:** N winners are always distinct.
- **Requirement logic:** `any`/`all` truth tables per provider set.
- **Stacking:** add/multiply/max combinations, and `maxEntriesPerUser` clamping.
- **Draw-time revalidation:** entrant who left / lost the role / got muted is disqualified with the correct reason.
- **Degraded provider:** disable `leveling` mid-giveaway → draw completes, `degraded_providers` populated, host notified.
- **Rate limiting:** 5,000 simulated joins in 60s ⇒ ≤ 12 message edits.
- **Batch evaluation:** revalidating 10,000 entrants issues O(distinct requirements) queries, not O(entrants).
- **Failure messaging:** a failing join returns every failed requirement with progress values.

---

## 8. `[ASK]` before implementing

1. Reaction entry method in v1, or button-only? (Recommend button-only; reaction costs a privileged-adjacent intent for a legacy UX.)
2. Default `messages` window — lifetime (Dasu parity) or 30d (anti-farm)? Recommend 30d default, lifetime available.
3. Claim window: on by default, and at what duration? Recommend off by default, 24h when enabled.
4. Should `no_recent_wins` be guild-wide by default? Recommend yes, 7 days.
5. Which multipliers are premium-gated, if any?
6. Max entrants per giveaway before Proton refuses to draw synchronously (recommend: none — batch it properly instead).
