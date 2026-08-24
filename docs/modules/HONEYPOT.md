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
| Delete window | Per channel, 0–7 days, stored in **seconds** and offered in the dashboard as days. Applies to `softban` and `ban`; Discord has no equivalent for the others. |
| The trigger message | Deleted explicitly for `kick`, `timeout`, `warn` and `none`. For `softban` and `ban` the delete window already removes it and a second delete would race the purge — **unless the ban was refused**, in which case nothing was purged and the message baiting the trap is still sitting there. |
| Channels | A list. Each row carries its own channel, enabled switch, action and delete window. |
| Configuration | **Dashboard only.** No slash commands — this module registers none. |
| Panel | A bespoke `MODULE_PANELS` entry: the generated form cannot render a list of objects. |
| Warning embed | Posted on demand from the dashboard, over the bus, exactly as Verification's panel is. Never automatically. |
| Duplicate suppression | A short-lived Redis claim on `(guildId, userId)`. Not in-memory: the worker is horizontally scaled, and an in-memory map is per-process. |
| Intents | `Guilds` + `GuildMessages`. **Not `MessageContent`** — the module never reads a message body, which is worth keeping true. |
| Permissions | `BanMembers`. Declared module-wide, so the module reports itself disabled with a reason when it is missing rather than failing silently at the first trap. |
| Logging | Every trigger writes a case through the executor (automatic) and, where a log channel is set, an embed naming what happened and whether it worked. |

---

## 4. Config

```
enabled            boolean                     default false
channels           HoneypotChannel[]           bespoke panel, tier-capped
logChannelId       channel-id                  where incident embeds go

HoneypotChannel {
  channelId              channel-id
  enabled                boolean               default true
  action                 enum                  default 'softban'
  deleteMessageSeconds   number 0..604800      default 604800 (7 days)
  timeoutDuration        duration              default '1h', only read when action is 'timeout'
}
```

`channels` cannot go through `zodToDescriptors` (objects nest one level, arrays must be flat), so the
manifest ships a `formSchema` that omits it and the dashboard renders the list in its own panel.

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

## 6. The warning embed

Posted into the honeypot channel on request. It exists so a member who wanders in has been told,
and so the trap is not a gotcha for someone who joined before it was set.

It must communicate, in Proton's own voice and branding:

- **DO NOT SEND MESSAGES IN THIS CHANNEL**, unmissably.
- That the channel is monitored and exists to catch spam and compromised accounts.
- That posting removes you and deletes your recent messages.
- The delete window actually configured for that channel.

Not copied from any other bot: no borrowed name, wording or layout.

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
