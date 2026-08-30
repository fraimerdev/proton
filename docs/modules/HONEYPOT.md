# Module Spec — `honeypot`

Status: new module, Phase 2 (security). Parent spec: `docs/PLAN.md`; all invariants in PLAN.md §3
apply. Where this file and PLAN.md conflict, PLAN.md wins.

A honeypot channel is a trap. Nobody has any reason to post in it, so posting in it is the signal —
there is nothing to detect, analyse or threshold. Compromised accounts and spam bots walk every
channel they can see and post in all of them; a real member does not.

---

## 1. The one behaviour

```
member posts ANY message in a honeypot channel
        │
        ▼
   claim the lock for (guild, member)      ← a burst of three messages is one action
        │
        ▼
   perform the configured action           ← softban by default
        │
        ▼
   log the incident
```

No content inspection. No threshold. No second message. **A message saying "hello" trips it**, and
that is correct: the channel exists so that anything at all trips it.

---

## 2. The softban, and why it is a ban

The default action is a **softban**: remove the member and purge what they have already posted, but
let them come straight back.

```
ban  (delete_message_seconds = the configured window)
        ↓
unban (immediately)
```

Discord has no "kick and delete their messages" call. `Kick` removes the member and leaves every
message they posted standing. The only API that deletes a member's recent history is the **ban**,
via `delete_message_seconds` — so Proton bans to get the purge, then lifts it at once. The member
experiences a kick with a cleanup; the ban exists for a few hundred milliseconds and only to reach
the delete window.

**This is the module's most dangerous moment.** If the ban succeeds and the unban does not, a member
Proton intended to release is left permanently banned. §7 says what has to happen then.

### Not discord.js

The spec this was requested from described `guild.members.ban(...)`. That is not available here:
PLAN.md I1 and I2 say every state change goes through `ActionExecutor` and every REST call egresses
through `apps/rest-proxy`, and CLAUDE.md forbids constructing a discord.js `Client` anywhere. The
semantics are identical — `executor.execute({ kind: 'ban', payload: { userId, deleteMessageSeconds } })`
then `{ kind: 'unban' }` — and going through the executor is what buys the idempotency key, the
permission precheck, the role-hierarchy check and the case ledger for free.

---

## 3. Locked decisions

| Area | Decision |
|---|---|
| Trigger | Any `message.created` in a configured channel, from a non-bot, non-webhook, non-system author. Nothing else. |
| Actions | `softban` (default) \| `ban` \| `kick` \| `timeout` \| `warn` \| `none`. |
| Delete window | **Module-wide**, 0–7 days, stored in **seconds** and edited as days/hours/minutes/seconds. Applies to `softban` and `ban`; Discord has no equivalent for the others. |
| The trigger message | Deleted explicitly for `kick`, `timeout`, `warn` and `none`. For `softban` and `ban` the delete window already removes it and a second delete would race the purge — **unless the ban was refused**, in which case nothing was purged and the message baiting the trap is still sitting there. |
| Channels | A list of bait channels. Each row carries **only** its channel and an enabled switch. |
| Where the action lives | **Module-wide, since schema v2.** v1 kept the action, the delete window and the timeout length on every row; the guide the owner wrote treats them as one setting for the whole module, and `liftStoredConfig` collapses the old shape — the first armed row decides, and rows that disagreed lose that variation. |
| Configuration | **Dashboard only.** No slash commands — this module registers none. |
| Panel | The page is a per-module route file split into seven areas. Four keys are owned by bespoke editors rather than generated fields: `channels`, `noticeLayout`, `dmLayout` and `appealPanelId`. |
| Warning notice | Posted when the config is saved, one per armed channel. Saving again edits the notice already there rather than posting a second; disarming a channel, removing it, or switching the module off takes its notice down. **`postNotice` is now a switch, defaulting on** — the earlier decision was that there must be none, on the grounds that a trap an admin armed and forgot to announce is what the notice exists to prevent. The owner's guide asks for the switch; the default keeps the old behaviour for anyone who never touches it. |
| Authored messages | The notice and the DM are stored as `ProtonMessage` layouts and edited in the shared message builder. **Free servers post the built-in layout**: the substitution happens at render, never at save, so a downgrade cannot overwrite what an admin wrote. Proton appends the counter, appeal and rejoin buttons itself — a stored non-link button must carry a `ComponentAction`, and there is none for "open this trap's tally". |
| Duplicate suppression | A short-lived Redis claim on `(guildId, userId)`. Not in-memory: the worker is horizontally scaled, and an in-memory map is per-process. |
| Intents | `Guilds` + `GuildMessages` + **`MessageContent`**. This reverses the original decision. "Quote the message" puts what was posted in the incident log, and reading a body without declaring the intent would make the manifest a promise Proton was not keeping. Nothing branches on the body — the trap is still that a message exists at all — and quoting is off by default. It costs no gateway deploy: `DEFAULT_INTENTS` already carries the intent for automod, logging and phishing. |
| Permissions | `BanMembers`. Declared module-wide, so the module reports itself disabled with a reason when it is missing rather than failing silently at the first trap. |
| Logging | Every trigger writes a case through the executor (automatic) and, where a log channel is set, an embed naming what happened and whether it worked. |

---

## 4. Config

Schema version **2**. Seven areas, in the order the page shows them.

```
Bait channels
  enabled                  boolean            default false — the module switch
  includeThreads           boolean            default true
  channels                 HoneypotChannel[]  bespoke editor, tier-capped 3/10/25

  HoneypotChannel { channelId: channel-id, enabled: boolean default true }

Camouflage                                    both off until turned on
  keepChannelActive        boolean            default false
  renameChannelDaily       boolean            default false

What happens
  action                   enum               default 'softban'
  timeoutFirst             boolean            default false
  timeoutFirstDuration     duration           default '5m'
  timeoutDuration          duration           default '1h', read when action is 'timeout'
  deleteMessageSeconds     number 0..604800   default 604800 (7 days)
  appealPanelId            string             bespoke picker, an appeals form id
  waitBeforeActingSeconds  number 0..604800   default 0 — zero schedules nothing at all
  auditLogReason           string 1..512      what Discord's own audit log records
  deleteTriggerMessage     boolean            default true

Who is exempt                                 caught and counted, never acted on
  exemptAdministrators     boolean            default true
  exemptAdminRoleId        role-id
  exemptRoleIds            role-id[]

The warning message
  postNotice               boolean            default true
  noticeCounterButton      boolean            default true
  hideWhatIsAHoneypot      boolean            default false
  noticeLayout             ProtonMessage      bespoke editor; free servers post the default

The direct message
  sendDirectMessage        boolean            default true
  offerWayBackIn           boolean            default false
  inviteUrl                string             pasted; Proton mints no invite
  dmLayout                 ProtonMessage      bespoke editor; free servers post the default

Escalation and logging
  addToBlacklist           boolean            default false
  quoteMessage             boolean            default false
  logChannelId             channel-id
```

`waitBeforeActingSeconds` is integer seconds rather than a duration string because
`parseDuration` accepts one unit only, so `1d 2h 30m` is inexpressible. The two timeout lengths stay
duration strings: `planTrap` already parses them, and the `duration` field kind already exists.

The four keys a bespoke editor owns — `channels`, `noticeLayout`, `dmLayout`, `appealPanelId` — are
omitted from `formSchema`. `HONEYPOT_PANEL_KEYS` names them, and `manifest.test.ts` asserts that
every config key is either on the page or in that list.

---

## 5. Edge cases that must be handled

| Case | Required behaviour |
|---|---|
| Bot, webhook or system message | Ignored. A honeypot that bans Proton's own warning embed is the worst possible bug. |
| Proton's own messages | Ignored by bot-check and by an explicit self-check on the bot user id. |
| The member is already banned | The ban is a no-op to Discord; the unban still runs. Never leave someone banned who was already banned before Proton arrived — the unban is what Proton owes for the ban it issued, so check whether the ban was Proton's before lifting it. |
| The member left before the action | Discord answers 404. Logged, not retried, not an error. |
| The member outranks the bot | The executor's precheck refuses before any REST call, naming the role and the fix. Logged; the message is still deleted. |
| Proton lacks Ban Members | The module reports itself disabled with the permission named. Configuring a honeypot while it is missing must say so. |
| **Ban succeeded, unban failed** | The loudest path in the module. Retry, then log at error naming the member and that they are still banned, and post it to the log channel. The incident must never be recorded as a success. |
| A burst of messages | One action. The lock is claimed before anything else. |
| The channel is deleted | Its row stays in config until an admin removes it; nothing triggers. |
| `action: 'none'` | Delete the message, log the trip, do nothing to the member. This is how an admin watches a trap before arming it. |

---

## 6. The warning notice

Posted into the honeypot channel the moment the honeypot is saved, and kept in step with it on every
later save. It exists so a member who wanders in has been told, and so the trap is not a gotcha for
someone who joined before it was set. `postNotice` can switch it off; it defaults on.

**Components V2**, not an embed. A stored `ProtonMessage` an admin may author, whose default is one
container, Blocked Coral:

| | |
|---|---|
| Heading | `## 🍯  DO NOT SEND MESSAGES IN THIS CHANNEL` |
| Body | What posting here costs, in the module's own terms: `{consequence}` and `{purge}` are substituted from the configured action and delete window. `hideWhatIsAHoneypot` swaps the body for one that warns without naming the mechanism. |
| Button | Appended by Proton, not stored, and only when `noticeCounterButton` is on. Its label counts what this trap has done, named for the action: `Softbans: 4`, `Kicks: 4`, `Timeouts: 4`, `Warnings: 4`, `Bans: 4`, or `Caught: 4` when the action is `none`. An exempt catch is counted in the breakdown but **not** in that total — the button must not overstate what the trap has actually done. |

**Free servers post the built-in layout.** `layoutFor` substitutes it at render time and is called
in exactly three places, all render-only. Nothing on the write path may reach for it: a downgraded
server keeps its authored layout in `guild_modules`, unused, until it upgrades again.

The V2 flag is set on the send and **omitted on every edit** — Discord refuses to take
`IS_COMPONENTS_V2` off a message, and the send that created it already set the bit.

Not copied from any other bot: no borrowed name, wording or layout.

### The button

Pressing it answers **ephemerally**, also in Components V2, with what the trap has caught: the
lifetime total, the last 24 hours, the last 7 days, and a breakdown by what was done to them.

**Who was caught is not public.** The notice sits in a channel everybody can see, so everybody can
press the button. The member list is shown only to a presser holding Ban Members or Manage Server;
everyone else gets the counts and a line saying so. The permission comes off the interaction's own
`member.permissions` bitfield, which Discord computes for the channel the press happened in.

The number on the label moves after a trap springs, debounced to one edit per channel per ten seconds
across every worker process — a raid of fifty bots must not become fifty edits of one message. The
count a debounced trip misses is picked up by the next trip outside the window, or by the next save.

Counted only when the trap did what the notice promises: a refused ban caught nobody, and a number
that included it would overstate what the channel has ever done.

---

## 6b. The direct message, and everything after it

Sent **before** the punishment lands, because after a ban there is no shared server left to send it
through. Stored as a second authored `ProtonMessage`, substituted with `{server}` and `{action}`,
with the recovery advice and the buttons appended by Proton.

| | |
|---|---|
| Appeal button | A link to `/appeal/<signed token>`, minted per recipient. Offered **only on a real ban** — a softban lifts itself, so an appeal there invites somebody to argue about something that is not stopping them — and only when an appeal form is picked. Every failure to mint one (no secret, an over-long url, a signing error) drops the button and still sends the message: a link that goes nowhere is worse than no button. |
| Rejoin button | A link the admin pasted. Proton mints no invite; there is no `create_invite` action kind. |
| Crash safety | The opened DM channel id is written to Redis **before** the send. The executor answers a redelivered `create_dm` with `skipped_duplicate` and **no body**, so without this a worker that died between the two calls would leave the member banned, never told, and with nothing to retry from. The open key carries an attempt counter; after five, the incident log says they were never reached. |

The signed token is a pure function of the catch — `jti` is the trap root, `issuedAt` is the event's
own timestamp — so a RESUME redelivery mints a byte-identical link and the appeal filed under it is
found rather than filed twice.

---

## 6c. Waiting, camouflage, exemptions and escalation

| | |
|---|---|
| Wait before acting | A one-off durable schedule keyed on the **member**, `{ replace: false }`. Keying it on the message would let a bot posting every couple of minutes park one punishment per message, because the burst lock is 60 seconds and the wait can be seven days; `replace: true` would let it push its own punishment out forever. The punishment is frozen at catch time and runs under the settings it was booked with. A `member.left` or `entity.ban_added` during the wait cancels the job **and** writes a Redis tombstone, so a sweep already holding the row still stops — without it a softban's unban leg would lift the ban a moderator placed themselves. |
| Camouflage | **One** self-rescheduling daily job, natural key `all`, +24h with `{ replace: true }`. Two schedules would be two reschedule loops and two chances to strand one. The name and the keep-alive line are derived from the day and the channel rather than chosen at random, so a redelivered run produces the same name and does not spend a second rename out of Discord's allowance of two per ten minutes. |
| Exemptions | Evaluated from `computeBasePermissions`, never channel permissions: Administrator cannot be granted by an overwrite, and base permissions already answers `ALL_PERMISSIONS` for the guild owner, so exempting administrators covers the owner with no second branch. A member whose roles Proton cannot read is **exempt**, not caught, whenever any exemption is configured — the worst thing this module can do is act on somebody it should not have. An exempt catch is logged in Quiet Slate, never the amber used for a refusal: nothing reached the executor, so nothing may look like it was attempted and failed. |
| Blacklist | Written after the audit trail, gated on the punishment having succeeded, keyed on the trap root so a redelivery cannot block twice. Verification reads the list and refuses a blocked member at all of its entry points. |

---

## 7. When the unban fails

The one failure this module cannot treat as ordinary. Order of operations:

1. The ban is recorded. The unban carries its own idempotency key, so a retry is safe.
2. On failure, retry once immediately.
3. On a second failure, log at `error` naming the guild, the member, the case id, and the sentence
   **"they are still banned"** — not "the action failed".
4. Post the same to the log channel where one is set, marked as needing a human.
5. The returned outcome is `ban_stuck`, never `softbanned`.

---

## 8. Testing

Per CLAUDE.md a new module needs a happy path **and** a permission-failure path, minimum.

- Trip → ban with the configured window → unban, in that order, with distinct idempotency keys.
- Every ignore rule: bot, webhook, system type, Proton itself, a channel that is not a honeypot, a
  channel whose row is switched off, the module switched off.
- A burst of three messages produces exactly one action.
- Each action kind produces the right executor call; `none` still deletes and still logs.
- **The unban failure path**, asserted on the log text and the outcome, not just the call count.
- The permission-failure path: no Ban Members, and a member above the bot.
- The embed builder, and the bus event that posts it.

Plain `.test.ts` throughout — the integration suites cannot run on the Windows host.
