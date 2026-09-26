# User reports and punish settings

Both live in the Moderation module and on its dashboard page. **User reports** let members flag a
member or a message to staff; staff review each report in Discord or the dashboard and accept it,
with or without a punishment, or dismiss it. **Punish settings** shape the bans, kicks, timeouts
and warnings given through Proton — by slash command, from a report, with **Apps → Punish author**
or by report automation. Immune roles and member notifications also reach warn escalation.

User reports are off until a server sets them up. Moderation must be on for either to work.

## Setting up user reports

In the dashboard open the server, then **Moderation → User reports**, and choose **Set up user
reports**. Five steps follow.

1. **Reporting methods.** Switch on `/report`, **Report user**, **Report message** and reactions as
   wanted. For reactions, pick the emoji (🚩 by default), an optional reason it stands for, and the
   channels it works in (all, only these, all except these).
2. **Report channel and roles to notify.** Every report is posted here as a staff card. Pick a
   channel only staff can read: the card shows who reported, what they wrote and part of the
   reported message. Roles to notify (up to 10) are pinged when a card is first posted.
3. **Reasons and evidence.** The reason list (up to 25; five to start with), whether members
   may type their own reason, whether a reason, details or a file is required, how many files a
   report may carry (1–10, default 4), and whether Proton forwards a copy of a reported message
   into the report channel (on by default).
4. **Who can report and who reviews.** Everyone, only members with chosen roles, or everyone except
   chosen roles; roles that cannot be reported; reviewer roles; the cooldown between one member's
   reports (2 minutes by default) and roles that skip it; open-report limits; duplicate protection.
5. **Review and enable.** A summary of every choice, including the default automation rule.
   **Enable user reports** saves it all.

After that the same settings are under **Moderation → User reports**, in the Overview, Queue,
Settings, Automation and Messages tabs.

Saving refuses a configuration that cannot work, and names the setting: reports switched on without
a report channel or without any method, a required reason with no reasons and no custom reasons, a
reaction reason that isn't in the list, a move-on-close without an archive channel (or with the
report channel as archive), a per-member limit above the server limit, a shortest details length
above the longest. Required details always need at least one character; the shortest length only
applies while details are required.

## Reporting methods

| Method | Who can start it | Reports | What the form has |
|---|---|---|---|
| `/report member [message] [evidence]` | everyone, in the server | a member | reason, own reason, details, files, message links |
| **Apps → Report user** | everyone | a member | reason, own reason, details, files, message links |
| **Apps → Report message** | everyone | the message's author, with the message | reason, own reason, details, files |
| Reaction with the report emoji | everyone who can react there | the message's author, with the message | nothing — see below |

The form shows at most five fields, which is Discord's limit. A field is left out when the server
doesn't use it: no reason list when there are no reasons, no own-reason box when custom reasons are
off, no file field when the file limit is already used by `/report`'s `evidence` option.

- **Message links** takes up to 3 links to messages in the same server, one per line. `/report`'s
  `message` option fills it in. A link to another server, a missing message, or a channel the
  reporter can't read is kept as a link with that status, not read.
- **Report message** captures the message from the interaction itself, so the copy is exact even
  if the author deletes it a second later. It refuses messages from bots, webhooks, system messages
  and the reporter's own.
- **Files** are Discord's form uploads. Proton stores their names, sizes and links, never the files
  themselves. Discord expires those links — see [Discord limits](#discord-limits).

### Reaction reports

A reaction is not an interaction: Discord gives Proton no way to answer the reactor privately in
the channel or open a form for them. So:

1. With **Remove the reaction** on (the default), Proton takes the reaction away first, so the
   reporter isn't visible to everyone. That needs Manage Messages in the channel; without it the
   reaction stays and the failure is logged.
2. If the reaction alone meets the server's requirements — the reaction has a reason, or a reason
   isn't required, and neither details nor a file is required — the report is filed straight away
   and the reactor gets a DM saying so, or saying why it was refused.
3. Otherwise Proton DMs the reactor a **Finish report** button, which opens the form from the DM.
   The button works for an hour; nothing is filed until they finish.
4. If that DM can't be delivered and **Channel fallback** is on, Proton posts a short prompt in the
   channel mentioning the reactor, with the same button. Only they can use it, and it is deleted
   after 2 minutes. Everyone in the channel can see it — that is why it is off by default.
5. If neither reaches them, nothing is filed and nothing is claimed. The worker log says so.

A member reacting to the same message again within 10 minutes of a filed report or a Finish report
button is ignored, though the reaction is still removed. After a refusal — a cooldown, a failed
lookup, closed DMs — they can flag it again straight away, as the refusal tells them to. Each flag is
its own report attempt: flagging a message again after its report was resolved files a new report,
and flagging it while the report is still open is answered by duplicate protection.

Proton checks the reactor against the block list and the who-can-report rule before it reads the
message or looks anyone up, so a blocked reactor costs no Discord calls beyond the reaction removal
and the refusal DM.

### What a report can be refused for

Every refusal tells the member why, in Proton's own words, and never reveals other reporters or the
queue. A refused report is not saved.

- The method, user reports or Moderation is off. While Moderation is off its commands are not
  registered in the server, so Discord doesn't offer them. When only a method or user reports is off,
  Discord still lists the Apps entries and still offers `/report` when members type /; members who
  use one are told it's off. To hide them, switch `/report`, “Report user” and “Report message” off
  on the dashboard's Commands page.
- The reporter is on the blocked reporters list, or fails the who-can-report rule. Administrators
  always pass the role rule, but not the block list.
- The reporter targets themselves, a bot, or a member with a role that can't be reported.
- **Cooldown**: the reporter filed a report too recently; the refusal gives the time they can file
  again. Cooldown bypass roles skip it.
- **Duplicate protection**: the reporter already has an open report about the same member (and the
  same message, for message reports).
- **Open-report limits**: the reported member already has the server's maximum number of open
  reports (10 by default), or the whole server has (100 by default). The member is told plainly;
  staff review the ones waiting.
- Proton couldn't look the member up just then (Discord answered with an error). Nothing is filed;
  the member is asked to try again.
- Proton couldn't save the report (a database error). Nothing is filed; the member is told so and
  offered **Try again**. The worker log names only the database error code, never what they wrote.

## Reviewing reports

### Who can review

Reviewers are the server owner, members with Administrator or Manage Server, and members with a
reviewer role. The same rules apply to the buttons in Discord and to the dashboard; the dashboard
itself stays limited to administrators. Nobody can review a report about themselves, and the
member who filed a report can't accept or dismiss it (the owner excepted).

Punishing from a report or with **Punish author** needs the matching Discord permission as well:
Timeout Members for a warning or timeout, Kick Members for a kick, Ban Members for a ban. Deleting
the reported message needs Manage Messages in the channel it was in. If the Permissions module
restricts `/ban`, `/kick`, `/timeout` or `/warn`, the same restriction applies there. The
choices offered only include what the reviewer may do, and Proton checks again when it runs.

### The staff card

Each report is posted in the report channel as a card: the report id and number, the reported
member (account age, when they joined or that they aren't in the server), who reported them, the
reason, their details, the source channel and a jump link, an excerpt of the reported message, an
evidence summary, how often the member was reported in the last 30 days, and the status. With
**Copy reported messages** on, the reported message is forwarded right below the card.

| Button | Does |
|---|---|
| **Claim** / **Unclaim** | marks the report in review by you; unclaiming needs to be the claimer or have Manage Server |
| **Accept** | opens the punishment picker |
| **Dismiss** | opens a form for an internal note and, if dismissed notifications are on, an explanation for the reporter |
| **View member** | the member's cases and report history, visible only to you |
| **View evidence** | the full message, attachments with their link expiry, linked messages and the reporter's files, visible only to you |

**View evidence** shows a message's text only to a reviewer who can read the channel it came from;
others see "Message in a channel you can't view." A private thread counts as readable only with
Manage Threads (or Administrator), because Proton can't see who was added to it; the same rule
decides whether a message link from a private thread is read at all. Embed titles and sticker names
from the reported message are shown as plain text, never as links. In the dashboard,
administrators see all of it.

**Accept** offers the punishments you may give, plus **No punishment**. Picking one opens a form
with the reason (filled in from the report's reason), a length for timeouts and bans, whether to
delete the reported message, an internal note, and, if accepted notifications are on, a note for
the reporter. **No punishment** can delete the reported message too: it needs Manage Messages in
the message's channel, the deletion is recorded on the report's timeline, and a message that was
already gone still lets the report be accepted. If the deletion fails, the report stays open.
Bans, kicks and anything set to always review ask for confirmation first. If the punishment fails,
the report stays open, its timeline records why, and you can try again, pick another action or
accept without one; a retry sends the member a fresh notice rather than leaving them with the
correction from the failed attempt. When two moderators decide at once, one decision goes through
and the other is told what is already in progress ("This report is already being accepted with a
ban — try again in two minutes."), or who already decided it.

When a report about a message is accepted with a punishment, the reported message is attached to
the case as its proof for 30 days, whether or not **Keep recent messages for cases** is on.

Resolved cards lose their Claim, Accept and Dismiss buttons. There is no reopening.

### In the dashboard

**Moderation → User reports → Queue** lists reports with filters for status, member, reporter,
assignee and date, and can group by member. A report's page shows the evidence, related reports,
linked cases and the timeline, and has **Claim**, **Unclaim**, **Assign to** (administrators),
**Accept…**, **Dismiss…**, and, when the card is in trouble, **Retry delivery** or **Repost**.
Dashboard actions are carried out by the worker with your server permissions and roles. If the
worker doesn't answer within 20 seconds, the page says the action may still complete — refresh
before trying again.

### Closing

Accepted and dismissed reports each have a closing setting: **Keep** the card where it is (the
default), **Move** it to an archive channel, or **Delete** it, optionally after a delay.

- **Move** posts the final card in the archive channel and forwards the copy there, records the
  new places on the report, and only then deletes the originals. The original is never removed
  before the archive copy exists, and **View evidence** and the dashboard link to the copy in the
  archive afterwards.
  - If Discord refuses to forward the copy into the archive, the card still moves but the copy
    stays in the report channel and the report keeps pointing at it.
  - If the forward, or the deletion of the original card, fails for a passing reason (Discord
    errors or rate limits), Proton takes the archive card back, leaves everything where it was and
    tries again later, so a retry never leaves two archive cards.
- **Delete** removes the card and the forwarded copy.
- Closing retries on failure, up to 10 attempts, waiting longer each time (2 minutes, then 4, up to
  an hour). A refusal that won't pass by itself — Proton can't post in the archive channel — is
  retried by the 5-minute patrol instead, so fixing the permission is enough. The dashboard shows a
  card whose closing failed.
- The report itself, its timeline and linked cases are never deleted by closing.

If someone deletes a card by hand, the report is marked as missing its card and the dashboard
offers **Repost**.

## Notifications

Reporters can get a DM when their report is **submitted** (off by default), **accepted** and
**dismissed** (both on). Each message is editable under the Messages tab, with placeholders
(`docs/PLACEHOLDERS.md`). Staff-only details — internal notes, case ids, the dashboard link, report
counts — can't be used in them. A note written for the reporter (on accept or dismiss) is always
delivered with the accepted or dismissed DM: where the message uses `{report.explanation}` it
appears there, and otherwise Proton adds it at the end as **Note from staff**. Internal notes never
leave staff.

Reaction reporters always get a DM with the outcome, because they have no other way to learn it.
When the submitted notification is on, that DM is the server's submitted message.

The reported member is never told about a report, except by an automation DM action or a
punishment DM, and neither can say who reported them.

A DM that can't be delivered (DMs closed, no shared server) is recorded on the report's timeline
and never undoes a report or a decision. Proton tries up to 5 times.

With Server Logs on, **User report filed** and **User report resolved** are posted to the
moderation log channel: ids, method, reason, status, who decided and linked cases — never what the
reporter wrote or the evidence.

## Automation

The Automation tab holds up to 10 rules. A rule watches the reports about one member and, when its
conditions are met, runs up to 5 actions in order.

**Conditions** (at least one):

- **Reports** — at least N reports.
- **Reporters** — at least N different members reported.
- **Unreviewed for** — a report has been open and unclaimed for at least this long.

**Match all** needs every condition set; **match any** needs one. Only reports filed within the
rule's **window** (24 hours by default) with one of its **statuses** (open and in review by default)
count.

**Episodes.** A rule fires once per set of reports. After it fires for a member, only reports filed
after the newest one it counted can set it off again, and they have to meet the conditions on their
own. Re-checking the same reports never fires it twice. A firing that is cancelled partway still
used up its reports.

Rules are checked when a report is filed, when one is resolved, and every 5 minutes for the
**Unreviewed for** condition. Claiming a report doesn't re-check them.

**Actions:**

| Action | Does |
|---|---|
| Alert | posts a staff message (default: in the report channel), pinging up to 10 roles. It can't include what reporters wrote, and can carry link buttons only |
| DM the member | sends the reported member a message, which can't say who reported them |
| Punish | warns, times out, kicks or bans the member as Proton, with a reason. An empty length uses the server's default for that punishment |
| Add role / Remove role | gives or takes a role; recorded as a case |

Before each action Proton re-checks the reports behind the firing. If one was claimed or resolved
so the conditions no longer hold, or the rule was switched off, deleted or changed, or user reports
were switched off, the rest is cancelled and the reason recorded. A firing interrupted by a restart
resumes within the hour without repeating finished actions; older ones are marked failed and not
retried. The Automation tab lists recent firings and what each action did.

**Punishing automatically is risky.** Report counts measure how many people pressed a button, not
whether anything happened. A group can report someone together to get them punished; requiring
several different reporters raises the bar but doesn't stop it. Saving a rule with a Punish action
requires acknowledging this. Prefer alerts; if you punish automatically, choose a mild punishment
and several different reporters. Immune roles (Moderation → Immunity) always protect members from
automatic punishments; role hierarchy doesn't apply to them. With **Confirm when a recent case
exists** on, a punishment that would repeat a recent one is skipped, not retried.

The default rule, **Several members report the same person**, alerts the report channel when three
different members report someone within 24 hours.

## Punish settings

### Per punishment

**Moderation → Punish settings** has a tab for Ban, Kick, Timeout and Warn, each with **When
punishing** and (except Kick) **When lifting**:

- **Require a reason** refuses a moderator who leaves the reason empty.
- **Default reason** fills an empty reason when a reason isn't required.
- **Audit-log reason** is what Discord's audit log shows, as a template. The default is the
  reason itself. Warnings have none: they exist only in Proton. Placeholders are written
  `{punishment.reason}`, `{moderator.username}`, `{moderator.id}`, `{punishment.duration}`,
  `{today}`; a `${...}` placeholder is refused with its Proton equivalent.
- **Ban**: default length (permanent or temporary) and how many days of messages to delete (0–7).
- **Timeout**: default duration (1 hour). Longer than 28 days needs **Extend timeouts**; the limit
  is 365 days. **Multiple timeouts** keeps earlier Proton timeouts running alongside a new one
  instead of replacing them; the member stays timed out until the last one ends.
- **Always review**: slash commands open a review form before punishing.
- **Delete proof message**: after **Punish author**, delete the message once the punishment lands.
- **Add roles / Remove roles / Disconnect from voice** (Timeout and Warn), and **Add roles /
  Remove roles** when lifting.

### More options

- **Extend timeouts** renews Proton's timeouts past Discord's 28-day limit until they end. Only
  timeouts Proton applied are tracked; a timeout removed in Discord is not put back.
- **Punish from a message** adds **Apps → Punish author** to messages, for members with Timeout
  Members. It refuses bots, webhooks and the moderator's own messages. Off, Discord still lists it
  and moderators who use it are told it's off.
- **Confirm when a recent case exists** asks before repeating a punishment given within the window
  (5 minutes by default).
- **Log expired timeouts when the member left** still records a timeout's end if the member is gone.
- **Keep recent messages for cases** holds members' recent messages and attaches the punished
  member's to each case. See [Retention](#retention). The message a member is punished from
  (**Punish author**, or an accepted message report) is attached to the case whether or not this
  is on.

When a punished member rejoins while a Proton timeout should still run, Proton puts it back.

### Immunity

**Use role hierarchy**: moderators can punish only members whose highest role is below their own;
the owner can punish anyone and nobody can punish the owner. The role lists — Everything, Bans,
Kicks, Timeouts, Warnings — protect their members from moderators when hierarchy is off, and from
report automation and warn escalation always.

### Member notifications

Four switches, all off by default: when a member is punished, when a punishment is lifted, when
someone else punishes, when someone else lifts. There is one editable message per punishment and
lift, seven in all.

- Ban and kick messages are sent before the punishment, while the member can still receive them. If
  the punishment then fails, Proton sends a correction.
- Timeout and warning messages are sent after it.
- "Someone else" means a punishment given in Discord or by another bot. Proton learns who from the
  audit log, so it needs View Audit Log. After a ban or kick the member usually shares no server
  with Proton any more, so those rarely arrive.
- Timeouts and warnings from Automod and warn escalation get the "punished" message too. Honeypot,
  Verification, Phishing, Antinuke and Antiraid keep their own notification behaviour.
- The moderator's reply says whether the member was told.

### Predefined reasons

Up to 50 reasons, each with up to 20 short aliases. A moderator who types an alias alone as the
reason gets the full reason. `/ban add`, `/kick`, `/timeout add` and `/warn add` suggest reasons as
you type.

## Permissions

| Permission | Where | What for |
|---|---|---|
| View Channel, Send Messages, Embed Links | report channel, archive channels, alert channels | staff cards, forwarded copies, archive posts, alerts |
| Manage Messages | report and archive channels | closing by move or delete (Proton asks for it even to delete its own cards) |
| Manage Messages | channels members react in | removing the report reaction; deleting the fallback prompt |
| Send Messages | channels members react in | the fallback prompt, when Channel fallback is on |
| Manage Messages | where reported messages are | deleting a reported message on accept, and **Delete proof message** |
| View Channel, Read Message History | where reported and linked messages are | reading linked and reaction-reported messages; forwarding copies |
| Embed Links | the server | DMs with embeds: Proton checks DMs against its server-wide permissions |
| Timeout Members | the server | timeouts, their renewal and removal |
| Kick Members, Ban Members | the server | kicks; bans and unbans |
| Move Members | the server | **Disconnect from voice** |
| Manage Roles | the server, with Proton's role above the roles it gives | role actions on punish, lift and automation |
| View Audit Log | the server | "someone else" notifications |
| Mention Everyone | alert and report channels | only if a role to notify isn't mentionable |

As everywhere in Discord, Proton can't kick, ban, time out or change the roles of a member whose
highest role is at or above its own.

## Intents

Nothing new to enable. Proton already uses **Server Members** (re-applying a timeout when a member
rejoins) and **Message Content** (the text of linked messages, reaction-reported messages and case
message history; Discord also refuses to forward a message the app can't read). Reactions, bans and
audit log entries come through intents that aren't privileged.

## Discord limits

- Discord allows each app 15 user and 15 message Apps entries. Proton uses **Report user**,
  **Report message** and **Punish author**. Servers can hide or restrict them under Server
  Settings → Integrations → Proton.
- A member without Send Messages in a channel can't use **Report user** there: Discord answers
  "Permission Denied" and Proton never hears about it.
- A timed-out member can't use commands or react, so can't report at all.
- Forms hold 5 fields and a select holds 25 options.
- A timeout lasts at most 28 days. **Extend timeouts** renews Proton's own ones.
- Attachment links are signed and expire, and files uploaded through a form are deleted by Discord
  after a while. Proton never downloads them. For a lasting copy of a reported message, keep
  **Copy reported messages** on: the forward is Discord's own snapshot, taken when the report is
  filed.
- Polls, calls and activities can't be forwarded, and forwarding needs View Channel and Read Message
  History where the message is. When a copy can't be made, the card says why.
- Reactions have no private reply. Until the reaction is removed, anyone can see who reacted.
- Members can report messages in channels Proton can't see. Proton gets the message with the report
  but can't forward it, delete it or remove reactions there.

## Retention

| What | Kept |
|---|---|
| The report: who filed it, who it is about, method, reason picked, status, decision, who decided, internal note, linked cases, timeline | until the server's data is deleted on request |
| Copies of the reported and linked messages, attachment names and links, the reporter's details and own reason, the note to the reporter | removed 30 days after the report is resolved, or 90 days after it was filed if sooner |
| Automation firings: rule, member, reports, action outcomes | until the server's data is deleted on request |
| A report form in progress | 15 minutes; 1 hour for a reaction report |
| Staff cards, forwarded copies, archive posts, fallback prompts | Discord messages: until staff or closing delete them; prompts after 2 minutes |
| Recent messages held for cases (Keep recent messages for cases) | up to 5 per member per channel, for an hour; deleted ones 30 minutes |
| Messages attached to a case: the message a member was punished from (always), and their recent messages (with Keep recent messages for cases on) | 30 days |
| Timeout tracking | until the server's data is deleted on request |

The worker's hourly job `moderation:purge-evidence` does the removing, for every server, whether or
not Moderation is still on. After it runs, the report keeps the message ids and link addresses, and
Discord and the dashboard say the evidence was removed, and whether that was 30 days after the
report was resolved or 90 days after it was filed. A note to the reporter written on a report whose
evidence was already removed is sent, then removed by the next hourly run. Switching **Keep recent messages for cases**
off clears the held messages. The privacy page (`/privacy`) makes these same promises; change both
together.

## Turning things off

- **User reports off** (Moderation on): new reports are refused with a reason, automation starts no
  new firings and cancels running ones at their next step. Existing reports can still be reviewed,
  scheduled closings still run, the 5-minute patrol keeps posting waiting cards and finishing
  decisions, and nothing is deleted.
- **A method off**: members who use it are told it's off. Discord keeps listing Apps entries and
  `/report`.
- **Moderation off**: Proton's buttons and menus answer that Moderation is off. Timeout renewals and
  cleanups pause until it is back on.

## Troubleshooting

**The card never appeared.** The report is saved either way. Proton retries every few minutes,
backing off, up to 5 attempts; while Discord is rate-limiting it just waits, and a card still
rate-limited on its last attempt is marked failed. Fix the cause — usually Send Messages or Embed
Links in the report channel, or no report channel — then use **Retry delivery** on the report in
the dashboard. The Overview tab counts delivery problems.

**A card was deleted.** Use **Repost** on the report.

**The copy of the reported message is missing.** The card's evidence line says why: the message was
already deleted, Proton can't read that channel, or Discord refused to forward it.

**Reacting does nothing.** Check that reaction reports are on, the emoji matches, and the channel is
covered. If the reactor's DMs are closed and Channel fallback is off, nothing is filed, and the
worker log says so. If the reaction stays on the message, Proton lacks Manage Messages there.

**A refusal names a permission.** Proton says what it lacks and where, for example Manage Messages in
a channel. Grant it and try again.

**Accept didn't punish.** The reply says why — a missing permission, an immune role, the member left
(kicks, timeouts and warnings need a member; bans don't), or Discord refused. The report stays open;
try again, pick another action, or accept without one.

**"This report is already being accepted (or dismissed) — try again in two minutes."** An accept or
dismiss — possibly your own earlier press — is being carried out. Look at the report again in a
moment; a decision that stalls is released after 2 minutes. "A ban for report … is already under
way" means the punishment may still land: if it hasn't after two minutes, accept the report without
a punishment or use the slash command.

**A reporter or member says they got no DM.** Their DMs are closed or they share no server with
Proton; the report's timeline shows the outcome, and the moderator's reply says whether a punished
member was told. Proton also needs Embed Links in the server to send DMs with embeds.

**A rule fired once and not again.** That is the episode rule: only reports filed after its last
firing count toward the next.

**A long timeout ended early.** Extend timeouts must be on for timeouts over 28 days, and Moderation
must stay on for renewals to run. A timeout removed in Discord is not re-applied.
