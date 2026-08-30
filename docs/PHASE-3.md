# Phase 3 — Engagement (plan)

> **Implementation status — 2026-08-17.** Slices 3.A–3.G are built, the ten unfinished surfaces in
> §7 are closed, and the `automod` module has landed on top (see §8). The repo is green on
> `bun run typecheck` (27/27), `bun run lint` (clean) and `bun test` (**1715 pass, 24 fail — every
> failure is a `*.integration.test.ts` reporting "Could not find a working container runtime
> strategy"**). Seventeen modules register. Read §0 first: **no gate can be claimed from this host**,
> because the integration suites have never executed.


Companion to `docs/PLAN.md`. Planned against the codebase **as it actually exists**, per PLAN.md §0
("later phases get planned when their turn comes"). PLAN.md stays authoritative; where this file
adds detail it is detail, and where it deviates it says so and why.

Discord facts below were re-verified against `docs.discord.com` on 2026-08-15. Re-verify again at
implementation time — CLAUDE.md requires it and several of these surfaces moved during 2026.

---

## 0. Preconditions

**Gate 2 is not proven.** Every Phase 2 module (`antinuke`, `antiraid`, `verification`, `backup`,
`phishing`) exists in full but is **untracked**, alongside ~35 modified tracked files. This working
copy also has no installed dependencies (`node_modules` holds only the root devDependencies), so no
acceptance command has been run here. Nothing in Phase 3 should start until:

1. `docker compose up -d && bun install && bun run typecheck && bun run lint && bun test` is green
   **with the integration suites actually running** — CLAUDE.md is explicit that they are dark on
   this Windows host, and a skipped suite is not a passing suite;
2. Gate 2's three criteria (§12) are demonstrated by command output;
3. the work is committed.

Phase 3 assumes all of that. It is otherwise planning on top of code nobody has run.

---

## 1. What Phase 3 delivers

PLAN.md §8: leveling + XP curves, rank cards, role rewards, leaderboards, welcome/goodbye cards,
autorole, sticky roles, reaction/button/dropdown roles, starboard. Plus **voice XP** — not named in
§8, but §6's `members.voice_seconds` column has been declared and unused since Gate 0, and the owner
has scoped it in.

Four new modules: `leveling`, `welcome`, `rolemenu`, `starboard`. Eleven existing modules become
fifteen — which is also the standing §12 framework check ("adding a module takes < 1 day").

---

## 2. The framework gaps that come first

Phase 3 is not nine modules. It is roughly 40% framework and 60% modules, and the framework half has
to land first or the modules cannot be written at all.

### G1 — Event vocabulary

Five events Phase 3 needs, none of which exist today:

| Internal event | Dispatch | Intent | Needed by |
|---|---|---|---|
| `reaction.added` / `reaction.removed` | `MESSAGE_REACTION_ADD` / `_REMOVE` | `GUILD_MESSAGE_REACTIONS` `1<<10` — **not** privileged | reaction roles, starboard |
| `interaction.component` | `INTERACTION_CREATE` type **3** | — | button/dropdown roles |
| `voice.state_updated` | `VOICE_STATE_UPDATE` | `GUILD_VOICE_STATES` `1<<7` — **not** privileged | voice XP |
| `member.updated` | `GUILD_MEMBER_UPDATE` | `GUILD_MEMBERS` (already granted) | sticky roles |
| `xp.level_gained` | *internal* — published by a module | — | level-up messages, future rule builder |

`member.updated` is already in `EVENT_TYPES` but absent from `NORMALISED_EVENT_TYPES`;
`packages/modules/registry`'s test asserts that no manifest subscribes to a type nothing emits, so a
listener added without a normaliser arm fails that test. That guard is working as designed — do not
route around it.

`xp.level_gained` is not emitted by the normaliser, so that same assertion needs a second emission
source (see G4/A6) or it will reject the `leveling` manifest.

**Hard constraint, easy to get wrong:** `GUILD_MEMBER_REMOVE` carries **no roles**. Sticky roles
therefore cannot read a member's roles at leave time — the member is gone and `GET member` 404s.
Roles must be snapshotted continuously from `GUILD_MEMBER_ADD` and `GUILD_MEMBER_UPDATE` into
`members.sticky_roles`. This is the reason `member.updated` is in scope at all.

**Reaction events have no stable server-side id.** There is nothing to derive a deterministic event
id from except `(channel, message, user, emoji)`, which means a genuine react → unreact → react
inside the dedupe TTL is indistinguishable from a RESUME redelivery. Both consumers are designed
around that rather than fighting it: role toggles are idempotent, and starboard **recomputes the
count from the message** instead of incrementing (see 3.F). Write the reasoning into the normaliser
arm — the next person will otherwise "fix" it by adding a sequence number and silently break I4.

Proposed natural keys:

- `reaction.added` / `reaction.removed` — `${channelId}:${messageId}:${userId}:${emojiKey}`
- `interaction.component` — `${interactionId}` (a real snowflake)
- `voice.state_updated` — `${guildId}:${userId}:${sessionId}:${channelId ?? 'disconnect'}`
- `member.updated` — `${guildId}:${userId}:${digest(sorted roles, nick, timeout)}`; a digest of the
  *new state*, so an identical state dedupes, which for a role snapshot is the correct answer

### G2 — Action kinds and payloads

`send`'s payload is `{channelId, content}` and nothing else. Phase 3 needs embeds (starboard,
level-up, welcome), components (role menus) and attachments (cards). Widen it, and make `content`
optional behind a refine that at least one of `content` / `embeds` / `components` / `attachments`
is present — today `content` is `.min(1)` and required.

Three new kinds:

| Kind | Endpoint | `REQUIRED_PERMISSIONS` | Note |
|---|---|---|---|
| `edit_message` | `PATCH /channels/{c}/messages/{m}` | `ViewChannel` | editing your own message needs nothing more |
| `delete_message` | `DELETE /channels/{c}/messages/{m}` | `ManageMessages` | over-gated for the bot's own post; accepted, because every Phase 3 use is a board post in a guild that grants it anyway. Document it. |
| `add_reaction` | `PUT /channels/{c}/messages/{m}/reactions/{e}/@me` | `ViewChannel \| ReadMessageHistory \| AddReactions` | |

Interaction responses need more than the current single `interaction_reply`. Component interactions
must be acknowledged inside 3 seconds (verified) and the useful callback types are 5
(`DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE`), 6 (`DEFERRED_UPDATE_MESSAGE`) and 7 (`UPDATE_MESSAGE`).
Add a `callbackType` field to `interactionReplyPayloadSchema` plus an `interaction_followup` kind
against `POST /webhooks/{applicationId}/{token}`.

`ACTION_KINDS`, `REQUIRED_PERMISSIONS`, `TARGETS_MEMBER`, `toRestCall`'s switch and the rule engine's
`payloadDefaults` are all exhaustive over the union, so the compiler will name every site. That is
the design working; budget for it rather than being surprised.

`delete_message` should **not** join `DESTRUCTIVE_KINDS`. I12 is about bans, kicks and channel/role
deletion; a starboard post the bot itself wrote is not that, and marking it destructive would mean
starboard never cleans up in development. Record the reasoning next to the set.

### G3 — Multipart REST path

`HttpRestProxyClient` hard-codes `content-type: application/json` and `JSON.stringify`s every body.
Cards need `multipart/form-data`: a `payload_json` form field, `files[n]` parts each with a
`Content-Disposition` filename, an `attachments[]` descriptor array in the JSON, and
`attachment://name.png` references from the embed. Verified against Discord's reference; default
per-file limit is 10 MiB.

Changes: `RestRequestOptions` gains `files?: { name, filename, contentType, data }[]`; the client
builds a `FormData` when `files` is present; `apps/rest-proxy`'s `/api/*` handler forwards them to
`@discordjs/rest` (confirm the exact option name at implementation time). `toRestCall`'s `RestCall`
gains the same field.

### G4 — Rule engine wiring

`RuleEngine`, `ruleConditionSchema`, `RedisRateWindow` and the `rules` table (with its
`trigger_event` generated column and index) are all built and tested. **Nothing instantiates any of
it.** No worker holds an engine, no row is ever written to `rules`, and `casesModule.rules` — the
compiled warn-escalation ladder — is inert. P2, described in §4 as one of the four primitives
everything else is configuration on top of, is dead code.

Phase 3 wires it. Scope:

- **`GuildRuleStore`** (Drizzle, `packages/db`): `listForEvent(guildId, eventType)` hitting
  `rules_guild_trigger_event_idx`; `seedPresets(guildId, moduleId, rules)`.
- **Preset seeding** on `guild.available`, for every manifest declaring `rules`. Row id
  `${guildId}:${moduleId}:${ruleId}`. Insert with `ON CONFLICT DO NOTHING` — a guild that disabled a
  preset must stay disabled across restarts, and an upsert that overwrites would silently re-enable
  it on every reconnect.
- **`RuleDispatchRuntime`** in `apps/worker`, a sibling of `ModuleListenerRuntime`: one consumer
  group, subscribed to the union of every declared rule trigger event.
- **A fact resolver.** `RuleEngine` deliberately never reads `ProtonEvent.payload` (payload shapes
  belong to the normaliser), and no `factsFor(event)` builder exists. It has to live in the worker,
  which is the right edge for it.
- **Cron rules.** `trigger.kind === 'cron'` registers through the existing `startModuleJobs` pattern
  and calls `engine.fire` directly.
- **Per-action dry run.** `RuleFireInput.dryRun` is one boolean for every action in a rule. It should
  come from `dryRunFor(action.kind, NODE_ENV)` per action instead, or a ladder that both bans and
  posts a mod-log line will run neither in development.

### G5 — Module publish port

Level-ups have to become `xp.level_gained`, and §7's `ModuleContext` gives a module no bus handle —
which is exactly what makes I3 enforceable rather than aspirational. So widen it narrowly:

- `ModuleManifest.emits?: EventType[]` — the allowlist.
- `ModuleContext.publish(type, naturalKey, payload)` — the runtime stamps `guildId` from the context
  and derives the id; a module cannot forge another guild's event or another module's type. The
  registry refuses at registration time if a module publishes something it did not declare.
- The registry's emission assertion accepts `NORMALISED_EVENT_TYPES ∪ ⋃ manifest.emits`.

This is the one real weakening of I3 in Phase 3. The allowlist is what keeps it a port rather than a
hole; do not add an unrestricted `bus` to `ModuleContext`.

### G6 — Gate 1 debt, retired as a by-product

`packages/modules/cases/src/index.ts` records three blockers. Two of them are closed by the above:
once modules can publish, `moderation.warned` can be emitted; once the engine is wired, the ladder
fires. The third — `warn` is not an `ActionKind`, because a warn is a ledger row with no REST call
and the executor assumes every kind maps to an endpoint — needs a "record only, no call" branch in
the executor pipeline. That is small and worth doing here.

**Out of scope:** `/case`, `/history` and `/reason`. They need blocker 1 (a module read port on
`ModuleContext`), which is a larger framework decision. It stays open with a named owner rather than
being smuggled into Phase 3.

### G7 — Storage

- `members` exists and is unused. Add a migration for `(guild_id, xp DESC)` — the leaderboard's only
  query.
- `starboard_posts (guild_id, source_message_id, board_message_id, star_count, created_at)`,
  PK `(guild_id, source_message_id)`.
- Voice sessions live in Redis, not Postgres (they are ephemeral and hot).
- **`manifest.migrations` still runs nowhere.** `logging` worked around it by shipping its DDL in
  the core drizzle set (`0002_message_logs.sql`). Phase 3 adds a second and third table to that set
  and the gap widens. Either close it in slice 3.A or record it as accepted debt with a Phase 4
  owner — silently repeating the workaround a third time is the option to avoid.

### G8 — Rendering (decision: in `apps/worker`)

Satori (JSX → SVG) → resvg (SVG → PNG), per §8. Three fixed presets, no custom editor (§13).

- **Pin the runtime risk on day one.** `@resvg/resvg-js` is a native NAPI module; if it misbehaves
  under Bun, the fallback is `@resvg/resvg-wasm`. A spike test before any card work, not after.
- **Fonts must be embedded.** No network at render time. Static weights rather than one variable
  file, because satori does no synthetic bolding — it picks the nearest declared weight, so every
  weight the design uses is a file. Licence recorded in `packages/cards/LICENSES.md`.
- **Avatars come from `cdn.discordapp.com`.** That is not `discord.com/api`, so I2 does not literally
  cover it — but the decision must be written down explicitly, with a byte cap, a timeout and a
  default-avatar fallback, or it will read as an I2 violation to the next reviewer. A CDN blip must
  degrade the card, never fail the command.
- **The dashboard's live preview loads that same CDN image in an `<img>`.** The bot's copy is fetched
  through `HttpImageFetcher` and inlined as a `data:` URI so satori never puts an unvetted request on
  the wire; the browser's copy is a plain image load, the way the app shell already draws avatars and
  guild icons. The preview can therefore show a background the real card drops for being too large —
  the settings are saved either way, and the PNG is what Discord receives.

---

## 3. Slices

Ordered so each one ends somewhere shippable.

### 3.A — Framework (no user-visible feature)

G1 normaliser arms + fixtures · G2 action kinds and payloads · G3 multipart · G4 rule wiring ·
G5 publish port · G6 `warn` kind + escalation firing · G7 migrations and indexes ·
intents widened to `GuildMessageReactions | GuildVoiceStates` in `apps/gateway/src/env.ts`.

Proof that it worked: the warn-escalation ladder, dead since Gate 1, fires end to end.

### 3.B — Leveling core

`packages/modules/leveling`.

- **Curve.** Original math (§1 — no copied formulas), a pure function, exhaustively unit-tested plus
  a fast-check property that `level(xpForLevel(n)) === n` and that the curve is monotonic.
- **`MemberXpStore` port.** `award()` must be **one SQL statement**: `INSERT … ON CONFLICT DO UPDATE`
  with the cooldown as a `WHERE last_xp_at IS NULL OR last_xp_at < now() - interval`. Two messages
  arriving concurrently must award once. Read-modify-write in application code will not do this and
  the bug is invisible until a busy guild finds it.
- **`message.created` listener.** Skip bots and DMs, apply channel/role exclusions, award, and on a
  level-up publish `xp.level_gained` and post the level-up message.
- **Voice XP.** `voice.state_updated` listener plus a Redis `VoiceSessionStore` keyed `(guild, user)`
  holding `{channelId, joinedAt}`. Join sets, move closes and reopens, `channel_id: null` closes
  (verified: null means disconnected). Guard against farming: exclude the guild's AFK channel,
  exclude self-deafened members, and require another non-bot occupant. Restart recovery: sessions
  carry a TTL longer than any plausible session, and `guild.available` reconciles against
  `GUILD_CREATE`'s `voice_states` array to close orphans. **A worker restart must neither
  double-award nor lose the session** — that is a Gate 3 criterion, not a nicety.
- **Commands.** `/rank [user]`, `/leaderboard [page]`, `/xp give|take|set` (admin), `/levels reset`.
- **API.** `GET /guilds/:guildId/leaderboard?page=` in `apps/api` — all domain logic there, per §9.

Note on the hottest path in the system: XP is a write per message per cooldown window. Put the
cooldown check in SQL as above, and if that proves too hot, a Redis pre-filter in front of Postgres
is the escape hatch — but measure before adding it.

### 3.C — Cards

`packages/cards` (rendering, framework-agnostic) + wiring into `leveling` and a new
`packages/modules/welcome`.

Rank card, welcome card, goodbye card. Three presets each. `renderCard(descriptor) → Uint8Array`.
`welcome` listens on `member.joined` / `member.left`.

Rendering must be deterministic enough to assert in CI without network access — that is what makes
criterion 6 testable.

### 3.D — Join Roles, role rewards, sticky roles

- **Join Roles → a listener, *not* preset rules. Superseded 2026-08-17.** The original design
  compiled `member.joined` + `add_role` into `ModuleManifest.rules` the way `cases/escalation.ts`
  compiles the ladder. It could never work: `rules` is a static array evaluated at module
  construction, so it saw only `defaultConfig` — an empty role list — which meant no rule was ever
  seeded and the dispatcher never subscribed to `member.joined`. Nothing recompiled it per guild,
  and `seedPresets` is deliberately `onConflictDoNothing`, so a config-derived rule set could never
  reconcile on removal either. The module now grants from a listener that reads `ctx.config` at
  event time, with separate role lists for people and bots and an option to hold roles until
  Membership Screening passes. 3.A's end-to-end proof is the `cases` warn-escalation ladder
  (Gate 3 criterion 5).
- **Role rewards → module logic, *not* rules.** *Deviation from §4-P2's literal wording, stated
  openly:* rewards are keyed on "the member reached level N", and §4-P2's predicate set is
  deliberately closed with no numeric comparison in it. Widening it to fit would open exactly the
  door `antiraid` documents keeping shut ("the predicate set is deliberately closed; scoring in a
  listener keeps the closed vocabulary closed"). So the leveling module reads
  `roleRewards: [{ level, roleId }]` with a `stack | replace` mode and issues `add_role` /
  `remove_role` itself. `xp.level_gained` is still published, so the future rule builder can react to
  it — the event is not wasted, only the mapping is module-local.
- **Sticky roles.** `member.updated` + `member.joined` snapshot into `members.sticky_roles`;
  `member.joined` re-applies. Never restore `@everyone`, managed/bot roles, or anything above the
  bot — the executor's precheck catches the last one and names it (I8), which is the required
  permission-failure path.

### 3.E — Reaction / button / dropdown roles

`packages/modules/rolemenu`.

Config carries `menus: [{ messageId, channelId, kind, bindings: [{ key, roleId }], mode }]` — an
array of objects, outside the form generator's v1 vocabulary by design (§9), so it gets a bespoke
dashboard editor exactly as the escalation ladder did. `formSchema` omits it; the manifest field
exists for this.

`/rolemenu create` builds the message. `custom_id` encodes `proton:rolemenu:<menuId>:<key>` — the
limit is 1–100 characters (verified), so bound the ids accordingly. Legacy action rows, buttons and
string selects still work without the `IS_COMPONENTS_V2` flag (verified); take that path, because
the flag disables `content` and `embeds` and buys nothing here.

The `interaction.component` handler defers (callback type 5, ephemeral) then follows up, per I9 —
the config read is an HTTP call even when cached.

### 3.F — Starboard

`packages/modules/starboard`.

The design decision that makes everything else fall out: on `reaction.added` / `reaction.removed`,
**re-read the source message** (`GET /channels/{c}/messages/{m}`, needs `ReadMessageHistory`) and
count the emoji from `message.reactions`. Never increment from the event. This is what makes the
missing reaction id (G1) harmless — the event is a trigger, not a datum.

- ≥ threshold, no post → `send` the embed, record `board_message_id`
- ≥ threshold, post exists → `edit_message` the count
- < threshold, post exists → `delete_message`, drop the row
- never star a message in the board channel itself (loop)

Concurrency: two reactions arriving together produce two different event ids, so two `send`s could
both fire. Derive the create action's idempotency key from `(guildId, sourceMessageId, 'create')`
rather than the event id — that is what I4 is for, and it makes the create effectively-once without
a lock.

### 3.G — Dashboard

- `guilds/$guildId/leaderboard` — Table + Virtual + Zod search params, mirroring the cases browser.
- Bespoke editors for role rewards, role menus and the sticky-role allowlist, following
  `EscalationLadderEditor`.
- Card preview: live, and without a second renderer. The card is one React component in
  `@proton/cards/design`; satori rasterises it for Discord and the dashboard renders the same
  component with react-dom, so the preview updates on the keystroke rather than on a round trip.
  Only satori and resvg stay out of the browser, behind the `/design` subpath the client-bundle
  test polices.
- Nothing new for audit: every mutation already passes `auditTrail` (I7).

---

## 4. Gate 3 acceptance

Patterned on Gates 0–2. Every criterion proven by command output, not assertion.

1. `docker compose up -d && bun install && bun run typecheck && bun run lint && bun test` green,
   **with integration suites running** — shown from WSL, CI, or `DOCKER_HOST=tcp://localhost:2375`.
2. Replayed `message.created` fixtures award XP once per cooldown window; two concurrent messages
   award **once** (integration test, real Postgres).
3. A level-up publishes `xp.level_gained` and grants the configured reward; a reward role positioned
   above the bot fails with a named precheck reason. *(happy path + permission-failure path)*
4. A configured Join Role produces exactly one `add_role` on a replayed `member.joined`, and a role
   positioned above the bot fails with a named precheck reason. *(3.A's end-to-end proof is now
   criterion 5 — see 3.D)*
5. N warns inside the escalation window fire the ladder rung. *(retires the open Gate 1 item)*
6. A rank card renders to a PNG in CI with no network access.
7. `reaction.added` grants a role and `reaction.removed` revokes it; a component interaction is
   acknowledged within 3 s; a bot without `ManageRoles` surfaces the named reason ephemerally.
8. N reactions cross the starboard threshold → **exactly one** board post, asserted with the event
   replayed twice; the count edits; dropping below threshold deletes.
9. Sticky roles snapshot on `member.updated`, restore on rejoin, and skip a role above the bot with
   a named reason.
10. A replayed voice join → leave awards for the elapsed time; a worker restart mid-session neither
    double-awards nor loses the session.
11. The four new modules each took < 1 day to add. If not, fix the framework before Phase 4 (§12).

---

## 5. Risks

- **R1 — resvg under Bun.** Native NAPI. Spike it first; `@resvg/resvg-wasm` is the fallback.
- **R2 — XP is the hottest write path in the system.** One row per message per cooldown. Cooldown in
  SQL, index present, Redis pre-filter only if measured.
- **R3 — reactions have no stable id.** Mitigated by starboard's recompute-never-increment design and
  by role toggles being idempotent. Do not "fix" it with a sequence number.
- **R4 — the publish port weakens I3.** Mitigated by the `emits` allowlist and a runtime that stamps
  the guild id. Never hand a module the bus.
- **R5 — `manifest.migrations` runs nowhere.** Phase 3 adds two more tables to the core set. Close it
  or own it.
- **R6 — Gate 2 is unproven and uncommitted.** §0 above.
- **R7 — XP data is a GDPR surface.** `members` rows are per-user behavioural profiles with no stated
  retention, and Proton is a data controller (§6). Needs a policy before launch, not after.

---

## 7. What was built, and what was not

### Built

| Slice | State | Notes |
|---|---|---|
| 3.A framework | done | 5 event types, 5 action kinds, multipart, rule wiring, publish port |
| 3.B leveling | done | curve + property tests, single-statement award, message XP, voice XP, `/rank` `/leaderboard` `/xp` |
| 3.C cards | done | satori + `@resvg/resvg-js` **work under Bun** — R1 did not materialise. Manrope and Inter (OFL) checked into `packages/cards/assets` as WOFF and TTF, which satori parses and `@napi-rs/canvas` measures identically |
| 3.D join roles + sticky | done | `joinroles` grants from a listener (people and bots, screening-aware); sticky roles in the same listener; `grant.ts`/`restore.ts` refuse `@everyone`, managed roles, roles at-or-above the bot, and anything off the allowlist |
| 3.E rolemenu | done | reaction, button and select menus; deferred ack then follow-up |
| 3.F starboard | done | recompute-never-increment; create keyed on `(guild, message)` not the event |
| welcome | done | greeting + optional card; a failed render never costs the message |
| Gate 1 debt | done | `/warn`, the `warn` ledger-only kind, and `moderation.warned` published — the escalation ladder can finally fire |
| 3.G dashboard | done | leaderboard route (typed search params, shareable URL), `GET /guilds/:guildId/leaderboard` in `apps/api`, and bespoke editors for `leveling.roleRewards` and `rolemenu.menus` — both arrays the v1 form generator refuses by design (§9) |

Two additions to `packages/core` that the plan did not anticipate:

- **`GuildRole.managed`.** Sticky-role restore needs it — Discord answers 403 for a managed role
  regardless of hierarchy, so attempting one spends a rate-limit token to be told no. Optional, so an
  older stored snapshot reads as "not known to be managed" and fails open.
- **`LEDGER_ONLY_KINDS` and a three-way `PayloadResult`.** `warn` is a state change with no Discord
  endpoint. Modelling the mapping as a union rather than an optional `call` means the compiler forces
  the no-call case to be handled instead of letting a kind fall through to some endpoint.

### Not built

1. **Integration tests have never run.** Every `*.integration.test.ts` written for this phase is
   unexecuted. Docker's TCP endpoint on 2375 is closed on this host and CLAUDE.md rules out the
   named-pipe path for Bun.
2. **Gate 3 acceptance is therefore unproven.** Criteria 2, 3, 5, 7, 8, 9 and 10 in §4 all depend on
   integration suites. Nothing in §4 should be treated as demonstrated.
3. **Nothing proves the live preview and the PNG agree.** They were measured against each other
   once — every box lands on the same pixel, and only text advance widths differ by 1–2px because
   the browser fetches Manrope from Google Fonts rather than the checked-in file. No test holds
   that, because nothing in this repo can drive a browser.

Items 4 and 5 as first written are now closed: `manifest.migrations` was deleted in favour of the
core drizzle set that four modules already used, and `ActionResult.body` carries Discord's response
on success, which retired starboard's `resolveBoardPost` lookback.

## 8. Automod (landed after Phase 3)

PLAN.md §8 files automod under Phase 4 and §10.5 says "use, don't rebuild: native AutoMod". It is
built now, and it does both.

**One config, Proton routes.** The admin describes what to block once. Everything Discord's own
AutoMod can enforce is pushed into real rules at its edge — blocked words, its maintained presets, a
mention limit, its spam heuristic — and Proton enforces the rest itself: flood, duplicates, mass
mentions, invites, blocked domains, attachment extensions, custom patterns, zalgo, shouting, emoji
spam, walls of text. The dashboard's enforcement panel names which half owns what, including each
regex Rust's engine cannot run and why, because that promise is otherwise unverifiable.

Decisions worth knowing before changing anything here:

| Decision | Why |
|---|---|
| Every check is a **severity**, not a boolean | Eleven checks with a separate enabled flag is twenty-two fields to keep consistent. `off` is a severity. |
| **Highest severity wins**, the rest are reported | First-match-wins makes the punishment depend on array order; summing recreates antiraid's join scoring and makes "why was I timed out" unanswerable. |
| Both **stateful checks run first and unconditionally** | Flood and duplicate must observe every message. Short-circuiting them behind an earlier match under-counts silently. |
| Native rules **block and alert, never punish** | Discord's TIMEOUT action only exists on KEYWORD and MENTION_SPAM, so the same word list would punish differently depending on which rule it landed in. Punishment stays in the severity ladder. |
| Ownership by **`creator_id`**, name prefix only as fallback | An admin naming their own rule `Proton: blocked words` must not hand it over. Nothing Proton did not create is ever updated or deleted. |
| Sync is **stateless list-diff-apply** | Nothing to drift, and a rule deleted by hand in Discord's UI comes back on the next reconcile. |
| Rule writes go through **`ActionExecutor`** (I1), with `record: false` | A rule edit is configuration, not moderation, so it is prechecked and audited but stays out of the case ledger. |
| Automod **publishes `moderation.warned` itself** | The `warn` *action* is ledger-only and publishes nothing — only `/warn` does. Without this seam the escalation ladder never fires for a repeat offender. Not after a kick or ban: the member is gone. |
| The **execution listener** warns and escalates too | A natively blocked message produces no `MESSAGE_CREATE`, so without it a member could live on the blocked-word list without reaching a single rung. |

Two seams outside the module were needed:

- **`automod.executed`** and both AutoMod intents (non-privileged, and only delivered to a bot
  already holding Manage Server). Executions carry no id, and `message_id` is absent when the
  message was blocked outright — so the natural key falls back to a digest of what matched, and an
  identical blocked message posted twice collapses to one event. Correct for a log; the same trade
  the reaction arm already makes.
- **`proton.config_changed` now reaches a disabled module.** The listener runtime gates every
  listener on the module switch, so a module turned off never heard that it was — and automod's
  Discord rules would have gone on blocking with nothing left running to take them down.

Still unproven from this host: the integration paths (config save → rules reconciled; a hand-made
rule left untouched; a replayed execution recording exactly one case). They are the same Docker
problem as everything else in §7.

## 6. Questions for the owner (§14 style — answer before executing)

1. `[ASK]` Retention for `members` XP rows: on member leave, and after `guilds.left_at`?
   *(Proposal: keep on leave — rejoining members expect their level back; purge 30 days after the
   bot is removed from the guild, matching the message-log posture.)*
2. `[ASK]` Are rank cards premium (`requiredEntitlement: 'plus'`)? The manifest field exists now even
   though billing is Phase 5, and retrofitting a gate after guilds have used a free feature is worse
   than declaring it up front.
3. `[ASK]` Font for the cards — licence must permit redistribution in a commercial bot.
4. `[ASK]` Does the privacy policy at `apps/dashboard/src/components/legal/privacy-policy.tsx` need a
   levelling/voice-tracking clause before Phase 3 ships, or at Gate 5 with the rest?
