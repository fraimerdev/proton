# Honeypot — build record

Companion to `docs/modules/HONEYPOT.md` (the spec) and `docs/PLAN.md`. Records what was actually
built, what deviates from the spec and why, and what is proven versus written-but-unproven.

---

## 1. What landed

### The module (`packages/modules/honeypot/`)

Nine source files, no database table, no slash commands, no migrations.

| File | What it is |
|---|---|
| `config.ts` | The flat settings, the per-channel list, `channelFor` (which also resolves a thread to its parent), and `describeWindow` — the seconds-to-English function every user-facing string goes through. |
| `message.ts` | `readMessage` and `ignoreReason`. The whole safety surface of the module. |
| `plan.ts` | `planTrap` — one config row to an ordered list of executor steps. Pure. |
| `listener.ts` | The `message.created` handler: lock, plan, execute, delete, log, publish. |
| `embed.ts` | The channel notice and the incident report. |
| `service.ts` | `reconcileNotices` — the `proton.config_changed` handler that keeps one notice per armed channel in step with the config. |
| `store.ts` | `RedisHoneypotLock` — `SET key '1' PX ttl NX`. |
| `deps.ts` | The ports, bound the way every other module binds them. |
| `index.ts` | The manifest. |

**The softban is two executor calls, never `expiresAt`.** `REVERSAL_OF.ban = 'unban'` exists, but that
is the *temporary ban* path — it defers the lift to the scheduled-action sweeper, which would leave
the member banned for up to a sweep interval. A softban has to lift immediately, so it is
`{ kind: 'ban', payload: { deleteMessageSeconds } }` followed by `{ kind: 'unban' }`, each with its
own idempotency key so a failed lift stays retryable after a claimed ban.

That the unban survives the member already being gone is not luck: `TARGETS_MEMBER.unban` is `false`,
so `resolvePrecheckContext` returns early and never looks up roles for a member who is no longer
there.

### The safety surface

The guards, in the order they run, are the module. Everything else is bookkeeping:

1. **Proton itself**, by bot user id. Not configurable — a honeypot that springs on its own warning
   notice is a loop.
2. **Webhooks**, read as `typeof webhook_id === 'string'`.
3. **Bots**, read as `author.bot === true`.
4. **System messages**, via `isHumanMessage` — the set `{0, 19}`, ordinary message and reply.

Guard 4 is the one that would have hurt. A join announcement (type 7) and a boost notice (type 8)
both carry the joining member as `author` with no bot flag. A honeypot channel that is also the
guild's system channel would otherwise remove every member who joined. `isHumanMessage` already
existed twice in the repo — in `automod` and in `leveling` — but modules may not import each other
(PLAN.md I3), so it was lifted into `@proton/core` rather than copied a third time.

**No `MessageContent` intent.** The module never reads a message body, so it does not ask for the
privileged intent, and the guards deliberately never test content — a `if (!content) return` would
have disabled the whole module the moment that stayed true.

### Burst suppression

A `SET NX PX` claim on `(guildId, userId)` before anything else. It has to be Redis, not a Map: the
worker runs more than one process, the bus assigns a fresh consumer per process inside one shared
group, and a stale entry can be reclaimed and re-run after 30 seconds.

The executor's own idempotency key is a *second* line, not a substitute — it is keyed per message, so
three messages a second apart are three distinct keys and would have been three removals.

### Beyond the module

- **`packages/core`** — `honeypot` added to `protonSecurityTrippedSchema.moduleId`;
  `honeypotChannels` added to the tier limits; `isHumanMessage` lifted in.
- **`apps/dashboard`** — the channel editor and the blurb. No posting surface: see §6.
- **`apps/worker`** — the lock, the notice store, guild state and bot id bound.
- **`packages/modules/serverlog`** — the `proton.security_tripped` label was `Anti-nuke or anti-raid
  tripped` and is now `A security module tripped`, because a third module emits it.

---

## 2. Deviations from what was asked for

| Asked for | Built | Why |
|---|---|---|
| `guild.members.ban()` via discord.js | `executor.execute({ kind: 'ban' })` then `{ kind: 'unban' }` | PLAN.md I1/I2 and CLAUDE.md: every state change goes through `ActionExecutor`, every REST call through `apps/rest-proxy`, and no discord.js `Client` is ever constructed. Identical semantics, and it buys the permission precheck, the hierarchy check, the idempotency key and the case ledger. |
| `Map<guildId:userId, Promise>` in memory | A Redis `SET NX PX` claim | An in-memory map is per-process, and the worker is horizontally scaled. |
| A confirmation before enabling **or removing** | Confirmation on arming only | Arming creates a channel where any message removes the poster. Removing a honeypot only makes the server safer — a confirmation there trains people to click through the one that matters. |
| A button that posts the warning notice | No button — the notice posts itself on save | See §6. A warning that depends on an admin remembering to press something is missing from exactly the trap somebody armed in a hurry. |

---

## 3. Two defects found after the first pass, both fixed

Recorded because both were found by reading rather than by a failing test, and both were silent.

1. **A refused ban left the bait message standing.** `deleteTrigger` skipped the delete whenever the
   plan *intended* to purge, on the reasoning that the ban's own window had already taken it. When
   the ban was refused — no permission, hierarchy, member already gone — nothing was purged and the
   message that sprang the trap stayed visible. It now deletes whenever the ban did not land.
2. **A recovered softban was reported as a failure.** When the first unban failed and the retry
   succeeded, `failure` stayed set, so a completed softban was logged as `refused`, drew the amber
   embed, and re-deleted a message the ban had already taken. The retry now clears it.

A third was found in `packages/core` while fixing the audit-log reason (§4) and is fixed there.

---

## 4. A repo-wide bug this work uncovered

`apps/rest-proxy` **discarded the Discord audit-log reason for every action Proton has ever taken.**
`rest-mapping.ts` set `x-audit-log-reason` on every ban, kick, timeout, role change and channel
operation; `rest-client.ts` put it on the wire; and the proxy rebuilt the upstream request reading
only `x-proton-authorization`, so the header died there. The case ledger had the reason. Discord's
audit log did not.

No test caught it because all three existing tests stop at or before the proxy boundary, and the mock
upstream recorded only path, method and time — never headers.

Fixing it exposed a second, latent bug in `rest-mapping.ts`: the 512-character cap was applied to the
*encoded* reason, so a legitimate 512-character reason lost about 128 characters, and the cut could
land mid-escape and produce a malformed percent-sequence. Inert while the header was dropped, live
the moment it was not. The slice now happens before the encode.

**This changes what guild moderators can see.** Reasons now reach the Discord audit log, and some
carry internals — `backup` sends `Restoring backup <id>`, `antiraid` sends its score and reasons.
That is what an audit reason is for, but it is new information leaving the system.

---

## 5. What is proven, and what is not

**Proven on this host.** `bunx turbo run typecheck --force` is 37/37, `bun run lint` is clean, and
4314 unit tests pass. The honeypot module carries 67 of them across 5 plain `.test.ts` files: the
softban's ordered calls and their bodies, every ignore rule as its own test, the burst collapsing to
one action, threads on and off, each action kind, the incident log, the notice, and — the two
CLAUDE.md requires — the permission-failure path in both its shapes and the unban-failure path
asserted on the log sentence rather than a call count. The rest-proxy fix was reproduced as a failing
test before it was fixed, and its suite runs here because it needs only `Bun.serve`, not Docker.

**Not proven.** The 29 `*.integration.test.ts` suites are dark on this Windows host — Bun cannot open
the Docker named pipe, so Testcontainers cannot start. A skipped suite is not a passing suite. Also
unproven: the arming confirmation is verified by reading the component and by SSR assertions that it
is *absent* until asked for, but not by clicking through it — the dashboard has no DOM test
environment, and the browser session that would have exercised it did not survive a restart.

Two failures in `packages/modules/moderation` are unrelated and pre-existing: they lower a permission
through the interaction hint, but `ban` and `kick` are guild-scoped, and `resolve-context.ts`
deliberately ignores the hint for those. The harness gives the bot full guild permissions, so the
precheck passes and the call is made. The fix belongs in that harness, not in `resolve-context`.

---

## 6. The notice posts itself

The first cut gave the dashboard a **Post the notice** button, one per configured channel. That was
wrong, and it was replaced before it shipped: a warning that only appears when an admin remembers to
press something is a warning that will be missing from exactly the trap somebody armed in a hurry.

The notice is now reconciled from `proton.config_changed`, which the api already publishes on every
save. On each save, for every armed channel: post the notice if there is none, edit the one already
there if there is, and post a fresh one if the remembered message has been deleted (`discord_404`).
A channel that stops being a trap — disarmed, removed from the list, or the whole module switched
off — has its notice taken down, because a notice saying "this is a trap" over a channel that is not
one is worse than no notice.

That needed a per-guild `NoticeStore` (`RedisNoticeStore`, one key holding a channel-id → message-id
book). One key rather than one per channel: the reconcile has to know about notices belonging to
channels that are no longer in the config, and SCANning a key space is not something a save should do.

**Verification's panel works the same way now**, for the same reason, and its `Post panel` button and
`verification.panel_requested` event are gone with it.

**One bug this shook out**, found independently by both test authors and invisible to the tests
themselves: honeypot's manifest did not declare `edit_message`, and verification's did not declare
`delete_message`. `moduleExecutor` throws `UndeclaredActionError` on an undeclared kind, and
`listener-runtime` awaits the handler with no `try`/`catch` — so the *second* save of a honeypot, and
every panel take-down, would have thrown out of the handler rather than degrading. Module tests drive
`DefaultActionExecutor` unwrapped, which is why no suite could have caught it; the manifest assertions
now pin both lists with a comment saying what the throw costs.

---

## 7. The notice became Components V2, and grew a counter

One container, Blocked Coral. It shouts `## 🍯  DO NOT SEND MESSAGES IN THIS CHANNEL`, says what
posting costs *in that channel's own terms*, and then — after a dividerless separator, inside that
same container — carries one button whose label is named for the action that channel is configured
with: `Softbans: 4`, `Kicks: 4`, `Caught: 4` when the action is `none`. A softban trap never says
"Kicks".

The V2 flag is set on the send and omitted on every edit, because Discord refuses to take
`IS_COMPONENTS_V2` off a message.

Pressing the button answers ephemerally, also V2, with the lifetime total, the last 24 hours, the
last 7 days and a breakdown of what was actually done. **Who was caught is shown only to a presser
holding Ban Members or Manage Server** — the notice sits in a channel everybody can see, so
everybody can press it. The permission comes off the interaction's own `member.permissions`.

Backing it: a Redis HASH for the lifetime counters, a ZSET keyed on the *message* that produced each
catch for the windows and the recent list (trimmed to 30 days), and a `SET NX PX` lease that bounds
notice edits to one per channel per ten seconds across every worker process.

### What the adversarial review changed

It confirmed the parts most likely to be wrong — a Container may hold an Action Row; `interaction_reply`
really does OR `32768 | 64` through `toRestCall` (a *followup* would have silently dropped it);
`member.permissions` is present on a component interaction — and then found nine things. The ones
that mattered:

1. **A notice Discord refused to delete was reported as removed and forgotten**, so nothing ever
   retried and the channel kept a message calling itself a trap that no longer was. Not exotic:
   `delete_message` needs ManageMessages, which honeypot does not require module-wide. It now keeps
   the record and reports `failed`, so the next save tries again.
2. **The counting block sat between the action and the audit trail**, so a Redis throw took the
   incident log and the security event down with it. It now runs last, wrapped — a number on a
   button is cosmetic; the record that a member was removed is not.
3. **The one message that mentions anyone** — the privileged member list — was the only one not
   setting `allowedMentions: { parse: [] }`.
4. `Number(raw) ?? 0` is a dead fallback, so a non-numeric Redis value would have rendered
   `Softbans: NaN` on a public button.
5. A privileged presser whose catches had all aged past the 30-day trim saw **no list and no reason
   for its absence**, which reads as a broken permission check.
6. A `listener ↔ service` **circular import** that only worked because the binding was read at call
   time.

A seventh, found while fixing rather than by the review: a redelivered `message.created` would count
the same member twice, because the ban behind it comes back `skipped_duplicate` — which reads as
success. Counting is now skipped when any step was a duplicate, and the ZSET is keyed on the message.

Also fixed in `packages/core`: `interaction_followup` validated a Components V2 flag and then
discarded it in the mapper, and the comment on `InteractionMessage.flags` pointed the next reader at
exactly that broken path. Latent — no module used it — but it was one copy-paste from live.

**Still open**: `RedisHoneypotStatsStore.record` is two round trips (ZADD NX, then the counters). A
process death in that window loses one count permanently, because the surviving ZSET entry makes
every retry a no-op. The correct fix is one Lua script; it is not written.
