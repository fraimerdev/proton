# Placeholders

Placeholders are names in braces, such as `{server.name}`, that Proton replaces with a value each
time it writes a message or a channel name. This page has three parts:

1. [For administrators](#for-administrators): where placeholders work, how to write them, and what
   happens when a value is missing.
2. [For developers](#for-developers): how the system fits together, how to extend it, what was
   settled during the build, and what is deferred.
3. [Reference](#reference): every placeholder, field, modifier and editor note, generated from the
   code.

A *surface* is one thing Proton fills in, such as the Welcome message or a ticket channel name. Each
surface has its own list of placeholders, so a name can be offered in one place and refused in
another.

## For administrators

### Where placeholders work

| Dashboard page | What is filled in | Seen by |
| --- | --- | --- |
| Welcomer: Welcome, Goodbye and Boosts | The text, embeds, layout and link buttons of each message | anyone in the channel |
| Leveling: level-up message | The text, embed and link buttons. A layout saved earlier is filled in too, but on this page it can only be removed | anyone in the channel |
| Honeypot: warning message | The layout's text, images and buttons | anyone in the channel |
| Honeypot: direct message | The layout's text, images and buttons | the member who was caught |
| Tickets: settings and each ticket type | Channel name patterns, and the opening, closing and blacklist messages | names: anyone; messages: the member and staff |
| Tickets: quick responses | The response text | the member and staff |
| Counters | Each counter's name template | anyone |
| Temporary Voice Channels: each creator channel | The name template | anyone |
| Appeals: each form | The accepted and turned-down messages | the member who appealed |
| Giveaways: the `/giveaway` builder in Discord | The message sent to each winner | that winner |
| Messages: templates | Every text field, once **Fill in placeholders** is on | anyone in the channel |

Everywhere else, text is posted exactly as you write it, braces included.
[Where placeholders do not work](#where-placeholders-do-not-work) lists the notable places and why.
Only fields that really fill in placeholders suggest them as you type.

### Writing a placeholder

A placeholder is a name in braces: `{server.name}`.

- Names are lowercase words joined by dots and underscores, exactly as the suggestions show them.
  `{Server.Name}` is not a placeholder.
- No spaces inside the braces. `{ server.name }` is posted as written.
- Modifiers go after a colon and change how the value is written: `{server.member_count:number}`
  writes `1,204`.
- Modifiers apply from left to right, up to four on one placeholder:
  `{user.role_mentions:limit(3):join(" / ")}`.
- Some modifiers take arguments in brackets. An argument is a number or text in double quotes.
  Separate arguments with a comma and **no space**: `{user.is_boosting:label("Booster","Member")}`.
  A space between arguments stops the placeholder from being read. Spaces inside the quotes are
  fine.
- Inside quotes, write `\"` for a quote mark and `\\` for a backslash. A modifier takes at most four
  arguments, each at most 200 characters.
- Anything Proton does not recognise is posted exactly as written: `{nope}` stays `{nope}`.

The easiest way to write one is to type `{` and the start of a name, such as `{us`, and pick from
the suggestions under the cursor; see [Suggestions, notes and previews](#suggestions-notes-and-previews).

### Literal braces

To write a brace that is not part of a placeholder, double it:

| You write | Proton posts |
| --- | --- |
| `{{server.name}}` | `{server.name}` |
| `{{{server.name}}}` | `{Proton HQ}` |
| `a }} b` | `a } b` |

A single `{` or `}` that cannot start or end a placeholder, such as the braces in `{ hello }`, is
also posted as written, but the editor warns about it because it is often a typo.

Doubled braces mean a single brace everywhere placeholders work. Text saved before placeholders
arrived that contains `{{` now posts a single `{`, and the editor warns when you add doubled braces
to a field that had none. Messages templates with **Fill in placeholders** off are not affected:
their braces are always posted as written.

### Modifiers

The [modifier reference](#modifier-reference) lists every modifier, what it works on, and a worked
example in plain text and in message text. In short:

| Modifier | What it does |
| --- | --- |
| `:number`, `:compact`, `:ordinal`, `:percent` | Write a number with thousands separators, as `1.2K`, as `12th`, or as a percentage |
| `:upper`, `:lower` | Change text to capitals or lower case |
| `:truncate(n)` | Keep at most *n* characters, ending in `…` when cut (*n* from 1 to 6,000) |
| `:slug` | Write text as `lowercase-with-dashes` |
| `:relative`, `:full`, `:date`, `:time` | Write a date as "3 days ago", as a long date and time, as a date, or as a time |
| `:unix` | Write a date as seconds since 1 January 1970 |
| `:duration` | Write a length of time in its two largest units, such as `2h 5m` |
| `:fallback("text")` | Use this text when there is no value |
| `:join("separator")`, `:limit(n)`, `:count` | Join a list with a separator, keep its first *n* items (1 to 50), or count its items |
| `:label("yes","no")` | Write one of two texts for a yes-or-no value |

Things to know:

- A modifier that does not suit the value, such as `:upper` on a number, is refused when you save
  and ignored when posting.
- Order matters. Once `:number`, `:date`, `:join` or another modifier has written a value out, it is
  finished text, and a modifier that needs the original value no longer applies after it.
- `:fallback` can go anywhere in the chain. A second `:fallback` on the same placeholder is refused
  when you save, and ignored when posting.
- In message text, `:relative`, `:full`, `:date` and `:time` write Discord timestamps, which each
  reader sees in their own time zone and language. Everywhere else, dates are written in English,
  in UTC.
- In a link, only modifiers that keep a value link-safe are allowed: `:upper`, `:lower`,
  `:truncate`, `:slug`, `:unix`, `:fallback`, `:limit` and `:count`.

### How values are written

The same placeholder is written differently depending on the kind of field. The
[message fields](#message-fields) table gives the kind of every message field.

**Discord message text**: message content, embed titles, descriptions and fields, and layout text.

- Text that members control, such as names, is written so that it cannot add formatting or
  mentions: characters such as `*`, `_`, `|`, `<` and `>` are escaped.
- Mentions are real mentions. Whether they ping follows the message's **Mentions** settings, and
  the editor warns when a placeholder such as `{user.role_mentions}` would ping roles.
- Dates are Discord timestamps.
- `@everyone` and `@here` inside a filled-in value never ping: Proton puts an invisible space after
  the `@`. Text you typed yourself is left alone.

**Plain text**: button labels, embed authors and footers, dropdown text, image descriptions and
ticket channel name patterns.

- Discord shows no formatting here, so nothing is escaped.
- A mention is written as the name: `{user.mention}` shows `Fraimer`.
- Dates are written out, such as `Sep 14, 2026, 9:00 AM`, in UTC.

**Links**: embed links and images, link buttons, and layout images and link buttons.

- Only placeholders that can go in a link are offered: links, image links, text and numbers.
- Text is made link-safe: `https://example.com/?q={server.name}` becomes
  `https://example.com/?q=Proton%20HQ`.
- If a link that contains a placeholder does not come out as an `http://` or `https://` address, it
  is left empty. An optional link, such as an embed image, is then dropped. A link the message
  needs, such as a link button or a layout image, stops the message from being sent.
- A link that contains no placeholders is posted exactly as you saved it.
- A link that starts with anything other than `http://` or `https://`, such as `javascript:`, is
  refused when you save.

**Channel names**:

- Counter and temporary voice channel names: tabs and line breaks become spaces, invisible
  characters are removed except the joiners that hold an emoji together, spaces at either end are
  trimmed, and the name is cut to 100 characters.
- Ticket channel names: the result is lowercased, anything other than `a` to `z`, digits, `-` and
  `_` becomes `-`, and the name is cut to 100 characters. A name that comes out empty becomes
  `ticket`.
- A value is filled in once and never read again as a template. A member whose name is
  `{ticket.number}` gets their name in the channel name, not a ticket number.

**Yes-or-no values** write `Yes` or `No` in every kind of field. Use `:label` for other words.

**Lengths**:

- Every field is cut to Discord's limit once filled in; the [message fields](#message-fields) table
  lists the limits. A cut never splits a character or an emoji, and never leaves half a mention or
  a timestamp.
- A link over its limit is left empty rather than cut.
- When the embeds on one message pass 6,000 characters together, Proton shortens embed
  descriptions first, starting with the last embed, then field text, footers, author names, field
  names and titles.
- A template holds at most 6,000 characters and 100 placeholders, and filled-in text is at most
  6,000 characters before Discord's own limits apply. A list shows at most 50 items.
- Ticket texts, appeal and giveaway direct messages, and Messages button and dropdown replies are
  cut at 2,000 characters.

### When a value is missing

| Situation | What is posted | In the editor |
| --- | --- | --- |
| There is no value, such as `{user.nickname}` for a member without a nickname | Nothing, or the `:fallback` text | Nothing to fix |
| This message never knows the value, such as `{user.nickname}` in a Goodbye message | Nothing, or the fallback | A problem; it is never suggested |
| The value is private to someone who does not see this message, such as a ticket form answer in a channel name | Nothing, or the fallback | A problem; it is never suggested |
| Proton could not read the value, for example because a profile lookup failed | Nothing, or the fallback; the failure is logged | Nothing to fix |
| The name is not a placeholder here | The placeholder, exactly as written | A warning, with a suggestion when a close name exists |
| A reserved name, such as `{constructor}` | Exactly as written | A warning |

Also:

- `0` is a value: `{user.role_count}` writes `0`, not nothing.
- Use `:fallback` for anything that may be empty: `{user.nickname:fallback("no nickname")}`.
- Some older names have fallbacks of their own; see [Older names](#older-names).

**When a whole message cannot be sent.** Filling in can leave a message Discord would refuse: an
embed field or layout text that comes out empty, a button with neither a label nor an emoji, a link
button or layout image without a valid link, a dropdown option with no label, an empty embed, or
two embeds with the same title link. Proton then sends nothing and records which field caused it
and which placeholders that field used, with these exceptions:

- The Honeypot direct message falls back to Proton's own wording, so the member is still told.
- `/message post` tells the person who ran it why nothing was posted.
- A scheduled Messages post that cannot be sent is not retried. A one-off post is dropped, and a
  repeating one keeps its next run.

Previews show the same outcome for their sample: "Proton would post nothing for this sample".

### Suggestions, notes and previews

**Suggestions.** In a field that fills in placeholders, type `{` and the start of a name, and a list
of matching placeholders opens under the line you are typing on.

- It opens once a letter, digit, dot or underscore follows the brace: `{us` opens it, a bare `{`
  does not, and neither does `{{us`, because `{{` is a literal brace. It does not open inside a
  placeholder that already has its closing brace. A space, a `}`, or moving the cursor out of the
  name closes it.
- Suggestions are ranked: names that start with what you typed come first, then older names, then
  names with a later part that starts with it, so `{men` finds `{user.mention}`, then placeholders
  with a word in their label that starts with it. Capital letters make no difference, and at most
  eight are shown.
- An older name is never listed on its own: typing `{memberC` suggests `{server.member_count}`.
- Each suggestion shows the placeholder, its value in the page's sample, and its label.
- Only placeholders that work in that field are suggested. A value the message never knows is never
  suggested, private values are never suggested where others would see them, and link fields only
  suggest link-safe values.
- Ticket form answers are suggested per question: the opening message suggests its ticket type's
  questions, and quick responses suggest every type's questions.
- Keyboard: keep typing to narrow the list, use the Up and Down arrow keys to move (past the last
  suggestion goes back to the first), and Enter or Tab to insert. Escape closes the list without
  changing your text, and it stays closed until you change the name you are typing. While the list
  is closed, Enter, Tab and the arrow keys work as they always do.
- Clicking or tapping a suggestion inserts it and keeps you in the field.
- Inserting replaces what you typed, from the `{` to the end of the name, with the whole
  placeholder, and puts the cursor after the closing brace. Undo (Ctrl+Z) removes it in most
  browsers. If the field has no room left for the whole placeholder, nothing is inserted.
- Modifiers are not suggested. Add them by hand before the closing brace:
  `{server.member_count:number}`.
- Screen readers hear how many suggestions there are when the list opens, and the list is named
  after its field, such as "Placeholders for embed title". On a narrow screen the list is as wide
  as the field.

**Notes under a field.** Proton checks the text as you type, with the same check it runs when you
save.

- **Problems** block saving, but only when you changed that text or added it. Text saved earlier
  never stops you saving something else, such as turning the module on or off. Moving an item in a
  list, such as reordering embeds, counts as changing it.
- **Warnings** and **notes** never block saving.
- [Editor notes](#editor-notes) explains every note.

**Previews** use a labelled sample instead of real people, captioned under the preview, such as
"Sample: Fraimer joining Proton HQ". The samples fit together: Fraimer joins Proton HQ, reaches
level 5, opens Billing ticket #42, which a helper closes, wins Nitro Classic, and gets a voice
channel from "Create a room". A few previews also use a detail you have chosen, such as the
level-up channel's name. Mentions in a preview show the sample's names, such as @Fraimer, and
relative times count from the sample's moment. Previews are filled in by the same code that posts
the real message, and nothing is fetched, saved or posted while you look at one.

### Page by page

**Welcomer**

- The Goodbye message cannot use member details (nickname, roles, join date, boosting), because
  Discord does not send them when someone leaves.
- On the Boost message, `{channel.*}` is the channel where Discord posted the boost notice.
- When Discord leaves a member detail out of a join or boost notice, that placeholder is empty.

**Leveling**

- `{level.rank}`, `{level.messages}`, `{level.voice_seconds}` and `{level.ranked_member_count}` are
  looked up only when the message uses them.
- `{xp.gained}` is empty after `/xp set`.
- `{level.reward_roles}` lists the roles Proton set out to give, so a role it failed to give still
  appears.
- `{level.reward_roles}` and `{level.removed_roles}` ping each role when the message's role pings
  are on, which is the default.
- Role mentions in a plain-text field, such as a button label, come out empty, because Proton does
  not know role names.

**Honeypot**

- The warning message stays in the channel and is only edited when someone is caught or when you
  save. So it offers no clock (`{now}`, `{today}`, `{year}`) and no counts over time;
  `{honeypot.caught}` is its only count.
- `{honeypot.appeal_url}` works only in the direct message, and has a value only when the member
  was banned and an appeal form is chosen. `{honeypot.invite_url}` has a value only when the member
  is offered a way back in.
- On the Free plan Proton sends its built-in layouts, so placeholders in your own layouts are used
  only on a paid plan.
- Honeypot messages never ping anyone.

**Tickets**

- `{user.*}` is the ticket's current owner. After a transfer, `{ticket.opener_mention}` is still the
  person who opened it.
- The channel name pattern in the settings must tell tickets apart. It needs `{ticket.number}`,
  `{user.id}`, `{user.mention}`, `{user.username}`, `{user.global_name}` or `{user.display_name}`,
  or the older `{number}` or `{user}`. A ticket type's own pattern shows a warning instead.
- The subject and form answers are private, so they cannot go in channel names, and form answers
  cannot go in the closing or blacklist messages.
- Form answers show what the member submitted and never change. `{ticket.claimed_by}`,
  `{ticket.assigned_to}` and `{ticket.participant_count}` update when the ticket panel refreshes.
- A form question whose id contains a dot cannot be used as a placeholder.
- Proton adds the block reason, and when the block lifts, after the blacklist message.
- The closing message never pings; a quick response pings only the ticket owner.

**Counters**

- A template needs a count: `{count}`, `{counter.count}`, any `{count.*}` placeholder, or
  `{server.boost_count}`.
- Clocks are refused: a name that changes on its own would use up Discord's rename allowance on
  every refresh.
- Proton refreshes counters every 10 minutes and renames one only when its name actually changes.
  If a name comes out empty, the channel keeps its name and `/counters refresh` says why.
- A counter is not renamed until Proton knows its number.

**Temporary Voice Channels**

- A name template needs the member: `{user.display_name}`, `{user.username}`, `{user.id}` or
  `{user.global_name}`, or the older `{user}`, `{displayName}`, `{username}` or `{userId}`.
- The name is filled in once, when the channel is created, and is not updated afterwards.
- If the name comes out empty, the channel is named after the member.

**Appeals**

- The same message is shown in the direct message and on the appeal page the member sees. Only
  appeal details and the time are offered, because the appeal page does not know the server or the
  member. Dates are Discord timestamps in the direct message and written out on the page.
- Who decided, and the member's answers, are for staff only, so they are refused.
- Proton adds the "Appeal #7" heading and the rejoin line itself, and cuts the direct message at
  2,000 characters.

**Giveaways**

- The winner message is set in the `/giveaway` builder's winners step. Problems are reported when
  you submit that step, and the step is not saved until they are fixed.
- The message is filled in separately for each winner: `{giveaway.prize}` is that winner's prize
  and `{giveaway.winner_position}` is their place in the draw.
- `{giveaway.claim_deadline}` is the claim deadline recorded when that winner was drawn. It is
  empty when winners do not need to claim.
- After a reroll, `{giveaway.ended_at}` is the time of the reroll.
- A winner message saved before these checks existed is not checked again when it is sent.

**Messages**

- Placeholders are filled in only when **Fill in placeholders** is on for that template. When it is
  off, text in braces is posted exactly as written and the template is not checked.
- `/message post` offers the server, Proton, the time, the channel the template is posted in, and
  the person who ran the command (`{actor.*}`). The command does not carry a username or avatar, so
  `{actor.username}` and `{actor.avatar_url}` are empty there.
- Scheduled posts have no one who ran a command, so `{actor.*}` is empty in them, and the editor
  warns about it. `{now}` is the time the post was booked for.
- Replies from buttons and dropdowns also offer `{user.*}`: the member who pressed. Replies are cut
  at 2,000 characters and never ping.
- If a value cannot be read when a scheduled post goes out, the post is sent with that value empty.

### Older names

Before the current names, each page had a few short placeholders such as `{user}` and `{server}`.
They still work on the pages that had them, with the meaning they had there.
[Older names by surface](#older-names-by-surface) lists them all. Suggestions insert the current
names, and typing the start of an older name suggests its current one.

| Where | Older name | Means | When there is no value |
| --- | --- | --- | --- |
| Welcome and Goodbye | `{user}` | A mention of the member | always has one |
| Welcome and Goodbye | `{username}` | The member's display name, or their username (`{user.global_name}`) | `someone` |
| Boost | `{user}` | A mention of the member | always has one |
| Boost | `{username}` | The member's server name, nickname first (`{user.display_name}`) | `someone` |
| Welcome, Goodbye and Boost | `{server}` | The server's name | `this server` |
| Welcome, Goodbye and Boost | `{memberCount}` | The member count | `0` |
| Level-up | `{user}`, `{level}`, `{xp}` | A mention of the member, the new level, and total XP | always has one |
| Honeypot warning | `{consequence}`, `{purge}` | Proton's wording for what happens, and for the messages deleted | always has one |
| Honeypot direct message | `{action}` | Proton's wording for what was done | always has one |
| Honeypot direct message | `{server}` | The server's name | `this server` |
| Ticket channel names | `{number}`, `{type}` | The ticket number and the ticket type's name | always has one |
| Ticket channel names | `{user}` | When the ticket opens: the opener's name, or their id if Proton does not know the name. In the rename box Proton fills in for staff: the owner's id. | always has one |
| Ticket opening message | `{user}` | A mention of the ticket's owner | always has one |
| Counters | `{count}` | This counter's number | the counter is skipped |
| Temporary voice names | `{user}`, `{displayName}` | The member's server name | always has one |
| Temporary voice names | `{username}`, `{userId}` | The member's username and id | always has one |

How older names differ from the current ones:

- In message text they are written exactly as before, without escaping, so a name containing
  formatting characters still formats. The only change is that `@everyone` and `@here` inside them
  no longer ping.
- Because they are not escaped, a display name that contains role mention text can ping that role
  through `{username}` when role pings are on, as it always could. For names members choose, prefer
  the current names, such as `{user.global_name}`.
- In a plain-text field (a button label, an embed footer or author, dropdown text), `{user}` shows
  the member's name instead of `<@123…>`.
- In links, `{server}` and `{username}` are made link-safe, so spaces become `%20`. `{user}`,
  `{consequence}`, `{purge}` and `{action}` cannot go in a link: they are left empty, and adding one
  to a link is refused when you save.
- Proton's default messages still use the older names, so servers that never changed them see the
  same messages as before.

### Changes from before

| What changed | Where |
| --- | --- |
| `{{` and `}}` now write a single literal brace. Before, `{{user}}` wrote `{<@123…>}`. | Every page that fills in placeholders |
| `{name:modifier}` is read as a placeholder. Before, it was posted as written. | Every page that fills in placeholders |
| Braces now mean placeholders in texts that were posted as written before. An unknown `{name}` is still posted as written. | Ticket closing, blacklist and quick response texts; appeal decision messages; giveaway winner messages |
| Templates are unchanged until **Fill in placeholders** is switched on. | Messages |
| Button keys, styles, emoji, colours and other settings that are not text are never filled in. | Welcomer, Leveling, Honeypot |
| `{user}` in a button label, embed footer or author, or dropdown text shows the member's name instead of `<@123…>`, and `{now}` there shows a written-out date. | Welcomer, Leveling |
| Older names in links: `{server}` and `{username}` are made link-safe; `{user}`, `{consequence}`, `{purge}` and `{action}` are left empty and refused when a changed link is saved. Number names such as `{level}` and `{memberCount}` are unchanged. | Link fields on Welcomer, Leveling and Honeypot |
| `@everyone` and `@here` inside a filled-in value no longer ping, older names included. | Every message |
| A link with a placeholder that does not come out as an `http://` or `https://` address is left empty, and a message that needs that link is not sent. A link without placeholders is posted exactly as saved. | Every message |
| Text past Discord's limits is cut at a whole character, never inside a mention, instead of Discord refusing the message. The ticket opening message is still cut at 2,000 characters, but no longer splits an emoji or a mention. | Every message |
| Spaces at either end of a name are trimmed, tabs and line breaks become spaces, a name cut at 100 characters loses a trailing space, and invisible characters other than emoji joiners are removed. A counter whose template has spaces at either end is renamed once on its first refresh; temporary channels are named only when created, so existing ones keep their names. | Counter and temporary voice channel names |
| A value is filled in once: a member or opener name that contains `{…}` is not filled in again. | Ticket channel names, temporary voice channel names |
| Replies are cut at 2,000 characters. | Messages button and dropdown replies, with placeholders on |
| `{server.name}` and the older `{server}` update when the server is renamed, not only when Proton reconnects. | Everywhere |
| A scheduled post whose filled-in template cannot be sent is not retried, and a repeating one keeps its next run. A value that cannot be read is left empty instead of holding the post back. | Messages |
| The channel name pattern accepts any placeholder that identifies the member or the ticket, not only `{number}` and `{user}`. | Tickets |
| Previews show a labelled sample member and server instead of you and your server. | Welcomer, Leveling, Honeypot, Tickets, Counters, Temporary Voice Channels, Appeals |

### Where placeholders do not work

| Where | Why not |
| --- | --- |
| Tags | Tags are written in Discord rather than in the dashboard, and their replies are allowed to ping, so a filled-in name could ping people. |
| Verification panel | It is one shared message that is not about any member, and counts on it would go stale between updates. |
| Ping | The module has no editor, and Proton records no latency or uptime to show. |
| Branding nickname and bio | Proton keeps these matching what you saved, so a value that changes would always look out of date. |
| The `/rolemenu` message option | It is typed once in Discord rather than saved as a template, so its braces are posted as typed. |
| Rules and escalation | Rules do not send messages of their own. |
| Proton's own messages | Starboard, suggestions, AFK, reminders, polls, giveaway announcements, moderation replies, security alerts, server logs and backups use Proton's fixed wording, not templates. |

## For developers

### How it fits together

1. **Engine**: `@proton/core/placeholders` (packages/core/src/placeholders). Browser-safe: it
   imports only zod and type-only message shapes. `parseTemplate` turns text into tokens,
   `createPlaceholderRegistry` holds definitions and aliases, and `validateTemplate` and
   `renderTemplate` bind each token in this order: reserved name, unknown name, modifiers,
   availability, sensitivity, field fit. The engine then looks up the value and writes it for the
   field kind (`discord_text`, `plain_text`, `url`, `channel_name`).
2. **Surface kit**: the same subpath.
   `definePlaceholderSurface({ id, module, label, event, audience, fields, definitions, build, samples, pings })`
   builds and freezes the registry at import, so a bad definition fails boot everywhere.
   `MESSAGE_TEMPLATE_FIELDS` and `REPLY_ACTION_FIELDS` are the allowlists of message paths.
   `renderMessageTemplate` clones the message, renders only those paths, applies
   `enforceMessageLimits`, re-runs the structural checks Discord would apply, and returns
   `{ ok: false, humanReason }` rather than a broken payload. `collectConfigTemplates`,
   `validateConfigTemplates` and `formatTemplateIssues` do the save-time checks. `SAMPLE_*` and
   `SAMPLE_NOW` are the shared samples.
3. **Shared namespaces**: `shared/` provides `userDefinitions` (`user`, `actor`, `moderator`,
   `target`), `serverDefinitions`, `channelDefinitions` (`channel`, `destination_channel`),
   `botDefinitions`, `timeDefinitions` and `eventDefinitions`, with their pure `build*Values`, plus
   `serverFactsFrom`, `countableChannels`, `SHARED_PINGS`, `PROTON_SUPPORT_URL`, `withAliases` and
   `withAvailability`. Shared definitions carry no aliases; each surface adds its own, so `{user}`
   can mean a mention on one surface and a name on another.
4. **Runtime environment**: `@proton/core/placeholder-runtime`, server only.
   `createPlaceholderEnvironment({ applicationId, dashboardUrl, users, guildState })` provides
   `bot()` (cached for six hours; a failed read renders failed and is retried after 60 seconds),
   `server(guildId)` (one GuildState read), `user(userId)` (the users resolver) and `now()`. Only
   apps/worker/src/index.ts imports it, and it passes it as `placeholders` to Welcome, Leveling,
   Honeypot, Tickets, TempVC, Counters, Giveaways and Messages (Messages also gets `guildState`).
   Appeals gets none: its surface resolves from the appeal and the form alone, because the same
   text renders on the appeal web page in apps/api, which has neither GuildState nor the users
   resolver. Modules take only `import type { PlaceholderEnvironment }`; without an environment
   those keys render unavailable and the send still happens.
5. **Module surfaces**: each integrated module exports `./placeholders` (`src/placeholders.ts`)
   with its surfaces, its `ModuleTemplates` and its pure builders. That file may import only
   `@proton/core/placeholders`; type-only `@proton/core`; browser-safe barrel values that the
   module's `config.ts` already imports; zod; its own `config.ts`; and its own import-free files
   such as `constants.ts`. Where `config.ts` value-imports `placeholders.ts` for a refine (Tickets,
   Counters, TempVC), the values both need live in `constants.ts` so there is no cycle. Modules
   never import each other.
6. **Save path**: the manifest's `templates` reach `assertTemplatesValid(manifest, next, before)`
   (apps/api/src/modules/templates.ts), called in `ModuleConfigService.update` after the size check
   and before the transaction. Only `error` diagnostics on paths whose text changed or is new
   block. They throw `ModuleConfigError('invalid_template', …)`, a 400 whose body is
   `path Label: message; …` with every `;` inside a message turned into `,`. `get` never validates,
   so a stored string that newly errors still parses, reaches the worker and renders.
7. **Dashboard**: `useModuleForm({ …, templates })` runs the same `validateConfigTemplates` against
   the last-saved baseline, merges blocking issues into `errors`, refuses `save()` with "Fix the
   marked placeholders before saving." and exposes `templateDiagnosticsAt(path)`. Fields bind
   through `usePlaceholderAutocomplete({ surface, path, onChange, dynamic })`
   (apps/dashboard/src/components/placeholders): the control spreads `autocomplete.field` and
   renders `PlaceholderSuggestions` beside it, which announces the count in a polite live region and
   portals the list to the body above dialogs. `openPlaceholderAt` finds an open `{key` before the
   caret, `suggestionOptions` lists what `surface.pickerFor(path)` offers plus dynamic entries such
   as `ticket.answer.<question_key>`, and `rankSuggestions` orders them (key prefix, alias, dotted
   segment, label word; eight at most). Accepting selects the fragment and inserts with
   `execCommand('insertText')`, falling back to `setRangeText` and one `onChange`, and refuses a
   token that would pass `maxLength`. Fields render `TemplateDiagnostics` for their notes. The
   shared editors take a `placeholders` slot (`EmbedEditor`, `LayoutBuilder`, and `MessageEditor`
   with `placeholderSlot(surface, diagnosticsAt)`). Previews use `previewMessage` and `previewText` in
   apps/dashboard/src/lib/placeholder-preview.ts, which call the surface builder with `SAMPLE_NOW`.
   Both also return `mentionNames`, read from the mention values the sample's lookup gives, and
   `now`. `DiscordPreview` takes both, so a preview writes `<@id>` as the sample's name and counts
   relative timestamps from the sample's moment. Its markdown honours backslash escapes, formats
   `<t:…:style>` by style (in the viewer's time zone once the page has hydrated), and renders embed
   titles and field names with markdown but leaves mentions and timestamps there as written.
   Giveaways has no dashboard: its builder modal runs `validateTemplate` when the winners step is
   submitted.

**Value states**

| State | Produced by | Renders | Diagnostic |
| --- | --- | --- | --- |
| `not_set` | The builder: the source was read and has no value | Nothing, or the fallback | `not_set` (info) |
| `unavailable` | Availability, or the builder: this surface or event cannot know it | Nothing, or the fallback | `unavailable` (error) |
| `restricted` | The engine: the key's sensitivity outranks the audience, so the lookup is never called | Nothing, or the fallback | `restricted` (error) |
| `failed` | The builder, or a lookup that threw | Nothing, or the fallback | `resolver_failed` (error, at render only) |
| `unknown_key` | A lookup that does not know the key | The token as written | `unknown_placeholder` (warning) |

`0` and `false` are values and always render.

**Sensitivity.** `public` < `member_private` < `staff_only`. A key whose sensitivity outranks the
surface's audience is refused before lookup, so a builder never has to hold the data. Register such
a key on every surface where it must be refused: an unregistered key is only an
`unknown_placeholder` warning, so it would save and be posted as written.

**Aliases.** An alias used with no modifiers binds `verbatim` outside `url` fields (bind.ts), which
is what keeps older output byte-identical. `aliasFallbacks` fills an absent value only for the
alias. `aliasValues` overrides the canonical value for the alias; only the Tickets rename pre-fill
uses it.

**Pings.** `surface.pings` maps mention-writing keys to `roles` or `users`, and
`validateConfigTemplates` raises `may_ping` when the site's stored mention settings allow that
kind. Honeypot and the Messages reply surface have none, because they always send with
`parse: []`.

**Lazy reads.** `usedKeys(surface, texts, { allowedOnly: true })` returns the canonical keys a
template uses that the surface does not refuse. Runtimes read GuildState, profiles, rank rows or
form answers only when a key needs them. Idempotency keys are unchanged by any of this.

### Adding a placeholder

1. Add the definition to the surface or shared namespace: a dotted lowercase snake_case `key`, a
   `label`, a `description`, a `group`, a `type` and an `example` of that type. Ids are `text`,
   never `integer`, and dates are epoch milliseconds.
2. Set `sensitivity` when the value is not for everyone, and `availability.events` when only some
   events know it. Register the key on every surface where it must be refused, not only where it
   resolves.
3. Return its value from the surface's pure `build`, using the right absent state. In the module
   runtime, read any costly source only when `usedKeys` contains the key.
4. If it writes mentions that can ping, add it to `pings`.
5. Make sure the surface's sample gives it a value, so suggestions and previews show one.
6. Test rendering, validation and the absent states in the module's `test/placeholders.test.ts`.
7. Regenerate this page with `bun packages/core/scripts/placeholders-doc.ts --write`, and add
   anything administrators need to know to [For administrators](#for-administrators).

### Adding a surface

1. Call `definePlaceholderSurface` in the module's `src/placeholders.ts` and export that file as
   `"./placeholders"` in the module's package.json. For message-shaped settings, map
   `MESSAGE_TEMPLATE_FIELDS` under the config path.
2. Give it an `event` namespaced by the module, an `audience`, labelled `fields` with Discord's
   limits, and at least one sample.
3. For templates stored in guild config, export `ModuleTemplates` and set `templates` on the
   manifest, so the API checks every save.
4. Render at runtime with `renderMessageTemplate` or `renderTemplate`, passing the surface's
   registry, event and audience. Never render a rendered value again, and keep idempotency keys and
   allowed mentions as they were.
5. If it needs server, bot or user facts, add `placeholders?: PlaceholderEnvironment` to the
   module's deps and pass it in apps/worker/src/index.ts.
6. In the dashboard, pass `templates` to `useModuleForm`, wire every field that fills in through
   the placeholder slot or `usePlaceholderAutocomplete`, and move previews to `previewMessage` or
   `previewText`.
7. Bundle the new subpath for the browser and check it pulls in no ioredis, @napi-rs/canvas,
   Drizzle, discord.js runtime or module barrel.
8. Regenerate this page.

### Regenerating the reference

```bash
bun packages/core/scripts/placeholders-doc.ts           # print the generated reference
bun packages/core/scripts/placeholders-doc.ts --write   # replace the generated block below
bun packages/core/scripts/placeholders-doc.ts --check   # exit 1 when this page is out of date
```

The script finds every package under packages/modules whose package.json exports `./placeholders`,
loads that file and nothing else from the module, and collects every surface it exports. Placeholder
examples are rendered by the engine in plain text from each surface's first sample, falling back to
the placeholder's own example. Modifier examples are rendered in plain text and in message text.
Everything between the markers is overwritten; everything outside them is written by hand.

### Settled during the build

These answers and corrections came after the design was written. The code follows them.

- **Older names in links.** A text or number alias in a `url` field is percent-encoded. A markdown
  alias (`{consequence}`, `{purge}`, `{action}`) or a mention alias (`{user}`) is
  `incompatible_field`: it renders empty and blocks a changed save. `legacy_alias_in_url` is raised
  only when `fieldAccepts('url', type)` holds. Byte identity with the old output is claimed for
  non-url fields only.
- **Links without placeholders.** `renderMessageTemplate` posts a non-blank url field that holds no
  placeholder and no `{{` or `}}` exactly as stored, and ignores the engine's `invalid_url` for it,
  because the stored shape accepts links that `isHttpUrl` does not (a space, `"`, `<`, `>`). A link
  that holds a placeholder is still checked, and refused when it does not render to an http or
  https address.
- **Voice channel names keep emoji joiners.** `normaliseChannelName(…, 'voice')` removes
  `\p{Cc}` and `\p{Cf}` except U+200C, U+200D, U+FE0F and the tag characters, then trims and clips
  to 100 without leaving a lone surrogate. Counter and TempVC names therefore also lose other
  invisible characters, such as U+200B and U+200F. Text channel names still strip all of them.
- **Discord Label caps.** Per the Component Reference, a Label's `label` is at most 45 characters
  and its `description` at most 100. The giveaway builder's winner-message hint is 81 characters.
- **`giveaway.claim_deadline`** is the claim deadline recorded with the draw's win rows, read only
  when the message uses it and the giveaway has a claim window; it is not `endedAt` plus the
  window. On a reroll, `giveaway.ended_at` is the publish clock, because a reroll clears `endedAt`
  and leaves `endsAt` at the first deadline.
- **Text display limit.** 4,000 per text display, per the Component Reference. No message-wide V2
  text total is documented, so none is enforced.
- **Boost count freshness.** Discord does not document whether GUILD_UPDATE fires when the boost
  count or tier changes, so `server.boost_count` also re-baselines on reconnect.
  `premium_subscription_count` is documented as optional rather than nullable; `null` is still read
  as none.
- **Ticket name rule.** `namePattern` accepts `{ticket.number}`, `{user.id}`, `{user.mention}`,
  `{user.username}`, `{user.global_name}` or `{user.display_name}`. The literal `{number}` and
  `{user}` check runs first, so a stored `{{number}}` still parses on read.
- **Scheduled refusals.** A refused scheduled render returns `{ action: 'refused', reason, rescheduled }`
  and is not retried. Failed server, bot or GuildState reads post with those values empty and log
  a warning.
- **Read once.** The Honeypot direct message (`directMessageFacts`) reads GuildState once for both
  the server name and the server placeholders. Messages (`readPlaceholderSources`) reads it once
  for both the server and the destination channel.
- **Defaults and sensitivity.** The shipped default messages keep the older names, so servers that
  never saved are unchanged. `appeal.decided_by` stays staff-only.
- **Samples.** `SAMPLE_IDS` has no `server`, `counter` or `appeal` id, so those surfaces borrow
  `member`.

### Surfaces not integrated

| Surface | Reason |
| --- | --- |
| Tags content | No dashboard editor (apps/dashboard/src/pages/tags is read-only); content is written in Discord; replies send with mentions allowed (packages/modules/tags/src/commands.ts), so values would be pingable. |
| Verification panel | One shared message with no member; counts would be stale between reconciles; the send forces `parse: []` but the edit uses the panel's policy (packages/modules/verification/src/service.ts). |
| Ping response | A switch-only module with no editor (apps/dashboard/src/lib/modules/catalogue.ts); no latency or uptime source. |
| Branding nickname and bio | A persistent profile value reconciled against the observed profile (packages/modules/branding/src/profile.ts); a value that changes would always read as drift. |
| `/rolemenu` message option | One-off invoker input, not a stored template; parsing it would expand text typed literally. |
| Rules engine payloads | No rule sends a message (packages/modules/moderation/src/escalation.ts), there is no editor, and the facts are thin. |
| Fixed Proton copy | Starboard, suggestions, AFK, reminders, polls, giveaway announcements, moderation replies, security alerts, serverlog and backup text are written in code, never admin templates. |

### Deferred catalogue

Placeholders that were considered and not offered, with what has to exist first.

| Placeholder or namespace | Missing dependency |
| --- | --- |
| `user` role names, `user.top_role.name`, `user.color_hex` | `GuildRole` has no name or colour (packages/core/src/permissions/compute.ts), and role patches are defined but never applied (apps/worker/src/guild-state-consumer.ts) |
| `user.banner_url` | `banner` on `UserProfile` (packages/core/src/users/profile-cache.ts) |
| `user.first_joined_at`, `user.join_count` | A writer for `members.joined_at` (packages/db/src/schema/members.ts): a migration and an idempotent write on member join |
| Member details on leave (roles, join date) | A join-time record, or the joinroles sticky store |
| `user.timeout_until`, `user.is_pending` | An integrated surface where they mean something |
| `user.before.*`, `user.after.*` | A user-update event type |
| Presence and activity; online, idle and do-not-disturb counts | The Presence intent, which is excluded by decision |
| Per-member boost count and history | A boost ledger |
| `actor.username` on commands, `command.name` | A username and command name on `CommandContext` (packages/core/src/modules/manifest.ts) |
| `user.is_bot` for profiles read through the environment | A `bot` flag on `UserProfile`; until then `user()` never sets it, so it renders `No` |
| `moderator.*`, `target.*`, `case.*` | A member-facing moderation message or an authored moderation surface; `case.number` also needs the recorder to return a number |
| `server.splash_url`, `vanity_code`, `rules_channel`, `system_channel`, `locale` | Those GuildState fields |
| `server.emoji_count`, `sticker_count` | Storage from GUILD_CREATE; the GuildExpressions intent is not requested |
| `server.thread_count` (active) | Storage of `thread_metadata.archived` |
| `server.joins_today`, `leaves_today` | Daily counters in Redis and a decision on where a day starts |
| `server.human_count`, `bot_count`, `booster_count` | A member index, or a full member scan |
| `server.invite_url`, `bot.invite_url` | An invite-create action kind and storage; the bot invite link lives only in the dashboard (apps/dashboard/src/lib/invite.ts) |
| A per-server time zone, and "today" in it | A per-server time zone setting |
| `channel.topic`, `position`, `is_nsfw`, `slowmode`; `thread.owner`, `archived`, `locked` | Those `ChannelState` fields (packages/core/src/guild-state/build.ts) |
| Live `thread.member_count`, `message_count` | A REST read per render and thread-member normalisation |
| `role.name`, `color_hex`, `icon_url`, `member_count` | The `GuildRole` extension, and a member index for the count |
| `message.*` | A surface that consumes a message; on message deletion, author names and embed counts need the cached message schema extended (packages/core/src/messages/content-cache.ts) |
| `bot.latency_ms` | The gateway heartbeat recorded (apps/gateway) |
| `bot.uptime` | Recorded start times |
| `bot.version` | A version injected at build or deploy; every package.json is 0.0.0 |
| `status.*` | Health aggregation, and a decision on what it means |
| `event.type`, `event.module` | A decision on what they mean; `ProtonEvent` has no emitter field |
| `level.previous_rank`, `rank_change` | The rank captured before the XP is awarded |
| `level.xp.multiplier` | The multiplier kept past packages/modules/leveling/src/message-xp.ts; voice has no single value |
| `level.weekly_xp`, `monthly_xp` | An xp column on `member_activity_daily` (packages/modules/leveling/src/activity-table.ts), whose retention is 31 days |
| `level.progress_bar` | A text progress-bar modifier |
| `level.leaderboard_url`, `card_url`, `season` | A member-facing leaderboard page; the rank card is an in-memory attachment; seasons do not exist |
| `ticket.queue_position` | An ordering rule and a rank query over open tickets |
| `ticket.transcript_url` on the closing message | The closing message is sent before the transcript is delivered |
| `ticket.rating`, `feedback` | A surface that is written after the member rates |
| `ticket.response_due_at`, escalation | A service-level or escalation feature |
| `giveaway.claim_url` | Claiming is a button custom id, not a link |
| Giveaway entrants, entries and `reroll.*` in the winner message | A need in the direct message, or another authored giveaway surface |
| `appeal.decision_note` | A reviewer modal: the decision button carries no note |
| `appeal.case.*` | A case id on appeal links (packages/core/src/appeal-link.ts) |
| `user.*`, `server.*`, `bot.*` in appeal decisions | A server and profile read in apps/api, or a field shown only in the direct message, because the same text renders on the appeal web page |
| `count.boosts` beyond `server.boost_count`, `count.emojis`, `stickers`, `in_voice`, `joins_today`, `leaves_today` | GuildState fields, a server-wide voice cache (TempVC occupancy is private to that module) and daily counters |
| `counter.name`, `updated_at`, `goal`, `progress_percent` | Those counter settings, added through a `z.preprocess` lift |
| `count.open_tickets`, `active_giveaways`, `pending_suggestions`, `pending_appeals` | A count port provided by the worker, because modules cannot import modules |
| `count.humans`, `bots`, `boosters`, `role.<id>`, `online` | A member index; the Presence intent |
| `now`, `today`, `year` in counter names | Refused on purpose: they would rename the channel on every refresh |
| `honeypot.caught_last_day`, `caught_last_week`, and the clock on the warning message | A scheduled refresh of the warning message; it is only edited on a catch or a save, so these would freeze |
| `tempvc.name`, `privacy`, `user_limit` after changes; region; occupant order; occupant count at rename | Persisted channel state, `rtcRegion` on the action payload (packages/core/src/actions/payloads.ts), an ordered occupancy set, and re-rendering names after creation |
| `tempvc.session_duration`, `voice_time`, `activity` | A shared voice ledger; the Presence intent |
| `starboard.*`, `suggestion.*`, `rolemenu.*`, `reminder.*`, `poll.*`, `tag.*`, `saved_message.*` | An authored template surface for each; poll votes cannot be read (packages/modules/polls/src/announce.ts); tag arguments need command options |
| `automod.*`, `antiraid.*`, `antinuke.*`, `phishing.*`, serverlog `change.*`, `backup.*`, `verification.*`, `joinroles.*` | An editable surface: all of their output is fixed Proton wording |

### Known gaps

- `clipGraphemes` never leaves half a user, role or channel mention or a timestamp, but it can cut
  a custom emoji (`<:name:id>`) or a command mention (`</name:id>`), and a cut right after an
  escaped `\<@` leaves a trailing backslash.
- A url field whose only content is a text placeholder, such as `{server.name}` in an embed image,
  saves, then refuses the message when it posts.
- Form field ids may contain dots, but a dynamic key segment cannot, so `{ticket.answer.a.b}` is
  `unknown_placeholder` and suggestions leave such questions out.
- `level.reward_roles` and `level.removed_roles` come from the reward plan, not from what the
  executor granted.
- Role mentions in plain-text fields render empty with `mention_without_name`, because GuildState
  roles have no names.
- A giveaway winner message saved before builder validation existed is not re-validated at send.
- `may_ping` judges a scheduled template by its own mention settings, but `withPing` narrows
  mentions at send, so the warning can be a false positive there.
- A counter whose own count is known, but whose template uses another count that is unavailable,
  is still renamed with that placeholder empty.
- Older names stay unescaped in message text, so `{username}` holding role mention text can ping
  that role under the default role pings.
- GuildState: the first deploy replays every stored GUILD_UPDATE into the profile consumer;
  `RedisGuildStateStore.put` is unconditional, so a GUILD_CREATE handled after a newer GUILD_UPDATE
  overwrites the profile; and a GUILD_UPDATE replayed after a RESUME carries a fresh `occurredAt`
  and can roll a name back.
- A Honeypot trap that acts immediately still reads GuildState twice: once in `handleMessage` and
  once in `directMessageFacts`.
- `bot()` renders failed for 60 seconds after an expired profile fails to refresh, instead of
  keeping the last good name.
- `DrizzleMemberXpStore.countRanked` has no database-backed test.

## Reference

Generated from the code; see [Regenerating the reference](#regenerating-the-reference). Surface ids
and event names appear here because they are how the code names each surface. "Discord message
text", "plain text", "link" and "channel name" are the field kinds described in
[How values are written](#how-values-are-written).

<!-- placeholders-doc:start -->

_Generated from the placeholder registries by `bun packages/core/scripts/placeholders-doc.ts --write`. Do not edit between the markers by hand._

### Surfaces

| Module | Surface | Id | Seen by | Offered | Refused |
| --- | --- | --- | --- | --- | --- |
| `appeals` | [Decision message](#decision-message-appealsdecision) | `appeals.decision` | the member it is about | 9 | 2 |
| `counters` | [Counter channel name](#counter-channel-name-counterschannel_name) | `counters.channel_name` | anyone | 9 | 3 |
| `giveaways` | [Winner message](#winner-message-giveawayswin_dm) | `giveaways.win_dm` | the member it is about | 20 | 0 |
| `honeypot` | [Warning message](#warning-message-honeypotnotice) | `honeypot.notice` | anyone | 26 | 4 |
| `honeypot` | [Direct message](#direct-message-honeypotdm) | `honeypot.dm` | the member it is about | 33 | 0 |
| `leveling` | [Level-up announcement](#level-up-announcement-levelinglevel_up) | `leveling.level_up` | anyone | 64 | 0 |
| `messages` | [Posted template](#posted-template-messagespost) | `messages.post` | anyone | 36 | 0 |
| `messages` | [Scheduled template](#scheduled-template-messagesscheduled) | `messages.scheduled` | anyone | 26 | 10 |
| `messages` | [Reply to a press](#reply-to-a-press-messagesreply) | `messages.reply` | anyone | 51 | 0 |
| `tempvc` | [Temporary channel name](#temporary-channel-name-tempvcchannel_name) | `tempvc.channel_name` | anyone | 7 | 0 |
| `tickets` | [Ticket channel name](#ticket-channel-name-ticketschannel_name) | `tickets.channel_name` | anyone | 15 | 2 |
| `tickets` | [Ticket opening message](#ticket-opening-message-ticketswelcome) | `tickets.welcome` | the member it is about | 41 | 0 |
| `tickets` | [Ticket closing message](#ticket-closing-message-ticketsclose) | `tickets.close` | the member it is about | 50 | 1 |
| `tickets` | [Blacklist message](#blacklist-message-ticketsblacklist) | `tickets.blacklist` | the member it is about | 34 | 2 |
| `tickets` | [Quick response](#quick-response-ticketsresponse) | `tickets.response` | the member it is about | 50 | 0 |
| `welcome` | [Welcome message](#welcome-message-welcomejoin) | `welcome.join` | anyone | 42 | 0 |
| `welcome` | [Goodbye message](#goodbye-message-welcomeleave) | `welcome.leave` | anyone | 36 | 6 |
| `welcome` | [Boost message](#boost-message-welcomeboost) | `welcome.boost` | anyone | 47 | 0 |

### Message fields

| Path in the message | Label | Kind | Limit |
| --- | --- | --- | --- |
| `content` | Message text | Discord message text | 2000 |
| `embeds.*.title` | Embed title | Discord message text | 256 |
| `embeds.*.description` | Embed description | Discord message text | 4096 |
| `embeds.*.url` | Embed title link | link | 2048 |
| `embeds.*.author.name` | Embed author | plain text | 256 |
| `embeds.*.author.url` | Embed author link | link | 2048 |
| `embeds.*.author.iconUrl` | Embed author icon | link | 2048 |
| `embeds.*.footer.iconUrl` | Embed footer icon | link | 2048 |
| `embeds.*.imageUrl` | Embed image | link | 2048 |
| `embeds.*.thumbnailUrl` | Embed thumbnail | link | 2048 |
| `embeds.*.footer.text` | Embed footer | plain text | 2048 |
| `embeds.*.fields.*.name` | Embed field name | Discord message text | 256 |
| `embeds.*.fields.*.value` | Embed field text | Discord message text | 1024 |
| `components.*.buttons.*.label` | Button label | plain text | 80 |
| `components.*.buttons.*.url` | Button link | link | 512 |
| `components.*.select.placeholder` | Dropdown placeholder | plain text | 150 |
| `components.*.select.options.*.label` | Dropdown option label | plain text | 100 |
| `components.*.select.options.*.description` | Dropdown option description | plain text | 100 |
| `v2.*.content` | Text | Discord message text | 4000 |
| `v2.*.text.*` | Section line | Discord message text | 4000 |
| `v2.*.accessory.url` | Section image | link |  |
| `v2.*.accessory.description` | Section image description | plain text | 1024 |
| `v2.*.accessory.button.label` | Section button label | plain text | 80 |
| `v2.*.accessory.button.url` | Section button link | link | 512 |
| `v2.*.items.*.url` | Image | link |  |
| `v2.*.items.*.description` | Image description | plain text | 1024 |
| `v2.*.row.buttons.*.label` | Button label | plain text | 80 |
| `v2.*.row.buttons.*.url` | Button link | link | 512 |
| `v2.*.children.*.content` | Text | Discord message text | 4000 |
| `v2.*.children.*.text.*` | Section line | Discord message text | 4000 |
| `v2.*.children.*.accessory.url` | Section image | link |  |
| `v2.*.children.*.accessory.description` | Section image description | plain text | 1024 |
| `v2.*.children.*.accessory.button.label` | Section button label | plain text | 80 |
| `v2.*.children.*.accessory.button.url` | Section button link | link | 512 |
| `v2.*.children.*.items.*.url` | Image | link |  |
| `v2.*.children.*.items.*.description` | Image description | plain text | 1024 |
| `v2.*.children.*.row.buttons.*.label` | Button label | plain text | 80 |
| `v2.*.children.*.row.buttons.*.url` | Button link | link | 512 |

Reply actions, filled in only on Messages templates with placeholders switched on:

| Path in the message | Label | Kind | Limit |
| --- | --- | --- | --- |
| `components.*.buttons.*.action.content` | Reply text | Discord message text | 2000 |
| `components.*.select.options.*.action.content` | Reply text | Discord message text | 2000 |

### Modifier reference

| Modifier | Written as | Works on | In links | Example | In plain text | In message text |
| --- | --- | --- | --- | --- | --- | --- |
| `:number` | `:number` | whole number, number, percentage | no | `{server.member_count:number}` | `1,204` | `1,204` |
| `:compact` | `:compact` | whole number, number | no | `{server.member_count:compact}` | `1.2K` | `1.2K` |
| `:ordinal` | `:ordinal` | whole number | no | `{level.rank:ordinal}` | `12th` | `12th` |
| `:percent` | `:percent` | whole number, number, percentage | no | `{xp.progress_percent:percent}` | `66.86%` | `66.86%` |
| `:upper` | `:upper` | text, formatted text | yes | `{server.name:upper}` | `PROTON HQ` | `PROTON HQ` |
| `:lower` | `:lower` | text, formatted text | yes | `{server.name:lower}` | `proton hq` | `proton hq` |
| `:truncate` | `:truncate(40)` | text, formatted text | yes | `{user.display_name:truncate(8)}` | `Fraimer…` | `Fraimer…` |
| `:slug` | `:slug` | text | yes | `{ticket.type_name:slug}` | `billing-help` | `billing-help` |
| `:relative` | `:relative` | date | no | `{user.joined_at:relative}` | `3 days ago` | `<t:1789117200:R>` |
| `:full` | `:full` | date | no | `{now:full}` | `Monday, September 14, 2026 at 9:00 AM` | `<t:1789376400:F>` |
| `:date` | `:date` | date | no | `{now:date}` | `Sep 14, 2026` | `<t:1789376400:d>` |
| `:time` | `:time` | date | no | `{now:time}` | `9:00 AM` | `<t:1789376400:t>` |
| `:unix` | `:unix` | date | yes | `{event.created_at:unix}` | `1789376400` | `1789376400` |
| `:duration` | `:duration` | duration | no | `{user.account_age:duration}` | `2h 5m` | `2h 5m` |
| `:fallback` | `:fallback("nobody")` | anything | yes | `{user.nickname:fallback("no nickname")}` | `no nickname` | `no nickname` |
| `:join` | `:join(", ")` | lists | no | `{user.role_mentions:join(" / ")}` | `Mods / Level 5 / Helpers` | `<@&100000000000000020> / <@&100000000000000021> / <@&100000000000000022>` |
| `:limit` | `:limit(5)` | lists | yes | `{user.role_mentions:limit(2)}` | `Mods, Level 5` | `<@&100000000000000020>, <@&100000000000000021>` |
| `:count` | `:count` | lists | yes | `{user.role_mentions:count}` | `3` | `3` |
| `:label` | `:label("yes","no")` | yes-or-no value | no | `{user.is_boosting:label("Booster","Member")}` | `Booster` | `Booster` |

### Editor notes

| Code | Kind | Shown | Blocks saving | Meaning |
| --- | --- | --- | --- | --- |
| `template_too_long` | problem | while editing | yes, when that text changed | The text is longer than 6,000 characters, so nothing in it is filled in. |
| `too_many_placeholders` | problem | while editing | yes, when that text changed | The text has more than 100 placeholders. The ones after the 100th are posted as written. |
| `too_many_modifiers` | problem | while editing | yes, when that text changed | A placeholder has more than 4 modifiers, so it is posted as written. |
| `too_many_arguments` | problem | while editing | yes, when that text changed | A modifier is given more than 4 arguments, so the placeholder is posted as written. |
| `argument_too_long` | problem | while editing | yes, when that text changed | A modifier argument is longer than 200 characters, so the placeholder is posted as written. |
| `key_too_long` | problem | while editing | yes, when that text changed | A placeholder name is longer than 200 characters, so it is posted as written. |
| `lone_brace` | warning | while editing | no | A { or } that is not part of a placeholder, often because of a space inside the braces. It is posted as written. |
| `malformed_placeholder` | problem | while editing | yes, when that text changed | A placeholder that is started but not finished: a missing }, ) or closing quote, or a space between arguments. It is posted as written. |
| `forbidden_key` | warning | while editing | no | A reserved name: one that starts with _, or is constructor or prototype. It is posted as written. |
| `unknown_placeholder` | warning | while editing | no | Not a placeholder for this message. It is posted as written, and the note suggests a close name when there is one. |
| `unavailable` | problem | while editing | yes, when that text changed | This message never knows that value, so it is left empty, or shows its fallback. |
| `restricted` | problem | while editing | yes, when that text changed | The value is private to someone who does not see this message, so it is left empty, or shows its fallback. |
| `incompatible_field` | problem | while editing | yes, when that text changed | The value cannot go in this field, such as a mention in a link, so it is left empty, or shows its fallback. |
| `unknown_modifier` | problem | while editing | yes, when that text changed | Not a modifier. It is ignored. |
| `incompatible_modifier` | problem | while editing | yes, when that text changed | The modifier does not work on this value or in this field, or a second :fallback was given. It is ignored. |
| `invalid_argument` | problem | while editing | yes, when that text changed | A modifier is given the wrong arguments. It is ignored. |
| `invalid_value` | problem | when posting, and in previews | no | Proton was handed a value of the wrong kind. It is left empty, or shows its fallback. |
| `resolver_failed` | problem | when posting, and in previews | no | Proton could not read the value, for example because a profile lookup failed. It is left empty, or shows its fallback. |
| `not_set` | note | when posting, and in previews | no | There is no value, such as a member with no nickname. It is left empty, or shows its fallback. |
| `list_truncated` | note | when posting, and in previews | no | A list has more than 50 items. Only the first 50 are shown. |
| `output_truncated` | warning | when posting, and in previews | no | The filled-in text passed a length limit, so the end was cut. |
| `invalid_url` | problem | while editing and when posting | yes, when that text changed | A link does not start with http:// or https://, or does not come out as one once filled in, so it is left empty. |
| `empty_channel_name` | problem | when posting, and in previews | no | A channel name comes out empty once filled in. |
| `mention_without_name` | warning | when posting, and in previews | no | A mention with no readable name, in a field that cannot show mentions. It is left empty. |
| `invalid_locale` | warning | when posting, and in previews | no | Proton was given a language it does not know, so dates and numbers are written in US English. Nothing in the dashboard causes this. |
| `invalid_time_zone` | warning | when posting, and in previews | no | Proton was given a time zone it does not know, so times are written in UTC. Nothing in the dashboard causes this. |
| `may_ping` | warning | while editing | no | The placeholder writes mentions, and this message's mention settings allow those pings, so they will ping. |
| `doubled_brace_literal` | warning | while editing | no | {{ or }} was added. Each now writes a single literal brace. |
| `legacy_alias` | note | while editing | no | An older name. It still works; suggestions insert the current name. |
| `legacy_alias_in_url` | note | while editing | no | An older name in a link. It is written link-safe, so spaces become %20. |
| `plain_text_value` | note | while editing | no | This field cannot show mentions or Discord timestamps, so the placeholder shows a name or a readable date instead. |

### Older names by surface

| Surface | Older name | Current name |
| --- | --- | --- |
| [Counter channel name](#counter-channel-name-counterschannel_name) | `{count}` | `{counter.count}` |
| [Warning message](#warning-message-honeypotnotice) | `{consequence}` | `{honeypot.consequence}` |
| [Warning message](#warning-message-honeypotnotice) | `{purge}` | `{honeypot.purge}` |
| [Direct message](#direct-message-honeypotdm) | `{action}` | `{honeypot.action}` |
| [Direct message](#direct-message-honeypotdm) | `{server}` | `{server.name}` |
| [Level-up announcement](#level-up-announcement-levelinglevel_up) | `{level}` | `{level.current}` |
| [Level-up announcement](#level-up-announcement-levelinglevel_up) | `{xp}` | `{xp.total}` |
| [Level-up announcement](#level-up-announcement-levelinglevel_up) | `{user}` | `{user.mention}` |
| [Temporary channel name](#temporary-channel-name-tempvcchannel_name) | `{userId}` | `{user.id}` |
| [Temporary channel name](#temporary-channel-name-tempvcchannel_name) | `{username}` | `{user.username}` |
| [Temporary channel name](#temporary-channel-name-tempvcchannel_name) | `{user}` | `{user.display_name}` |
| [Temporary channel name](#temporary-channel-name-tempvcchannel_name) | `{displayName}` | `{user.display_name}` |
| [Ticket channel name](#ticket-channel-name-ticketschannel_name) | `{number}` | `{ticket.number}` |
| [Ticket channel name](#ticket-channel-name-ticketschannel_name) | `{type}` | `{ticket.type_name}` |
| [Ticket channel name](#ticket-channel-name-ticketschannel_name) | `{user}` | `{user.global_name}` |
| [Ticket opening message](#ticket-opening-message-ticketswelcome) | `{user}` | `{user.mention}` |
| [Welcome message](#welcome-message-welcomejoin) | `{user}` | `{user.mention}` |
| [Welcome message](#welcome-message-welcomejoin) | `{username}` | `{user.global_name}` |
| [Welcome message](#welcome-message-welcomejoin) | `{server}` | `{server.name}` |
| [Welcome message](#welcome-message-welcomejoin) | `{memberCount}` | `{server.member_count}` |
| [Goodbye message](#goodbye-message-welcomeleave) | `{user}` | `{user.mention}` |
| [Goodbye message](#goodbye-message-welcomeleave) | `{username}` | `{user.global_name}` |
| [Goodbye message](#goodbye-message-welcomeleave) | `{server}` | `{server.name}` |
| [Goodbye message](#goodbye-message-welcomeleave) | `{memberCount}` | `{server.member_count}` |
| [Boost message](#boost-message-welcomeboost) | `{user}` | `{user.mention}` |
| [Boost message](#boost-message-welcomeboost) | `{username}` | `{user.display_name}` |
| [Boost message](#boost-message-welcomeboost) | `{server}` | `{server.name}` |
| [Boost message](#boost-message-welcomeboost) | `{memberCount}` | `{server.member_count}` |

### Placeholders by surface

#### Module `appeals`

##### Decision message (`appeals.decision`)

Seen by the member it is about. Examples come from “Sample: appeal #7 on the Ban appeal form, accepted”, or from the placeholder’s own example where that sample has no value.

Fields:

| Setting | Label | Kind | Limit |
| --- | --- | --- | --- |
| `panels.*.approvedMessage` | Accepted message | Discord message text | 2000 |
| `panels.*.deniedMessage` | Turned-down message | Discord message text | 2000 |

| Placeholder | Label | Group | Type | Example | Description |
| --- | --- | --- | --- | --- | --- |
| `{appeal.number}` | Appeal number | Appeal | whole number | `7` | The number the appeal was filed under |
| `{appeal.status}` | Outcome | Appeal | text | `approved` | The decision as a word: approved or denied |
| `{appeal.form_name}` | Form name | Appeal | text | `Ban appeal` | The name of the appeal form it was filed on |
| `{appeal.filed_at}` | Filed | Appeal | date | `Sep 12, 2026, 9:00 AM` | When the member sent the appeal |
| `{appeal.decided_at}` | Decided | Appeal | date | `Sep 14, 2026, 9:00 AM` | When a moderator accepted or turned down the appeal |
| `{appeal.rejoin_url}` | Rejoin link | Appeal | link | `https://discord.gg/example` | The form's rejoin link. Empty when the form has none. |
| `{now}` | Now | Time | date | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number | `2026` | The current year, in UTC |

Registered here only so that using them is refused when you save, instead of being posted as written:

| Placeholder | Label | Why it is refused |
| --- | --- | --- |
| `{appeal.decided_by}` | Decided by | Private to staff, and this is seen by the member it is about. |
| `{appeal.answer.<key>}` | Answer | Private to staff, and this is seen by the member it is about. |

#### Module `counters`

##### Counter channel name (`counters.channel_name`)

Seen by anyone. Examples come from “Sample count: 1,204”, or from the placeholder’s own example where that sample has no value.

Fields:

| Setting | Label | Kind | Limit |
| --- | --- | --- | --- |
| `counters.*.template` | Name template | channel name | 100 |

| Placeholder | Label | Group | Type | Older name | Example | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `{counter.count}` | This counter's number | Counts | whole number | `{count}` | `1204` | The number this counter counts: its members, roles or channels |
| `{count.members}` | Members | Counts | whole number |  | `1204` | How many members the server has |
| `{count.roles}` | Roles | Counts | whole number |  | `24` | How many roles the server has, not counting @everyone |
| `{count.channels}` | Channels | Counts | whole number |  | `40` | How many channels the server has, not counting categories and threads |
| `{count.text_channels}` | Text channels | Counts | whole number |  | `28` | How many text and announcement channels the server has |
| `{count.voice_channels}` | Voice channels | Counts | whole number |  | `12` | How many voice and stage channels the server has |
| `{server.name}` | Server name | Server | text |  | `Proton HQ` | The server's name |
| `{server.boost_count}` | Boosts | Server | whole number |  | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number |  | `2` | The server's boost level, from 0 to 3 |

Registered here only so that using them is refused when you save, instead of being posted as written:

| Placeholder | Label | Why it is refused |
| --- | --- | --- |
| `{now}` | Now | Not filled in anywhere, on purpose. |
| `{today}` | Today | Not filled in anywhere, on purpose. |
| `{year}` | Year | Not filled in anywhere, on purpose. |

#### Module `giveaways`

##### Winner message (`giveaways.win_dm`)

Seen by the member it is about. Examples come from “Sample: Fraimer winning Nitro Classic in Proton HQ”, or from the placeholder’s own example where that sample has no value.

Fields:

| Setting | Label | Kind | Limit |
| --- | --- | --- | --- |
| `winMessage` | Message sent to winners | Discord message text | 2000 |

| Placeholder | Label | Group | Type | Example | Description |
| --- | --- | --- | --- | --- | --- |
| `{giveaway.title}` | Giveaway title | Giveaway | text | `Nitro Classic` | The title the giveaway was posted under |
| `{giveaway.prize}` | Prize | Giveaway | text | `Nitro Classic` | What this winner won. With several prizes, the one for their place in the draw. |
| `{giveaway.winner_count}` | Winners | Giveaway | whole number | `3` | How many winners this draw picked |
| `{giveaway.winner_position}` | Winner number | Giveaway | whole number | `2` | This winner's place in the draw, counting from 1 |
| `{giveaway.message_url}` | Giveaway link | Giveaway | link | `https://discord.com/channels/100000000000000001/100000000000000040/100000000000000050` | A link to the giveaway message. Empty when the message is gone. |
| `{giveaway.host}` | Host | Giveaway | mention | `Host` | The member who hosted the giveaway |
| `{giveaway.ended_at}` | Ended | Giveaway | date | `Sep 14, 2026, 9:00 AM` | When the giveaway ended |
| `{giveaway.claim_deadline}` | Claim by | Giveaway | date | `Sep 15, 2026, 9:00 AM` | When the prize has to be claimed by. Empty when winners do not need to claim. |
| `{user.id}` | ID | Member | text | `100000000000000010` | Discord user id |
| `{user.mention}` | Mention | Member | mention | `Fraimer` | Pings them where mentions are allowed |
| `{server.name}` | Server name | Server | text | `Proton HQ` | The server's name |
| `{bot.id}` | Proton's ID | Proton | text | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |
| `{now}` | Now | Time | date | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number | `2026` | The current year, in UTC |

#### Module `honeypot`

##### Warning message (`honeypot.notice`)

Seen by anyone. Examples come from “Sample: a trap in Proton HQ that has caught 3”, or from the placeholder’s own example where that sample has no value.

Fields: every layout field (the `v2` rows of the [message fields](#message-fields)), under `noticeLayout`.

| Placeholder | Label | Group | Type | Older name | Not offered in | Example | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `{honeypot.consequence}` | What happens | Honeypot | formatted text | `{consequence}` | link | `you are removed from the server and let straight back in` | What happens to anyone who posts in this channel, in the words the notice uses |
| `{honeypot.purge}` | Messages deleted | Honeypot | formatted text | `{purge}` | link | `Everything you posted in the last 7 days is deleted with you.` | The sentence saying how far back their messages are deleted; empty when nothing is deleted |
| `{honeypot.caught}` | Caught | Honeypot | whole number |  |  | `3` | How many people this channel has caught. Updates when someone is caught. |
| `{server.id}` | Server ID | Server | text |  |  | `100000000000000001` | Discord server id |
| `{server.name}` | Server name | Server | text |  |  | `Proton HQ` | The server's name |
| `{server.member_count}` | Member count | Server | whole number |  |  | `1204` | How many members the server has |
| `{server.owner_mention}` | Owner | Server | mention |  | link | `Owner` | Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default. |
| `{server.role_count}` | Role count | Server | whole number |  |  | `24` | How many roles the server has, not counting @everyone |
| `{server.channel_count}` | Channel count | Server | whole number |  |  | `40` | How many channels the server has, not counting categories and threads |
| `{server.created_at}` | Server created | Server | date |  | link | `Oct 3, 2015, 10:44 PM` | When the server was made |
| `{server.icon_url}` | Server icon | Server | image link |  |  | `https://cdn.discordapp.com/icons/100000000000000001/0a1b2c3d.png?size=256` | The server's icon image; empty when it has none |
| `{server.banner_url}` | Server banner | Server | image link |  |  | `https://cdn.discordapp.com/banners/100000000000000001/0a1b2c3d.png?size=1024` | The server's banner image; empty when it has none |
| `{server.description}` | Description | Server | text |  |  | `Sample server` | The server's description; empty when it has none |
| `{server.boost_count}` | Boosts | Server | whole number |  |  | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number |  |  | `2` | The server's boost level, from 0 to 3 |
| `{channel.id}` | Channel ID | Channel | text |  |  | `100000000000000040` | Discord channel id |
| `{channel.mention}` | Channel | Channel | mention |  | link | `do-not-post` | The channel as a clickable mention; its name where mentions cannot be shown |
| `{channel.name}` | Channel name | Channel | text |  |  | `do-not-post` | The channel's name |
| `{channel.url}` | Channel link | Channel | link |  |  | `https://discord.com/channels/100000000000000001/100000000000000040` | A link that opens the channel |
| `{channel.category_mention}` | Category | Channel | mention |  | link | `Community` | The category the channel sits in; empty when it has none |
| `{bot.id}` | Proton's ID | Proton | text |  |  | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention |  | link | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text |  |  | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link |  |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link |  |  | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link |  |  | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |

Registered here only so that using them is refused when you save, instead of being posted as written:

| Placeholder | Label | Why it is refused |
| --- | --- | --- |
| `{honeypot.appeal_url}` | Appeal link | Private to the member it is about, and this is seen by anyone. |
| `{now}` | Now | Only filled in on: Direct message. |
| `{today}` | Today | Only filled in on: Direct message. |
| `{year}` | Year | Only filled in on: Direct message. |

##### Direct message (`honeypot.dm`)

Seen by the member it is about. Examples come from “Sample: Fraimer caught in Proton HQ”, or from the placeholder’s own example where that sample has no value.

Fields: every layout field (the `v2` rows of the [message fields](#message-fields)), under `dmLayout`.

| Placeholder | Label | Group | Type | Older name | Not offered in | Example | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `{honeypot.action}` | What was done | Honeypot | formatted text | `{action}` | link | `removed from the server, and can rejoin straight away` | What was done to the member, in the words the direct message uses |
| `{honeypot.appeal_url}` | Appeal link | Honeypot | link |  |  | `https://prtn.xyz/appeal/sample` | Where the member appeals their ban. Empty unless they were banned and an appeal form is picked. |
| `{honeypot.invite_url}` | Rejoin link | Honeypot | link |  |  | `https://discord.gg/example` | The invite behind the Rejoin button. Empty unless the server offers a way back in. |
| `{user.id}` | ID | Member | text |  |  | `100000000000000010` | Discord user id |
| `{user.mention}` | Mention | Member | mention |  | link | `Fraimer` | Pings them where mentions are allowed |
| `{user.username}` | Username | Member | text |  |  | `fraimer` | Unique account handle |
| `{user.global_name}` | Display name | Member | text |  |  | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{user.display_name}` | Name in this server | Member | text |  |  | `Fraimer` | Nickname here, else display name, else username |
| `{user.avatar_url}` | Avatar | Member | image link |  |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{user.is_bot}` | Is a bot | Member | yes-or-no value |  | link | `No` | Yes for bot accounts |
| `{user.created_at}` | Account created | Member | date |  | link | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{user.account_age}` | Account age | Member | duration |  | link | `3998d 10h` | How long ago the account was made |
| `{server.id}` | Server ID | Server | text |  |  | `100000000000000001` | Discord server id |
| `{server.name}` | Server name | Server | text | `{server}` |  | `Proton HQ` | The server's name |
| `{server.member_count}` | Member count | Server | whole number |  |  | `1204` | How many members the server has |
| `{server.owner_mention}` | Owner | Server | mention |  | link | `Owner` | Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default. |
| `{server.role_count}` | Role count | Server | whole number |  |  | `24` | How many roles the server has, not counting @everyone |
| `{server.channel_count}` | Channel count | Server | whole number |  |  | `40` | How many channels the server has, not counting categories and threads |
| `{server.created_at}` | Server created | Server | date |  | link | `Oct 3, 2015, 10:44 PM` | When the server was made |
| `{server.icon_url}` | Server icon | Server | image link |  |  | `https://cdn.discordapp.com/icons/100000000000000001/0a1b2c3d.png?size=256` | The server's icon image; empty when it has none |
| `{server.banner_url}` | Server banner | Server | image link |  |  | `https://cdn.discordapp.com/banners/100000000000000001/0a1b2c3d.png?size=1024` | The server's banner image; empty when it has none |
| `{server.description}` | Description | Server | text |  |  | `Sample server` | The server's description; empty when it has none |
| `{server.boost_count}` | Boosts | Server | whole number |  |  | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number |  |  | `2` | The server's boost level, from 0 to 3 |
| `{bot.id}` | Proton's ID | Proton | text |  |  | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention |  | link | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text |  |  | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link |  |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link |  |  | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link |  |  | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |
| `{now}` | Now | Time | date |  | link | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date |  | link | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number |  |  | `2026` | The current year, in UTC |

#### Module `leveling`

##### Level-up announcement (`leveling.level_up`)

Seen by anyone. Examples come from “Sample: Fraimer reaching level 5 in Proton HQ”, or from the placeholder’s own example where that sample has no value.

Fields: every [message field](#message-fields), under `levelUpMessage`.

| Placeholder | Label | Group | Type | Older name | Not offered in | Example | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `{level.current}` | Level | Level | whole number | `{level}` |  | `5` | The level they just reached |
| `{level.previous}` | Previous level | Level | whole number |  |  | `4` | The level they had before this level-up |
| `{level.gained}` | Levels gained | Level | whole number |  |  | `1` | How many levels this level-up jumped |
| `{level.next}` | Next level | Level | whole number |  |  | `6` | The level after this one |
| `{level.is_max}` | Is max level | Level | yes-or-no value |  | link | `No` | Yes when they have reached the highest level |
| `{xp.total}` | Total XP | Level | whole number | `{xp}` |  | `1234` | Their XP in this server |
| `{xp.into_level}` | XP into level | Level | whole number |  |  | `234` | XP earned since reaching this level |
| `{xp.level_span}` | XP for this level | Level | whole number |  |  | `350` | XP between this level and the next |
| `{xp.remaining}` | XP to next level | Level | whole number |  |  | `116` | XP still needed for the next level |
| `{xp.progress_percent}` | Progress | Level | percentage |  | link | `66.86%` | How far they are towards the next level; 0 at the highest level |
| `{xp.gained}` | XP gained | Level | whole number |  |  | `23` | The XP that brought them to this level; empty after /xp set |
| `{level.source}` | How they levelled | Level | text |  |  | `message` | 'message', 'voice' or 'admin' |
| `{level.rank}` | Rank | Level | whole number |  |  | `12` | Their place on this server's leaderboard |
| `{level.messages}` | Messages | Level | whole number |  |  | `812` | How many of their messages have earned XP |
| `{level.voice_seconds}` | Voice time | Level | duration |  | link | `5h` | How long they have earned XP in voice |
| `{level.ranked_member_count}` | Ranked members | Level | whole number |  |  | `480` | How many members of this server have any XP |
| `{level.reward_roles}` | Reward roles | Level | list of mentions |  | link | `Level 5` | The reward roles just given, as mentions. In message text these ping each role whenever this message's mention settings allow role pings, which is the default. |
| `{level.removed_roles}` | Removed roles | Level | list of mentions |  | link | `Level 1` | The reward roles just removed, as mentions. In message text these ping each role whenever this message's mention settings allow role pings, which is the default. |
| `{user.id}` | ID | Member | text |  |  | `100000000000000010` | Discord user id |
| `{user.mention}` | Mention | Member | mention | `{user}` | link | `Fraimer` | Pings them where mentions are allowed |
| `{user.username}` | Username | Member | text |  |  | `fraimer` | Unique account handle |
| `{user.global_name}` | Display name | Member | text |  |  | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{user.display_name}` | Name in this server | Member | text |  |  | `Fraimer` | Nickname here, else display name, else username |
| `{user.avatar_url}` | Avatar | Member | image link |  |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{user.is_bot}` | Is a bot | Member | yes-or-no value |  | link | `No` | Yes for bot accounts |
| `{user.created_at}` | Account created | Member | date |  | link | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{user.account_age}` | Account age | Member | duration |  | link | `3998d 10h` | How long ago the account was made |
| `{user.nickname}` | Nickname | Member | text |  |  | `Fraim` | Server nickname; empty when none |
| `{user.joined_at}` | Joined server | Member | date |  | link | `Sep 14, 2026, 9:00 AM` | When they joined |
| `{user.is_boosting}` | Is boosting | Member | yes-or-no value |  | link | `No` | Yes while boosting |
| `{user.boosting_since}` | Boosting since | Member | date |  | link | `Sep 14, 2026, 9:00 AM` | When their boost began |
| `{user.role_mentions}` | Roles | Member | list of mentions |  | link | `Mods, Level 5` | Their roles as mentions. In message text these ping each role whenever the message's mention settings allow role pings, which is the default. |
| `{user.role_count}` | Role count | Member | whole number |  |  | `1` | How many roles they have |
| `{server.id}` | Server ID | Server | text |  |  | `100000000000000001` | Discord server id |
| `{server.name}` | Server name | Server | text |  |  | `Proton HQ` | The server's name |
| `{server.member_count}` | Member count | Server | whole number |  |  | `1204` | How many members the server has |
| `{server.owner_mention}` | Owner | Server | mention |  | link | `Owner` | Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default. |
| `{server.role_count}` | Role count | Server | whole number |  |  | `24` | How many roles the server has, not counting @everyone |
| `{server.channel_count}` | Channel count | Server | whole number |  |  | `40` | How many channels the server has, not counting categories and threads |
| `{server.created_at}` | Server created | Server | date |  | link | `Oct 3, 2015, 10:44 PM` | When the server was made |
| `{server.icon_url}` | Server icon | Server | image link |  |  | `https://cdn.discordapp.com/icons/100000000000000001/0a1b2c3d.png?size=256` | The server's icon image; empty when it has none |
| `{server.banner_url}` | Server banner | Server | image link |  |  | `https://cdn.discordapp.com/banners/100000000000000001/0a1b2c3d.png?size=1024` | The server's banner image; empty when it has none |
| `{server.description}` | Description | Server | text |  |  | `Sample server` | The server's description; empty when it has none |
| `{server.boost_count}` | Boosts | Server | whole number |  |  | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number |  |  | `2` | The server's boost level, from 0 to 3 |
| `{channel.id}` | Channel ID | Channel | text |  |  | `100000000000000040` | Discord channel id |
| `{channel.mention}` | Channel | Channel | mention |  | link | `general` | The channel as a clickable mention; its name where mentions cannot be shown |
| `{channel.name}` | Channel name | Channel | text |  |  | `general` | The channel's name |
| `{channel.url}` | Channel link | Channel | link |  |  | `https://discord.com/channels/100000000000000001/100000000000000040` | A link that opens the channel |
| `{channel.category_mention}` | Category | Channel | mention |  | link | `Community` | The category the channel sits in; empty when it has none |
| `{destination_channel.id}` | Channel ID | Where it posts | text |  |  | `100000000000000040` | Discord channel id |
| `{destination_channel.mention}` | Channel | Where it posts | mention |  | link | `general` | The channel as a clickable mention; its name where mentions cannot be shown |
| `{destination_channel.name}` | Channel name | Where it posts | text |  |  | `general` | The channel's name |
| `{destination_channel.url}` | Channel link | Where it posts | link |  |  | `https://discord.com/channels/100000000000000001/100000000000000040` | A link that opens the channel |
| `{destination_channel.category_mention}` | Category | Where it posts | mention |  | link | `Community` | The category the channel sits in; empty when it has none |
| `{bot.id}` | Proton's ID | Proton | text |  |  | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention |  | link | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text |  |  | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link |  |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link |  |  | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link |  |  | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |
| `{now}` | Now | Time | date |  | link | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date |  | link | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number |  |  | `2026` | The current year, in UTC |

#### Module `messages`

##### Posted template (`messages.post`)

Seen by anyone. Examples come from “Sample: Fraimer posting in #announcements on Proton HQ”, or from the placeholder’s own example where that sample has no value.

Fields: every [message field](#message-fields), under `templates.*`.

| Placeholder | Label | Group | Type | Not offered in | Example | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `{server.id}` | Server ID | Server | text |  | `100000000000000001` | Discord server id |
| `{server.name}` | Server name | Server | text |  | `Proton HQ` | The server's name |
| `{server.member_count}` | Member count | Server | whole number |  | `1204` | How many members the server has |
| `{server.owner_mention}` | Owner | Server | mention | link | `Owner` | Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default. |
| `{server.role_count}` | Role count | Server | whole number |  | `24` | How many roles the server has, not counting @everyone |
| `{server.channel_count}` | Channel count | Server | whole number |  | `40` | How many channels the server has, not counting categories and threads |
| `{server.created_at}` | Server created | Server | date | link | `Oct 3, 2015, 10:44 PM` | When the server was made |
| `{server.icon_url}` | Server icon | Server | image link |  | `https://cdn.discordapp.com/icons/100000000000000001/0a1b2c3d.png?size=256` | The server's icon image; empty when it has none |
| `{server.banner_url}` | Server banner | Server | image link |  | `https://cdn.discordapp.com/banners/100000000000000001/0a1b2c3d.png?size=1024` | The server's banner image; empty when it has none |
| `{server.description}` | Description | Server | text |  | `Sample server` | The server's description; empty when it has none |
| `{server.boost_count}` | Boosts | Server | whole number |  | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number |  | `2` | The server's boost level, from 0 to 3 |
| `{bot.id}` | Proton's ID | Proton | text |  | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention | link | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text |  | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link |  | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link |  | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |
| `{now}` | Now | Time | date | link | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date | link | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number |  | `2026` | The current year, in UTC |
| `{destination_channel.id}` | Channel ID | Where it posts | text |  | `100000000000000040` | Discord channel id |
| `{destination_channel.mention}` | Channel | Where it posts | mention | link | `announcements` | The channel as a clickable mention; its name where mentions cannot be shown |
| `{destination_channel.name}` | Channel name | Where it posts | text |  | `announcements` | The channel's name |
| `{destination_channel.url}` | Channel link | Where it posts | link |  | `https://discord.com/channels/100000000000000001/100000000000000040` | A link that opens the channel |
| `{destination_channel.category_mention}` | Category | Where it posts | mention | link | `Community` | The category the channel sits in; empty when it has none |
| `{actor.id}` | ID | Who did it | text |  | `100000000000000010` | Discord user id |
| `{actor.mention}` | Mention | Who did it | mention | link | `Fraimer` | Pings them where mentions are allowed |
| `{actor.username}` | Username | Who did it | text |  | `fraimer` | Unique account handle |
| `{actor.global_name}` | Display name | Who did it | text |  | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{actor.display_name}` | Name in this server | Who did it | text |  | `Fraimer` | Nickname here, else display name, else username |
| `{actor.avatar_url}` | Avatar | Who did it | image link |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{actor.is_bot}` | Is a bot | Who did it | yes-or-no value | link | `No` | Yes for bot accounts |
| `{actor.created_at}` | Account created | Who did it | date | link | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{actor.account_age}` | Account age | Who did it | duration | link | `3998d 10h` | How long ago the account was made |
| `{actor.nickname}` | Nickname | Who did it | text |  | `Fraim` | Server nickname; empty when none |

##### Scheduled template (`messages.scheduled`)

Seen by anyone. Examples come from “Sample: a scheduled post in #announcements on Proton HQ”, or from the placeholder’s own example where that sample has no value.

Fields: every [message field](#message-fields), under `templates.*`.

| Placeholder | Label | Group | Type | Not offered in | Example | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `{server.id}` | Server ID | Server | text |  | `100000000000000001` | Discord server id |
| `{server.name}` | Server name | Server | text |  | `Proton HQ` | The server's name |
| `{server.member_count}` | Member count | Server | whole number |  | `1204` | How many members the server has |
| `{server.owner_mention}` | Owner | Server | mention | link | `Owner` | Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default. |
| `{server.role_count}` | Role count | Server | whole number |  | `24` | How many roles the server has, not counting @everyone |
| `{server.channel_count}` | Channel count | Server | whole number |  | `40` | How many channels the server has, not counting categories and threads |
| `{server.created_at}` | Server created | Server | date | link | `Oct 3, 2015, 10:44 PM` | When the server was made |
| `{server.icon_url}` | Server icon | Server | image link |  | `https://cdn.discordapp.com/icons/100000000000000001/0a1b2c3d.png?size=256` | The server's icon image; empty when it has none |
| `{server.banner_url}` | Server banner | Server | image link |  | `https://cdn.discordapp.com/banners/100000000000000001/0a1b2c3d.png?size=1024` | The server's banner image; empty when it has none |
| `{server.description}` | Description | Server | text |  | `Sample server` | The server's description; empty when it has none |
| `{server.boost_count}` | Boosts | Server | whole number |  | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number |  | `2` | The server's boost level, from 0 to 3 |
| `{bot.id}` | Proton's ID | Proton | text |  | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention | link | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text |  | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link |  | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link |  | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |
| `{now}` | Now | Time | date | link | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date | link | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number |  | `2026` | The current year, in UTC |
| `{destination_channel.id}` | Channel ID | Where it posts | text |  | `100000000000000040` | Discord channel id |
| `{destination_channel.mention}` | Channel | Where it posts | mention | link | `announcements` | The channel as a clickable mention; its name where mentions cannot be shown |
| `{destination_channel.name}` | Channel name | Where it posts | text |  | `announcements` | The channel's name |
| `{destination_channel.url}` | Channel link | Where it posts | link |  | `https://discord.com/channels/100000000000000001/100000000000000040` | A link that opens the channel |
| `{destination_channel.category_mention}` | Category | Where it posts | mention | link | `Community` | The category the channel sits in; empty when it has none |

Registered here only so that using them is refused when you save, instead of being posted as written:

| Placeholder | Label | Why it is refused |
| --- | --- | --- |
| `{actor.id}` | ID | Only filled in on: Posted template, Reply to a press. |
| `{actor.mention}` | Mention | Only filled in on: Posted template, Reply to a press. |
| `{actor.username}` | Username | Only filled in on: Posted template, Reply to a press. |
| `{actor.global_name}` | Display name | Only filled in on: Posted template, Reply to a press. |
| `{actor.display_name}` | Name in this server | Only filled in on: Posted template, Reply to a press. |
| `{actor.avatar_url}` | Avatar | Only filled in on: Posted template, Reply to a press. |
| `{actor.is_bot}` | Is a bot | Only filled in on: Posted template, Reply to a press. |
| `{actor.created_at}` | Account created | Only filled in on: Posted template, Reply to a press. |
| `{actor.account_age}` | Account age | Only filled in on: Posted template, Reply to a press. |
| `{actor.nickname}` | Nickname | Only filled in on: Posted template, Reply to a press. |

##### Reply to a press (`messages.reply`)

Seen by anyone. Examples come from “Sample: Fraimer pressing a button in #announcements”, or from the placeholder’s own example where that sample has no value.

Fields: the reply text of buttons and dropdown options (see [message fields](#message-fields)), under `templates.*`.

| Placeholder | Label | Group | Type | Example | Description |
| --- | --- | --- | --- | --- | --- |
| `{server.id}` | Server ID | Server | text | `100000000000000001` | Discord server id |
| `{server.name}` | Server name | Server | text | `Proton HQ` | The server's name |
| `{server.member_count}` | Member count | Server | whole number | `1204` | How many members the server has |
| `{server.owner_mention}` | Owner | Server | mention | `Owner` | Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default. |
| `{server.role_count}` | Role count | Server | whole number | `24` | How many roles the server has, not counting @everyone |
| `{server.channel_count}` | Channel count | Server | whole number | `40` | How many channels the server has, not counting categories and threads |
| `{server.created_at}` | Server created | Server | date | `Oct 3, 2015, 10:44 PM` | When the server was made |
| `{server.icon_url}` | Server icon | Server | image link | `https://cdn.discordapp.com/icons/100000000000000001/0a1b2c3d.png?size=256` | The server's icon image; empty when it has none |
| `{server.banner_url}` | Server banner | Server | image link | `https://cdn.discordapp.com/banners/100000000000000001/0a1b2c3d.png?size=1024` | The server's banner image; empty when it has none |
| `{server.description}` | Description | Server | text | `Sample server` | The server's description; empty when it has none |
| `{server.boost_count}` | Boosts | Server | whole number | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number | `2` | The server's boost level, from 0 to 3 |
| `{bot.id}` | Proton's ID | Proton | text | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |
| `{now}` | Now | Time | date | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number | `2026` | The current year, in UTC |
| `{destination_channel.id}` | Channel ID | Where it posts | text | `100000000000000040` | Discord channel id |
| `{destination_channel.mention}` | Channel | Where it posts | mention | `announcements` | The channel as a clickable mention; its name where mentions cannot be shown |
| `{destination_channel.name}` | Channel name | Where it posts | text | `announcements` | The channel's name |
| `{destination_channel.url}` | Channel link | Where it posts | link | `https://discord.com/channels/100000000000000001/100000000000000040` | A link that opens the channel |
| `{destination_channel.category_mention}` | Category | Where it posts | mention | `Community` | The category the channel sits in; empty when it has none |
| `{actor.id}` | ID | Who did it | text | `100000000000000010` | Discord user id |
| `{actor.mention}` | Mention | Who did it | mention | `Fraimer` | Pings them where mentions are allowed |
| `{actor.username}` | Username | Who did it | text | `fraimer` | Unique account handle |
| `{actor.global_name}` | Display name | Who did it | text | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{actor.display_name}` | Name in this server | Who did it | text | `Fraimer` | Nickname here, else display name, else username |
| `{actor.avatar_url}` | Avatar | Who did it | image link | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{actor.is_bot}` | Is a bot | Who did it | yes-or-no value | `No` | Yes for bot accounts |
| `{actor.created_at}` | Account created | Who did it | date | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{actor.account_age}` | Account age | Who did it | duration | `3998d 10h` | How long ago the account was made |
| `{actor.nickname}` | Nickname | Who did it | text | `Fraim` | Server nickname; empty when none |
| `{user.id}` | ID | Member | text | `100000000000000010` | Discord user id |
| `{user.mention}` | Mention | Member | mention | `Fraimer` | Pings them where mentions are allowed |
| `{user.username}` | Username | Member | text | `fraimer` | Unique account handle |
| `{user.global_name}` | Display name | Member | text | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{user.display_name}` | Name in this server | Member | text | `Fraimer` | Nickname here, else display name, else username |
| `{user.avatar_url}` | Avatar | Member | image link | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{user.is_bot}` | Is a bot | Member | yes-or-no value | `No` | Yes for bot accounts |
| `{user.created_at}` | Account created | Member | date | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{user.account_age}` | Account age | Member | duration | `3998d 10h` | How long ago the account was made |
| `{user.nickname}` | Nickname | Member | text | `Fraim` | Server nickname; empty when none |
| `{user.joined_at}` | Joined server | Member | date | `Sep 14, 2026, 9:00 AM` | When they joined |
| `{user.is_boosting}` | Is boosting | Member | yes-or-no value | `No` | Yes while boosting |
| `{user.boosting_since}` | Boosting since | Member | date | `Sep 14, 2026, 9:00 AM` | When their boost began |
| `{user.role_mentions}` | Roles | Member | list of mentions | `Mods, Level 5` | Their roles as mentions. In message text these ping each role whenever the message's mention settings allow role pings, which is the default. |
| `{user.role_count}` | Role count | Member | whole number | `1` | How many roles they have |

#### Module `tempvc`

##### Temporary channel name (`tempvc.channel_name`)

Seen by anyone. Examples come from “Sample: Fraimer joining Create a room in Proton HQ”, or from the placeholder’s own example where that sample has no value.

Fields:

| Setting | Label | Kind | Limit |
| --- | --- | --- | --- |
| `hubs.*.nameTemplate` | Name template | channel name | 100 |

| Placeholder | Label | Group | Type | Older name | Example | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `{user.id}` | ID | Member | text | `{userId}` | `100000000000000010` | Discord user id |
| `{user.username}` | Username | Member | text | `{username}` | `fraimer` | Unique account handle |
| `{user.global_name}` | Display name | Member | text |  | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{user.display_name}` | Name in this server | Member | text | `{user}` `{displayName}` | `Fraimer` | Nickname here, else display name, else username |
| `{tempvc.hub_name}` | Creator channel name | Creator channel | text |  | `Create a room` | The name of the creator channel they joined |
| `{tempvc.hub_mention}` | Creator channel | Creator channel | mention |  | `Create a room` | The creator channel they joined; a channel name shows its name |
| `{server.name}` | Server name | Server | text |  | `Proton HQ` | The server's name |

#### Module `tickets`

##### Ticket channel name (`tickets.channel_name`)

Seen by anyone. Examples come from “Sample: Fraimer opening Billing ticket #42 in Proton HQ”, or from the placeholder’s own example where that sample has no value.

Fields:

| Setting | Label | Kind | Limit |
| --- | --- | --- | --- |
| `namePattern` | Name pattern | plain text | 100 |
| `types.*.namePattern` | Name pattern | plain text | 100 |

| Placeholder | Label | Group | Type | Older name | Example | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `{ticket.number}` | Ticket number | Ticket | whole number | `{number}` | `42` | The number of this ticket |
| `{ticket.type_name}` | Ticket type | Ticket | text | `{type}` | `Billing` | The name of the ticket type |
| `{user.id}` | ID | Member | text |  | `100000000000000010` | Discord user id |
| `{user.mention}` | Mention | Member | mention |  | `Fraimer` | Pings them where mentions are allowed |
| `{user.username}` | Username | Member | text |  | `fraimer` | Unique account handle |
| `{user.global_name}` | Display name | Member | text | `{user}` | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{user.display_name}` | Name in this server | Member | text |  | `Fraimer` | Nickname here, else display name, else username |
| `{user.avatar_url}` | Avatar | Member | image link |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{user.is_bot}` | Is a bot | Member | yes-or-no value |  | `No` | Yes for bot accounts |
| `{user.created_at}` | Account created | Member | date |  | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{user.account_age}` | Account age | Member | duration |  | `3998d 10h` | How long ago the account was made |
| `{server.name}` | Server name | Server | text |  | `Proton HQ` | The server's name |
| `{now}` | Now | Time | date |  | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date |  | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number |  | `2026` | The current year, in UTC |

Registered here only so that using them is refused when you save, instead of being posted as written:

| Placeholder | Label | Why it is refused |
| --- | --- | --- |
| `{ticket.subject}` | Subject | Private to the member it is about, and this is seen by anyone. |
| `{ticket.answer.<question_key>}` | Form answer | Private to the member it is about, and this is seen by anyone. |

##### Ticket opening message (`tickets.welcome`)

Seen by the member it is about. Examples come from “Sample: Fraimer opening Billing ticket #42 in Proton HQ”, or from the placeholder’s own example where that sample has no value.

Fields:

| Setting | Label | Kind | Limit |
| --- | --- | --- | --- |
| `types.*.welcomeMessage` | Opening message | Discord message text | 2000 |

| Placeholder | Label | Group | Type | Older name | Example | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `{ticket.number}` | Ticket number | Ticket | whole number |  | `42` | The number of this ticket |
| `{ticket.subject}` | Subject | Ticket | text |  | `Refund for order 1182` | The one-line summary the member gave; empty when they gave none |
| `{ticket.opener_mention}` | Opened by | Ticket | mention |  | `Fraimer` | Who opened the ticket. After a transfer this is still the opener; {user.mention} is the current owner. |
| `{ticket.opened_at}` | Opened | Ticket | date |  | `Sep 14, 2026, 7:00 AM` | When the ticket was opened |
| `{ticket.channel_mention}` | Ticket channel | Ticket | mention |  | `ticket-42` | The ticket channel as a clickable mention |
| `{ticket.claimed_by}` | Claimed by | Ticket | mention |  | `Helper` | The staff member who claimed the ticket; empty when nobody has. Updates when the ticket panel refreshes. |
| `{ticket.assigned_to}` | Assigned to | Ticket | mention |  | `Helper` | Who the ticket is assigned to; empty when nobody is. Updates when the ticket panel refreshes. |
| `{ticket.type_name}` | Ticket type | Ticket | text |  | `Billing` | The name of the ticket type |
| `{ticket.priority}` | Priority | Ticket | text |  | `Medium` | Low, Medium, High or Urgent |
| `{ticket.participant_count}` | Participants | Ticket | whole number |  | `1` | How many members are in the ticket, the opener included. Updates when the ticket panel refreshes. |
| `{ticket.answer.<question_key>}` | Form answer | Ticket | text |  | `1182` | The member's answer to one question on the ticket form, named by the question's id, as in {ticket.answer.order} |
| `{user.id}` | ID | Member | text |  | `100000000000000010` | Discord user id |
| `{user.mention}` | Mention | Member | mention | `{user}` | `Fraimer` | Pings them where mentions are allowed |
| `{user.username}` | Username | Member | text |  | `fraimer` | Unique account handle |
| `{user.global_name}` | Display name | Member | text |  | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{user.display_name}` | Name in this server | Member | text |  | `Fraimer` | Nickname here, else display name, else username |
| `{user.avatar_url}` | Avatar | Member | image link |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{user.is_bot}` | Is a bot | Member | yes-or-no value |  | `No` | Yes for bot accounts |
| `{user.created_at}` | Account created | Member | date |  | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{user.account_age}` | Account age | Member | duration |  | `3998d 10h` | How long ago the account was made |
| `{server.id}` | Server ID | Server | text |  | `100000000000000001` | Discord server id |
| `{server.name}` | Server name | Server | text |  | `Proton HQ` | The server's name |
| `{server.member_count}` | Member count | Server | whole number |  | `1204` | How many members the server has |
| `{server.owner_mention}` | Owner | Server | mention |  | `Owner` | Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default. |
| `{server.role_count}` | Role count | Server | whole number |  | `24` | How many roles the server has, not counting @everyone |
| `{server.channel_count}` | Channel count | Server | whole number |  | `40` | How many channels the server has, not counting categories and threads |
| `{server.created_at}` | Server created | Server | date |  | `Oct 3, 2015, 10:44 PM` | When the server was made |
| `{server.icon_url}` | Server icon | Server | image link |  | `https://cdn.discordapp.com/icons/100000000000000001/0a1b2c3d.png?size=256` | The server's icon image; empty when it has none |
| `{server.banner_url}` | Server banner | Server | image link |  | `https://cdn.discordapp.com/banners/100000000000000001/0a1b2c3d.png?size=1024` | The server's banner image; empty when it has none |
| `{server.description}` | Description | Server | text |  | `Sample server` | The server's description; empty when it has none |
| `{server.boost_count}` | Boosts | Server | whole number |  | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number |  | `2` | The server's boost level, from 0 to 3 |
| `{bot.id}` | Proton's ID | Proton | text |  | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention |  | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text |  | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link |  | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link |  | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |
| `{now}` | Now | Time | date |  | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date |  | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number |  | `2026` | The current year, in UTC |

##### Ticket closing message (`tickets.close`)

Seen by the member it is about. Examples come from “Sample: Helper closing Billing ticket #42 in Proton HQ”, or from the placeholder’s own example where that sample has no value.

Fields:

| Setting | Label | Kind | Limit |
| --- | --- | --- | --- |
| `closeConfirmation` | Closing message | Discord message text | 2000 |

| Placeholder | Label | Group | Type | Example | Description |
| --- | --- | --- | --- | --- | --- |
| `{ticket.number}` | Ticket number | Ticket | whole number | `42` | The number of this ticket |
| `{ticket.subject}` | Subject | Ticket | text | `Refund for order 1182` | The one-line summary the member gave; empty when they gave none |
| `{ticket.opener_mention}` | Opened by | Ticket | mention | `Fraimer` | Who opened the ticket. After a transfer this is still the opener; {user.mention} is the current owner. |
| `{ticket.opened_at}` | Opened | Ticket | date | `Sep 14, 2026, 7:00 AM` | When the ticket was opened |
| `{ticket.channel_mention}` | Ticket channel | Ticket | mention | `ticket-42` | The ticket channel as a clickable mention |
| `{ticket.claimed_by}` | Claimed by | Ticket | mention | `Helper` | The staff member who claimed the ticket; empty when nobody has. Updates when the ticket panel refreshes. |
| `{ticket.assigned_to}` | Assigned to | Ticket | mention | `Helper` | Who the ticket is assigned to; empty when nobody is. Updates when the ticket panel refreshes. |
| `{ticket.type_name}` | Ticket type | Ticket | text | `Billing` | The name of the ticket type |
| `{ticket.priority}` | Priority | Ticket | text | `Medium` | Low, Medium, High or Urgent |
| `{ticket.closed_by}` | Closed by | Ticket | mention | `Helper` | Who closed the ticket |
| `{ticket.close_reason}` | Close reason | Ticket | text | `Refund issued` | Why the ticket was closed; empty when no reason was given |
| `{user.id}` | ID | Member | text | `100000000000000010` | Discord user id |
| `{user.mention}` | Mention | Member | mention | `Fraimer` | Pings them where mentions are allowed |
| `{user.username}` | Username | Member | text | `fraimer` | Unique account handle |
| `{user.global_name}` | Display name | Member | text | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{user.display_name}` | Name in this server | Member | text | `Fraimer` | Nickname here, else display name, else username |
| `{user.avatar_url}` | Avatar | Member | image link | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{user.is_bot}` | Is a bot | Member | yes-or-no value | `No` | Yes for bot accounts |
| `{user.created_at}` | Account created | Member | date | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{user.account_age}` | Account age | Member | duration | `3998d 10h` | How long ago the account was made |
| `{actor.id}` | ID | Who did it | text | `100000000000000030` | Discord user id |
| `{actor.mention}` | Mention | Who did it | mention | `Helper` | Pings them where mentions are allowed |
| `{actor.username}` | Username | Who did it | text | `helper` | Unique account handle |
| `{actor.global_name}` | Display name | Who did it | text | `Helper` | Account display name, or the username when none is set (as Discord shows it) |
| `{actor.display_name}` | Name in this server | Who did it | text | `Helper` | Nickname here, else display name, else username |
| `{actor.avatar_url}` | Avatar | Who did it | image link | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{actor.is_bot}` | Is a bot | Who did it | yes-or-no value | `No` | Yes for bot accounts |
| `{actor.created_at}` | Account created | Who did it | date | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{actor.account_age}` | Account age | Who did it | duration | `3998d 10h` | How long ago the account was made |
| `{server.id}` | Server ID | Server | text | `100000000000000001` | Discord server id |
| `{server.name}` | Server name | Server | text | `Proton HQ` | The server's name |
| `{server.member_count}` | Member count | Server | whole number | `1204` | How many members the server has |
| `{server.owner_mention}` | Owner | Server | mention | `Owner` | Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default. |
| `{server.role_count}` | Role count | Server | whole number | `24` | How many roles the server has, not counting @everyone |
| `{server.channel_count}` | Channel count | Server | whole number | `40` | How many channels the server has, not counting categories and threads |
| `{server.created_at}` | Server created | Server | date | `Oct 3, 2015, 10:44 PM` | When the server was made |
| `{server.icon_url}` | Server icon | Server | image link | `https://cdn.discordapp.com/icons/100000000000000001/0a1b2c3d.png?size=256` | The server's icon image; empty when it has none |
| `{server.banner_url}` | Server banner | Server | image link | `https://cdn.discordapp.com/banners/100000000000000001/0a1b2c3d.png?size=1024` | The server's banner image; empty when it has none |
| `{server.description}` | Description | Server | text | `Sample server` | The server's description; empty when it has none |
| `{server.boost_count}` | Boosts | Server | whole number | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number | `2` | The server's boost level, from 0 to 3 |
| `{bot.id}` | Proton's ID | Proton | text | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |
| `{now}` | Now | Time | date | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number | `2026` | The current year, in UTC |

Registered here only so that using them is refused when you save, instead of being posted as written:

| Placeholder | Label | Why it is refused |
| --- | --- | --- |
| `{ticket.answer.<question_key>}` | Form answer | Only filled in on: Ticket opening message, Quick response. |

##### Blacklist message (`tickets.blacklist`)

Seen by the member it is about. Examples come from “Sample: Fraimer blocked from opening a Billing ticket”, or from the placeholder’s own example where that sample has no value.

Fields:

| Setting | Label | Kind | Limit |
| --- | --- | --- | --- |
| `blacklistMessage` | Blacklist message | Discord message text | 2000 |

| Placeholder | Label | Group | Type | Example | Description |
| --- | --- | --- | --- | --- | --- |
| `{ticket.type_name}` | Ticket type | Ticket | text | `Billing` | The name of the ticket type |
| `{ticket.priority}` | Priority | Ticket | text | `Medium` | Low, Medium, High or Urgent |
| `{ticket.blacklist_reason}` | Block reason | Ticket | text | `Spamming tickets` | Why the member may not open tickets; empty when no reason was given |
| `{ticket.blacklist_expires_at}` | Block lifts | Ticket | date | `Sep 21, 2026, 9:00 AM` | When the member may open tickets again; empty when the block is permanent |
| `{user.id}` | ID | Member | text | `100000000000000010` | Discord user id |
| `{user.mention}` | Mention | Member | mention | `Fraimer` | Pings them where mentions are allowed |
| `{user.username}` | Username | Member | text | `fraimer` | Unique account handle |
| `{user.global_name}` | Display name | Member | text | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{user.display_name}` | Name in this server | Member | text | `Fraimer` | Nickname here, else display name, else username |
| `{user.avatar_url}` | Avatar | Member | image link | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{user.is_bot}` | Is a bot | Member | yes-or-no value | `No` | Yes for bot accounts |
| `{user.created_at}` | Account created | Member | date | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{user.account_age}` | Account age | Member | duration | `3998d 10h` | How long ago the account was made |
| `{server.id}` | Server ID | Server | text | `100000000000000001` | Discord server id |
| `{server.name}` | Server name | Server | text | `Proton HQ` | The server's name |
| `{server.member_count}` | Member count | Server | whole number | `1204` | How many members the server has |
| `{server.owner_mention}` | Owner | Server | mention | `Owner` | Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default. |
| `{server.role_count}` | Role count | Server | whole number | `24` | How many roles the server has, not counting @everyone |
| `{server.channel_count}` | Channel count | Server | whole number | `40` | How many channels the server has, not counting categories and threads |
| `{server.created_at}` | Server created | Server | date | `Oct 3, 2015, 10:44 PM` | When the server was made |
| `{server.icon_url}` | Server icon | Server | image link | `https://cdn.discordapp.com/icons/100000000000000001/0a1b2c3d.png?size=256` | The server's icon image; empty when it has none |
| `{server.banner_url}` | Server banner | Server | image link | `https://cdn.discordapp.com/banners/100000000000000001/0a1b2c3d.png?size=1024` | The server's banner image; empty when it has none |
| `{server.description}` | Description | Server | text | `Sample server` | The server's description; empty when it has none |
| `{server.boost_count}` | Boosts | Server | whole number | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number | `2` | The server's boost level, from 0 to 3 |
| `{bot.id}` | Proton's ID | Proton | text | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |
| `{now}` | Now | Time | date | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number | `2026` | The current year, in UTC |

Registered here only so that using them is refused when you save, instead of being posted as written:

| Placeholder | Label | Why it is refused |
| --- | --- | --- |
| `{ticket.number}` | Ticket number | Only filled in on: Ticket opening message, Ticket closing message, Quick response. |
| `{ticket.answer.<question_key>}` | Form answer | Only filled in on: Ticket opening message, Quick response. |

##### Quick response (`tickets.response`)

Seen by the member it is about. Examples come from “Sample: Helper replying in Billing ticket #42 in Proton HQ”, or from the placeholder’s own example where that sample has no value.

Fields:

| Setting | Label | Kind | Limit |
| --- | --- | --- | --- |
| `responses.*.content` | Response text | Discord message text | 2000 |

| Placeholder | Label | Group | Type | Example | Description |
| --- | --- | --- | --- | --- | --- |
| `{ticket.number}` | Ticket number | Ticket | whole number | `42` | The number of this ticket |
| `{ticket.subject}` | Subject | Ticket | text | `Refund for order 1182` | The one-line summary the member gave; empty when they gave none |
| `{ticket.opener_mention}` | Opened by | Ticket | mention | `Fraimer` | Who opened the ticket. After a transfer this is still the opener; {user.mention} is the current owner. |
| `{ticket.opened_at}` | Opened | Ticket | date | `Sep 14, 2026, 7:00 AM` | When the ticket was opened |
| `{ticket.channel_mention}` | Ticket channel | Ticket | mention | `ticket-42` | The ticket channel as a clickable mention |
| `{ticket.claimed_by}` | Claimed by | Ticket | mention | `Helper` | The staff member who claimed the ticket; empty when nobody has. Updates when the ticket panel refreshes. |
| `{ticket.assigned_to}` | Assigned to | Ticket | mention | `Helper` | Who the ticket is assigned to; empty when nobody is. Updates when the ticket panel refreshes. |
| `{ticket.type_name}` | Ticket type | Ticket | text | `Billing` | The name of the ticket type |
| `{ticket.priority}` | Priority | Ticket | text | `Medium` | Low, Medium, High or Urgent |
| `{ticket.participant_count}` | Participants | Ticket | whole number | `1` | How many members are in the ticket, the opener included. Updates when the ticket panel refreshes. |
| `{ticket.answer.<question_key>}` | Form answer | Ticket | text | `1182` | The member's answer to one question on the ticket form, named by the question's id, as in {ticket.answer.order} |
| `{user.id}` | ID | Member | text | `100000000000000010` | Discord user id |
| `{user.mention}` | Mention | Member | mention | `Fraimer` | Pings them where mentions are allowed |
| `{user.username}` | Username | Member | text | `fraimer` | Unique account handle |
| `{user.global_name}` | Display name | Member | text | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{user.display_name}` | Name in this server | Member | text | `Fraimer` | Nickname here, else display name, else username |
| `{user.avatar_url}` | Avatar | Member | image link | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{user.is_bot}` | Is a bot | Member | yes-or-no value | `No` | Yes for bot accounts |
| `{user.created_at}` | Account created | Member | date | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{user.account_age}` | Account age | Member | duration | `3998d 10h` | How long ago the account was made |
| `{actor.id}` | ID | Who did it | text | `100000000000000030` | Discord user id |
| `{actor.mention}` | Mention | Who did it | mention | `Helper` | Pings them where mentions are allowed |
| `{actor.username}` | Username | Who did it | text | `helper` | Unique account handle |
| `{actor.global_name}` | Display name | Who did it | text | `Helper` | Account display name, or the username when none is set (as Discord shows it) |
| `{actor.display_name}` | Name in this server | Who did it | text | `Helper` | Nickname here, else display name, else username |
| `{actor.avatar_url}` | Avatar | Who did it | image link | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{actor.is_bot}` | Is a bot | Who did it | yes-or-no value | `No` | Yes for bot accounts |
| `{actor.created_at}` | Account created | Who did it | date | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{actor.account_age}` | Account age | Who did it | duration | `3998d 10h` | How long ago the account was made |
| `{server.id}` | Server ID | Server | text | `100000000000000001` | Discord server id |
| `{server.name}` | Server name | Server | text | `Proton HQ` | The server's name |
| `{server.member_count}` | Member count | Server | whole number | `1204` | How many members the server has |
| `{server.owner_mention}` | Owner | Server | mention | `Owner` | Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default. |
| `{server.role_count}` | Role count | Server | whole number | `24` | How many roles the server has, not counting @everyone |
| `{server.channel_count}` | Channel count | Server | whole number | `40` | How many channels the server has, not counting categories and threads |
| `{server.created_at}` | Server created | Server | date | `Oct 3, 2015, 10:44 PM` | When the server was made |
| `{server.icon_url}` | Server icon | Server | image link | `https://cdn.discordapp.com/icons/100000000000000001/0a1b2c3d.png?size=256` | The server's icon image; empty when it has none |
| `{server.banner_url}` | Server banner | Server | image link | `https://cdn.discordapp.com/banners/100000000000000001/0a1b2c3d.png?size=1024` | The server's banner image; empty when it has none |
| `{server.description}` | Description | Server | text | `Sample server` | The server's description; empty when it has none |
| `{server.boost_count}` | Boosts | Server | whole number | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number | `2` | The server's boost level, from 0 to 3 |
| `{bot.id}` | Proton's ID | Proton | text | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |
| `{now}` | Now | Time | date | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number | `2026` | The current year, in UTC |

#### Module `welcome`

##### Welcome message (`welcome.join`)

Seen by anyone. Examples come from “Sample: Fraimer joining Proton HQ”, or from the placeholder’s own example where that sample has no value.

Fields: every [message field](#message-fields), under `welcomeMessage`.

| Placeholder | Label | Group | Type | Older name | Not offered in | Example | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `{user.id}` | ID | Member | text |  |  | `100000000000000010` | Discord user id |
| `{user.mention}` | Mention | Member | mention | `{user}` | link | `Fraimer` | Pings them where mentions are allowed |
| `{user.username}` | Username | Member | text |  |  | `fraimer` | Unique account handle |
| `{user.global_name}` | Display name | Member | text | `{username}` |  | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{user.display_name}` | Name in this server | Member | text |  |  | `Fraimer` | Nickname here, else display name, else username |
| `{user.avatar_url}` | Avatar | Member | image link |  |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{user.is_bot}` | Is a bot | Member | yes-or-no value |  | link | `No` | Yes for bot accounts |
| `{user.created_at}` | Account created | Member | date |  | link | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{user.account_age}` | Account age | Member | duration |  | link | `3998d 10h` | How long ago the account was made |
| `{user.nickname}` | Nickname | Member | text |  |  | `Fraim` | Server nickname; empty when none |
| `{user.joined_at}` | Joined server | Member | date |  | link | `Sep 14, 2026, 9:00 AM` | When they joined |
| `{user.is_boosting}` | Is boosting | Member | yes-or-no value |  | link | `No` | Yes while boosting |
| `{user.boosting_since}` | Boosting since | Member | date |  | link | `Sep 14, 2026, 9:00 AM` | When their boost began |
| `{user.role_mentions}` | Roles | Member | list of mentions |  | link | `Mods, Level 5` | Their roles as mentions. In message text these ping each role whenever the message's mention settings allow role pings, which is the default. |
| `{user.role_count}` | Role count | Member | whole number |  |  | `1` | How many roles they have |
| `{server.id}` | Server ID | Server | text |  |  | `100000000000000001` | Discord server id |
| `{server.name}` | Server name | Server | text | `{server}` |  | `Proton HQ` | The server's name |
| `{server.member_count}` | Member count | Server | whole number | `{memberCount}` |  | `1204` | How many members the server has |
| `{server.owner_mention}` | Owner | Server | mention |  | link | `Owner` | Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default. |
| `{server.role_count}` | Role count | Server | whole number |  |  | `24` | How many roles the server has, not counting @everyone |
| `{server.channel_count}` | Channel count | Server | whole number |  |  | `40` | How many channels the server has, not counting categories and threads |
| `{server.created_at}` | Server created | Server | date |  | link | `Oct 3, 2015, 10:44 PM` | When the server was made |
| `{server.icon_url}` | Server icon | Server | image link |  |  | `https://cdn.discordapp.com/icons/100000000000000001/0a1b2c3d.png?size=256` | The server's icon image; empty when it has none |
| `{server.banner_url}` | Server banner | Server | image link |  |  | `https://cdn.discordapp.com/banners/100000000000000001/0a1b2c3d.png?size=1024` | The server's banner image; empty when it has none |
| `{server.description}` | Description | Server | text |  |  | `Sample server` | The server's description; empty when it has none |
| `{server.boost_count}` | Boosts | Server | whole number |  |  | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number |  |  | `2` | The server's boost level, from 0 to 3 |
| `{destination_channel.id}` | Channel ID | Where it posts | text |  |  | `100000000000000040` | Discord channel id |
| `{destination_channel.mention}` | Channel | Where it posts | mention |  | link | `welcome` | The channel as a clickable mention; its name where mentions cannot be shown |
| `{destination_channel.name}` | Channel name | Where it posts | text |  |  | `welcome` | The channel's name |
| `{destination_channel.url}` | Channel link | Where it posts | link |  |  | `https://discord.com/channels/100000000000000001/100000000000000040` | A link that opens the channel |
| `{destination_channel.category_mention}` | Category | Where it posts | mention |  | link | `Community` | The category the channel sits in; empty when it has none |
| `{bot.id}` | Proton's ID | Proton | text |  |  | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention |  | link | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text |  |  | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link |  |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link |  |  | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link |  |  | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |
| `{now}` | Now | Time | date |  | link | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date |  | link | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number |  |  | `2026` | The current year, in UTC |
| `{event.created_at}` | When it happened | Event | date |  | link | `Sep 14, 2026, 9:00 AM` | When the event behind this message happened |

##### Goodbye message (`welcome.leave`)

Seen by anyone. Examples come from “Sample: Fraimer leaving Proton HQ”, or from the placeholder’s own example where that sample has no value.

Fields: every [message field](#message-fields), under `goodbyeMessage`.

| Placeholder | Label | Group | Type | Older name | Not offered in | Example | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `{user.id}` | ID | Member | text |  |  | `100000000000000010` | Discord user id |
| `{user.mention}` | Mention | Member | mention | `{user}` | link | `Fraimer` | Pings them where mentions are allowed |
| `{user.username}` | Username | Member | text |  |  | `fraimer` | Unique account handle |
| `{user.global_name}` | Display name | Member | text | `{username}` |  | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{user.display_name}` | Name in this server | Member | text |  |  | `Fraimer` | Nickname here, else display name, else username |
| `{user.avatar_url}` | Avatar | Member | image link |  |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{user.is_bot}` | Is a bot | Member | yes-or-no value |  | link | `No` | Yes for bot accounts |
| `{user.created_at}` | Account created | Member | date |  | link | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{user.account_age}` | Account age | Member | duration |  | link | `3998d 10h` | How long ago the account was made |
| `{server.id}` | Server ID | Server | text |  |  | `100000000000000001` | Discord server id |
| `{server.name}` | Server name | Server | text | `{server}` |  | `Proton HQ` | The server's name |
| `{server.member_count}` | Member count | Server | whole number | `{memberCount}` |  | `1204` | How many members the server has |
| `{server.owner_mention}` | Owner | Server | mention |  | link | `Owner` | Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default. |
| `{server.role_count}` | Role count | Server | whole number |  |  | `24` | How many roles the server has, not counting @everyone |
| `{server.channel_count}` | Channel count | Server | whole number |  |  | `40` | How many channels the server has, not counting categories and threads |
| `{server.created_at}` | Server created | Server | date |  | link | `Oct 3, 2015, 10:44 PM` | When the server was made |
| `{server.icon_url}` | Server icon | Server | image link |  |  | `https://cdn.discordapp.com/icons/100000000000000001/0a1b2c3d.png?size=256` | The server's icon image; empty when it has none |
| `{server.banner_url}` | Server banner | Server | image link |  |  | `https://cdn.discordapp.com/banners/100000000000000001/0a1b2c3d.png?size=1024` | The server's banner image; empty when it has none |
| `{server.description}` | Description | Server | text |  |  | `Sample server` | The server's description; empty when it has none |
| `{server.boost_count}` | Boosts | Server | whole number |  |  | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number |  |  | `2` | The server's boost level, from 0 to 3 |
| `{destination_channel.id}` | Channel ID | Where it posts | text |  |  | `100000000000000040` | Discord channel id |
| `{destination_channel.mention}` | Channel | Where it posts | mention |  | link | `welcome` | The channel as a clickable mention; its name where mentions cannot be shown |
| `{destination_channel.name}` | Channel name | Where it posts | text |  |  | `welcome` | The channel's name |
| `{destination_channel.url}` | Channel link | Where it posts | link |  |  | `https://discord.com/channels/100000000000000001/100000000000000040` | A link that opens the channel |
| `{destination_channel.category_mention}` | Category | Where it posts | mention |  | link | `Community` | The category the channel sits in; empty when it has none |
| `{bot.id}` | Proton's ID | Proton | text |  |  | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention |  | link | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text |  |  | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link |  |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link |  |  | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link |  |  | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |
| `{now}` | Now | Time | date |  | link | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date |  | link | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number |  |  | `2026` | The current year, in UTC |
| `{event.created_at}` | When it happened | Event | date |  | link | `Sep 14, 2026, 9:00 AM` | When the event behind this message happened |

Registered here only so that using them is refused when you save, instead of being posted as written:

| Placeholder | Label | Why it is refused |
| --- | --- | --- |
| `{user.nickname}` | Nickname | Only filled in on: Welcome message, Boost message. |
| `{user.joined_at}` | Joined server | Only filled in on: Welcome message, Boost message. |
| `{user.is_boosting}` | Is boosting | Only filled in on: Welcome message, Boost message. |
| `{user.boosting_since}` | Boosting since | Only filled in on: Welcome message, Boost message. |
| `{user.role_mentions}` | Roles | Only filled in on: Welcome message, Boost message. |
| `{user.role_count}` | Role count | Only filled in on: Welcome message, Boost message. |

##### Boost message (`welcome.boost`)

Seen by anyone. Examples come from “Sample: Fraimer boosting Proton HQ”, or from the placeholder’s own example where that sample has no value.

Fields: every [message field](#message-fields), under `boostMessage`.

| Placeholder | Label | Group | Type | Older name | Not offered in | Example | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `{user.id}` | ID | Member | text |  |  | `100000000000000010` | Discord user id |
| `{user.mention}` | Mention | Member | mention | `{user}` | link | `Fraimer` | Pings them where mentions are allowed |
| `{user.username}` | Username | Member | text |  |  | `fraimer` | Unique account handle |
| `{user.global_name}` | Display name | Member | text |  |  | `Fraimer` | Account display name, or the username when none is set (as Discord shows it) |
| `{user.display_name}` | Name in this server | Member | text | `{username}` |  | `Fraimer` | Nickname here, else display name, else username |
| `{user.avatar_url}` | Avatar | Member | image link |  |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Server-independent avatar image |
| `{user.is_bot}` | Is a bot | Member | yes-or-no value |  | link | `No` | Yes for bot accounts |
| `{user.created_at}` | Account created | Member | date |  | link | `Oct 3, 2015, 10:44 PM` | When the account was made |
| `{user.account_age}` | Account age | Member | duration |  | link | `3998d 10h` | How long ago the account was made |
| `{user.nickname}` | Nickname | Member | text |  |  | `Fraim` | Server nickname; empty when none |
| `{user.joined_at}` | Joined server | Member | date |  | link | `Sep 14, 2026, 9:00 AM` | When they joined |
| `{user.is_boosting}` | Is boosting | Member | yes-or-no value |  | link | `Yes` | Yes while boosting |
| `{user.boosting_since}` | Boosting since | Member | date |  | link | `Sep 14, 2026, 9:00 AM` | When their boost began |
| `{user.role_mentions}` | Roles | Member | list of mentions |  | link | `Mods, Level 5` | Their roles as mentions. In message text these ping each role whenever the message's mention settings allow role pings, which is the default. |
| `{user.role_count}` | Role count | Member | whole number |  |  | `1` | How many roles they have |
| `{server.id}` | Server ID | Server | text |  |  | `100000000000000001` | Discord server id |
| `{server.name}` | Server name | Server | text | `{server}` |  | `Proton HQ` | The server's name |
| `{server.member_count}` | Member count | Server | whole number | `{memberCount}` |  | `1204` | How many members the server has |
| `{server.owner_mention}` | Owner | Server | mention |  | link | `Owner` | Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default. |
| `{server.role_count}` | Role count | Server | whole number |  |  | `24` | How many roles the server has, not counting @everyone |
| `{server.channel_count}` | Channel count | Server | whole number |  |  | `40` | How many channels the server has, not counting categories and threads |
| `{server.created_at}` | Server created | Server | date |  | link | `Oct 3, 2015, 10:44 PM` | When the server was made |
| `{server.icon_url}` | Server icon | Server | image link |  |  | `https://cdn.discordapp.com/icons/100000000000000001/0a1b2c3d.png?size=256` | The server's icon image; empty when it has none |
| `{server.banner_url}` | Server banner | Server | image link |  |  | `https://cdn.discordapp.com/banners/100000000000000001/0a1b2c3d.png?size=1024` | The server's banner image; empty when it has none |
| `{server.description}` | Description | Server | text |  |  | `Sample server` | The server's description; empty when it has none |
| `{server.boost_count}` | Boosts | Server | whole number |  |  | `14` | How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects. |
| `{server.boost_tier}` | Boost level | Server | whole number |  |  | `2` | The server's boost level, from 0 to 3 |
| `{destination_channel.id}` | Channel ID | Where it posts | text |  |  | `100000000000000040` | Discord channel id |
| `{destination_channel.mention}` | Channel | Where it posts | mention |  | link | `welcome` | The channel as a clickable mention; its name where mentions cannot be shown |
| `{destination_channel.name}` | Channel name | Where it posts | text |  |  | `welcome` | The channel's name |
| `{destination_channel.url}` | Channel link | Where it posts | link |  |  | `https://discord.com/channels/100000000000000001/100000000000000040` | A link that opens the channel |
| `{destination_channel.category_mention}` | Category | Where it posts | mention |  | link | `Community` | The category the channel sits in; empty when it has none |
| `{channel.id}` | Channel ID | Channel | text |  |  | `100000000000000040` | Discord channel id |
| `{channel.mention}` | Channel | Channel | mention |  | link | `welcome` | The channel as a clickable mention; its name where mentions cannot be shown |
| `{channel.name}` | Channel name | Channel | text |  |  | `welcome` | The channel's name |
| `{channel.url}` | Channel link | Channel | link |  |  | `https://discord.com/channels/100000000000000001/100000000000000040` | A link that opens the channel |
| `{channel.category_mention}` | Category | Channel | mention |  | link | `Community` | The category the channel sits in; empty when it has none |
| `{bot.id}` | Proton's ID | Proton | text |  |  | `100000000000000099` | Proton's Discord user id |
| `{bot.mention}` | Proton | Proton | mention |  | link | `Proton` | Mentions Proton |
| `{bot.name}` | Proton's name | Proton | text |  |  | `Proton` | Proton's name on Discord |
| `{bot.avatar_url}` | Proton's avatar | Proton | image link |  |  | `https://cdn.discordapp.com/embed/avatars/0.png` | Proton's avatar image |
| `{bot.website_url}` | Dashboard | Proton | link |  |  | `https://prtn.xyz` | The Proton dashboard |
| `{bot.support_url}` | Support server | Proton | link |  |  | `https://discord.gg/rWWJ2AUMby` | An invite to the Proton support server |
| `{now}` | Now | Time | date |  | link | `Sep 14, 2026, 9:00 AM` | The moment the message is written |
| `{today}` | Today | Time | date |  | link | `Sep 14, 2026, 12:00 AM` | The start of today, in UTC |
| `{year}` | Year | Time | whole number |  |  | `2026` | The current year, in UTC |
| `{event.created_at}` | When it happened | Event | date |  | link | `Sep 14, 2026, 9:00 AM` | When the event behind this message happened |

<!-- placeholders-doc:end -->
