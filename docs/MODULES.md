# Proton — Complete Module Reference

**Purpose of this document:** a self-contained description of every module in Proton, a Discord
bot platform, written so that someone who has never seen the codebase can design its server
dashboard. It describes what each module does, every setting it exposes, the type and default of
each setting, which settings a generic form can render and which need a purpose-built editor, and
the cross-cutting rules that constrain any dashboard design.

Nothing here is aspirational. Every field, command and limit listed is implemented.

---

## 1. What Proton is

Proton is a Discord bot with three concerns — moderation, security, and engagement — plus a web
dashboard where server administrators configure it. It is a monorepo of five services:

| Service | Job |
|---|---|
| `apps/gateway` | Holds the Discord gateway connection, normalises raw Discord events onto an internal event bus. |
| `apps/worker` | Consumes the bus and runs the module runtime. This is where modules actually execute. |
| `apps/rest-proxy` | The only process that talks to `discord.com`. Owns the shared rate-limit buckets. |
| `apps/api` | Hono HTTP API. **All domain logic lives here.** The dashboard calls it. |
| `apps/dashboard` | TanStack Start web app. Server functions are thin auth/audit wrappers that delegate to the api. |

Facts that matter for dashboard design:

- **The browser never talks to Discord.** Channel lists, role lists, emoji, member counts — all of
  it comes from Proton's api, which gets it from the rest-proxy. There is no client-side Discord SDK.
- **The api has no Discord client.** Anything the dashboard shows that requires a live Discord call
  is either cached server-side or dispatched as an event for the worker to perform asynchronously.
  "Post this panel to the channel" is a *request*, not a synchronous action — the api records it
  and publishes `proton.panel_requested`; the result appears later.
- **Modules never write config.** Config is written only by an administrator through the dashboard
  (or by a small number of slash commands that route through the api). A module reads its config
  and acts; it cannot change it. So anything the dashboard shows as "current state" that a module
  produced lives in a separate store, not in config.
- **Every mutation passes an audit trail.** Each config save is recorded with who, when and the
  before/after. A dashboard design should assume an audit/history surface is available.
- **All permission checks are server-side, per mutation.** The UI may hide controls, but it must
  never be the enforcement point.

---

## 2. The universal configuration model

This is the single most important section for a dashboard designer. Every module shares it.

### 2.1 A module is a manifest

```ts
interface ModuleManifest {
  id: string;                    // 'tickets'
  name: string;                  // 'Tickets'
  category: 'moderation' | 'security' | 'engagement' | 'utility' | 'logging';

  configSchema: ZodObject;       // the authoritative shape of this module's settings
  formSchema?: ZodObject;        // optional: the subset a generic form can render
  defaultConfig: <inferred>;     // what a brand-new server gets
  schemaVersion: number;         // bumped when the stored shape changes
  liftStoredConfig?(raw): raw;   // migrates an older stored shape before parsing

  requiredIntents: number[];         // Discord gateway intents this module needs
  requiredPermissions: bigint[];     // Discord permissions the bot needs
  actionKinds?: ActionKind[];        // every state-changing thing it may do
  emits?: EventType[];               // internal events it publishes
  commands?: CommandDefinition[];    // slash commands it owns
  listeners?: EventListener[];       // bus subscriptions
  schedules?: string[];              // named delayed jobs it can book
  jobs?: ScheduledJob[];             // cron jobs it owns
  configLimits?: { key, path }[];    // which config arrays are capped by billing tier
  providers?: Provider[];            // reusable conditions/multipliers other modules can consume
  rules?, compileRules?;             // declarative escalation rules
  postables?(config): Postable[];    // messages it keeps in a channel and can re-post
  dashboard?: { icon, sections };    // suggested grouping of fields into sections
}
```

### 2.2 Settings are Zod schemas with UI metadata attached

Zod is the single source of truth. Every field carries UI metadata through a Zod registry:

```ts
alertChannelId: snowflakeSchema.optional().register(protonFields, {
  field: 'channel-id',                 // which control to render
  label: 'Alert channel',              // the human name
  description: 'Where Proton reports it',
  channelTypes: [0, 5, 11, 12],        // restrict the picker
  showWhen: { path: 'mode', equals: ['captcha'] },   // conditional visibility
  optionLabels: { dm: 'By direct message' },          // prettier enum labels
})
```

The server walks the schema and emits **field descriptors** the dashboard renders. There are
exactly **eight field kinds**, plus flat arrays of any of them:

| Kind | Control | Extra metadata |
|---|---|---|
| `boolean` | switch / checkbox | — |
| `string` | text input | `minLength`, `maxLength` |
| `number` | number input / stepper | `min`, `max` |
| `colour` | colour picker (stored as an int `0x000000`–`0xffffff`) | — |
| `enum` | select / segmented control | `options`, `optionLabels` |
| `channel-id` | channel picker | `channelTypes` (Discord numeric channel types) |
| `role-id` | role picker | — |
| `duration` | duration input — a string like `30s`, `10m`, `1h`, `7d`, `2w` | — |

Every descriptor also carries: `path`, `label`, `description?`, `optional`, `defaultValue?`,
`array?`, `maxItems?`, `showWhen?`.

Common Discord channel-type numbers used in `channelTypes`: `0` text, `2` voice, `4` category,
`5` announcement, `11` public thread, `12` private thread, `13` stage.

### 2.3 What the generic form deliberately cannot render

The generator supports scalars, flat arrays of scalars, and objects nested **one** level. It
refuses arrays of objects, records, discriminated unions and recursion — by design, loudly, with an
`UnsupportedSchemaError`.

So a module whose config contains a rich structure declares a **`formSchema`** that omits those
fields, and the dashboard ships a **bespoke editor** for them. This is the single biggest driver of
per-module dashboard work. The full list:

| Module | Fields the generic form cannot render | What the bespoke editor is |
|---|---|---|
| `cases` | `escalationLadder` | Escalation ladder builder (warnings → action → duration rungs) |
| `appeals` | `panels` | Appeal-form builder (questions, windows, approve action, copy) |
| `branding` | `avatarHash`, `bannerHash` | Image upload control (its own API route) |
| `counters` | `counters` | Counter-channel list editor |
| `honeypot` | `channels`, `noticeLayout`, `dmLayout`, `appealPanelId` | Bait-channel list, two message builders, a picker sourced from the Appeals module |
| `leveling` | `levelUpMessage`, `roleRewards` | Message builder + level→role reward table |
| `messages` | `templates`, `components` | Full message/embed builder + component palette |
| `permissions` | `overrides` | A generated-per-command role matrix (schema built at runtime from the installed command list) |
| `rolemenu` | `menus` | Role-menu builder (kind, mode, bindings) |
| `serverlog` | `events` | An event × channel matrix (~80 events) |
| `tempvc` | `hubs` | Creator-channel (hub) editor with 11 owner-permission toggles each |
| `tickets` | `types`, `panels`, `responses` | Three editors: ticket types, panels, quick responses |
| `verification` | `panel` | Message builder |
| `welcome` | `welcomeMessage`, `goodbyeMessage` | Two message builders |
| `automod` | *(none — fully generic, but 40+ fields)* | Benefits from sub-page grouping, not custom controls |

### 2.4 Two grouping systems exist and they disagree

**`dashboard.sections`** lives on the manifest and groups fields into titled sections. It is the
*worker's* idea of grouping and is exposed over the api.

**Areas** live in the dashboard only, for the six modules whose settings are too big for one page.
An area is `{ id, title, blurb, icon, fields[], count?() }` and becomes a sub-page/tab. A module
with areas opens on its **first** area, never on a menu of areas. Areas also power "jump to this
setting" from the command palette.

Modules with areas today: `automod` (Checks / Response / Discord AutoMod / Exemptions),
`serverlog` (Categories / Individual events / Filters), `messages` (Templates / Components),
`leveling` (Earning XP / Level-up / Role rewards / Rank card), `welcome` (Welcome / Goodbye / Card),
`honeypot` (Bait channels / Camouflage / What happens / Exemptions / Warning / Direct message /
Escalation).

Areas can display a live count on their tab (`3`, `2 of 11 on`) and one operational line in the
module header (`3 bait channels`).

### 2.5 The `enabled` switch is special

Every module has a top-level `enabled: boolean`. It is **filtered out of the generated form** and
rendered once, by the shell (sidebar / module header), so two controls can never disagree. The
constant is `MODULE_SWITCH_PATH = 'enabled'`.

There are two different "enabled" questions the UI must distinguish:
- `enabled` — the guild turned this module on.
- `status.enabled` — whether the module *could* run here at all (missing intent, missing
  permission, missing tier). Carries `disabledReason: { code, humanReason }`.

### 2.6 Postables — messages Proton keeps in a channel

Three modules keep a message in a channel that can be re-posted or refreshed:

| Module | Postables |
|---|---|
| `rolemenu` | one per configured menu (`channelId` may be unset → render as *unpostable*) |
| `tickets` | one per configured panel |
| `verification` | exactly one: the verification panel |

`postables()` is pure and derived from config, so the dashboard lists them beside the channel they
live in and offers "post" / "refresh". The api validates the id before publishing
`proton.panel_requested` and returns `{ auditId, name }` — a *receipt*, not a result.

### 2.7 Schema migration is visible to the user

`moduleConfigViewSchema` returns a `migrated: boolean`. When a module's `liftStoredConfig` had to
reshape an older stored config, the dashboard is expected to tell the admin to open the page and
check it — because some lifts are lossy (honeypot v1→v2 collapses per-channel actions into one
module-wide action; permissions merges retired command aliases).

Modules with a lift: `branding`, `honeypot`, `messages`, `permissions`, `tempvc`, `tickets`,
`verification`, plus in-schema preprocessors on `counters`, `welcome`, `leveling`.

### 2.8 Errors must name what is missing

A project rule: *"the bot did nothing" is a bug*. Every refusal names the missing permission,
intent, or setting, and where it is missing. Validation messages in the schemas are written as
full sentences aimed at an administrator, e.g.:

> *"a counter template needs `{count}` in it — that is where the number goes, as in "Members:
> {count}". Without it the channel would be renamed to a fixed string that never changes."*

The dashboard should render these verbatim; they are not developer strings.

---

## 3. Billing tiers and limits

Three tiers: **free**, **plus**, **pro**. Monetization is Discord App Subscriptions *and* Stripe.

Twelve countable limits. Modules cannot enforce these (modules never write config), so they are
enforced **where the save happens** — in the api, from the manifest's `configLimits`.

| Limit key | Label | free | plus | pro | Scope |
|---|---|---:|---:|---:|---|
| `tags` | tags | 25 | 125 | 500 | guild |
| `activeGiveaways` | running giveaways | 3 | 15 | 60 | guild |
| `remindersPerUser` | reminders per member | 10 | 50 | 200 | **member** |
| `ticketPanels` | ticket panels | 2 | 10 | 40 | guild |
| `ticketTypes` | ticket types | 4 | 25 | 100 | guild |
| `openTicketsPerUser` | open tickets per member | 3 | 15 | 60 | **member** |
| `counters` | counter channels | 5 | 25 | 100 | guild |
| `tempVcHubs` | creator channels | 2 | 10 | 40 | guild |
| `savedTemplates` | saved templates | 10 | 50 | 200 | guild |
| `activePolls` | running polls | 3 | 15 | 60 | guild |
| `honeypotChannels` | honeypot channels | 3 | 10 | 25 | guild |
| `appealPanels` | appeal forms | 1 | 5 | 15 | guild |

Refusal copy is generated and tier-aware, e.g. *"the free tier allows 3 honeypot channels and this
server is already at 3. Remove one first, or move to plus for 10."* Per-member limits say *"you are
already at"* instead of *"this server is already at"*.

No module currently sets `requiredEntitlement`, so every module is available on every tier — tiers
gate *volume*, not *features*. A dashboard should therefore show limits as counters/meters on list
editors rather than as locked modules.

---

## 4. Navigation: how the dashboard files the modules today

The manifest `category` is the *worker's* taxonomy (it drives `/commands` and the public catalogue).
Using it in the sidebar produced a group of eleven called "Utility" headed by Help and Ping. So the
sidebar uses an authored grouping by **the job the admin came to do**:

| Group | Modules (in authored order) |
|---|---|
| **When someone joins** | verification, joinroles, welcome |
| **Keeping it safe** | automod, antiraid, antinuke, phishing, honeypot |
| **Moderating people** | moderation, cases, appeals, permissions |
| **Things members use** | tickets, rolemenu, tags, messages, leveling, giveaways, polls, suggestions, starboard, tempvc, reminders, counters |
| **What gets written down** | serverlog, logging |
| **The server itself** | branding, backup, help, ping |

`branding` is additionally flagged **server-level**: it configures Proton's own identity in this
server rather than adding a feature, so it sits above the categories on both surfaces.

Any module the dashboard build doesn't know about falls back to its manifest category rather than
disappearing — the api can ship modules a given dashboard build has never heard of.

**Search aliases.** Users arrive with MEE6's, Dyno's and Carl-bot's vocabulary. Each module carries
synonym text for search — e.g. `rolemenu` → *"reaction roles self roles role picker button roles"*,
`tags` → *"custom commands snippets autoresponder"*, `welcome` → *"welcomer greeting goodbye leave
message"*. Search must match these, not just the module name.

### Data views (records, not settings)

Five browsable datasets, distinct from configuration:

| Module | View | Title | Filed under "Records"? |
|---|---|---|---|
| `cases` | `cases` | Case log | yes |
| `moderation` | `blocked` | Blocked members | yes |
| `tickets` | `tickets` | Ticket queue | yes |
| `leveling` | `leaderboard` | Leaderboard | no — a tab on its own module |
| `tags` | `tags` | Tag library | no — a tab on its own module |

API endpoints backing them: `/guilds/:id/cases`, `/guilds/:id/blocked-members`,
`/guilds/:id/tickets`, `/guilds/:id/tickets/stats`, `/guilds/:id/leaderboard`, `/guilds/:id/tags`.

---

## 5. The modules

30 configurable modules. Legend used below:

- **On by default** — the value of `enabled` in `defaultConfig`.
- Field notation: `` `name` `` *(kind, default)* — Label. Notes.
- "⚙︎ bespoke" marks a field the generic form cannot render.

---

## 5.1 When someone joins

---

### `verification` — Verification
**Category** security · **On by default** no · **Schema v3** · **Commands** `/verify`, `/quarantine add|remove`
**Intents** Guilds, GuildMembers · **Permissions** Manage Roles
**Postable** the verification panel

A gate new members pass before the rest of the server opens up. Three modes: press a **button**,
solve a **captcha**, or sign in on **Proton's website** (the api exposes
`POST /guilds/:id/verification/passed` and there is a public `/verify/$token` route).

Mechanism: on join, Proton applies the *unverified* role (optionally waiting for Membership
Screening). The member presses the panel button; on success the unverified role is removed and the
*verified* role added. Captcha mode sends a code either ephemerally in-channel or by DM (a member
with DMs closed is always answered in-channel), with a length, an attempt count and an expiry;
running out of attempts triggers a configurable failure action.

Proton **owns the panel's button row** — the admin authors the panel's text and embeds, Proton
attaches the verify button itself. The schema *rejects* an authored button row rather than silently
dropping it, with a message explaining why.

**Config**
- `enabled` *(boolean, false)*
- `mode` *(enum, `button`)* — How members verify. Labels: "Press a button" / "Solve a captcha" / "Sign in on Proton's website".
- `panelChannelId` *(channel-id, unset; types 0,5)* — Panel channel. "Where Proton posts the message new members press"
- `panel` ⚙︎ *(message object)* — Panel message. Default content: `## Verify to get access\n\nPress the button below to unlock the rest of the server.`
- `panelButtonLabel` *(string 1–80, `Verify`)*
- `panelButtonEmoji` *(string ≤64, unset)*
- `panelButtonStyle` *(enum, `success`)* — Blurple / Grey / Green / Red. Link style is excluded: a link button carries no `custom_id` so it could never verify anyone.
- `unverifiedRoleId` *(role-id, unset)* — "New members are briefly ungated until Proton applies it"
- `verifiedRoleId` *(role-id, unset)* — Member role
- `applyUnverifiedOnJoin` *(boolean, true)*
- `captchaDelivery` *(enum, `channel`)* — **showWhen mode = captcha**
- `captchaLength` *(number 4–8, 6)* — **showWhen mode = captcha**
- `captchaAttempts` *(number 1–5, 3)* — **showWhen mode = captcha**
- `captchaExpiry` *(duration, `5m`)* — **showWhen mode = captcha**
- `failureAction` *(enum, `none`)* — Nothing / Kick / Ban / Timeout / Quarantine. **showWhen mode = captcha**
- `failureTimeout` *(duration, `1h`)* — **showWhen failureAction = timeout**. "Discord caps timeouts at 28 days"
- `quarantineRoleId` *(role-id, unset)*

**Design note:** this module is the clearest example of `showWhen`. Five fields appear only in
captcha mode and one only under one value of another conditional field — progressive disclosure is
required, not optional.

---

### `joinroles` — Join roles
**Category** utility · **On by default** no · **Schema v2** · **Commands** none
**Intents** Guilds, GuildMembers · **Permissions** Manage Roles

Roles handed out when somebody joins, and roles restored if they return. "Sticky roles" remembers
what a member held when they left and re-applies it on rejoin.

**Config**
- `enabled` *(boolean, false)* — Grant roles on join
- `memberRoleIds` *(role-id array, max 10, [])* — Roles for people
- `botRoleIds` *(role-id array, max 10, [])* — Roles for bots
- `grantWhenScreeningPasses` *(boolean, true)* — Wait for Membership Screening
- `stickyEnabled` *(boolean, false)* — Restore roles on rejoin
- `stickyRoleIds` *(role-id array, max 25, [])* — "Empty restores every role the member had"

---

### `welcome` — Welcome & goodbye
**Category** engagement · **On by default** no · **Schema v4** · **Commands** none
**Intents** Guilds, GuildMembers · **Permissions** View Channel, Send Messages
**Areas** Welcome / Goodbye / Card

What Proton posts when somebody joins or leaves, plus a rendered image card.

Greetings are full **message objects** (content + embeds + components + Components-V2 layout +
mention policy), not strings. Placeholders: `{user}` (mention), `{username}`, `{server}`,
`{memberCount}`.

Two rules the editor must enforce: an **empty** greeting is legal and means "announce nothing";
and a greeting may carry **link buttons only** — Proton does not listen for presses on a greeting,
so any other button would do nothing. The schema rejects non-link buttons with that exact
explanation.

**Config**
- `enabled` *(boolean, false)*
- `welcomeChannelId` *(channel-id, unset)*
- `welcomeMessage` ⚙︎ *(message object)* — default: `Welcome to {server}, {user}. You are member #{memberCount}.`
- `goodbyeChannelId` *(channel-id, unset)*
- `goodbyeMessage` ⚙︎ *(message object)* — default: `{username} has left {server}.`
- `card` *(boolean, false)* — Attach a card. "Costs an extra image render per join"
- `preset` *(enum of card presets, `midnight`)* — Card style
- `cardAccent` *(colour)* — Accent colour
- `cardBackgroundUrl` *(string url https, ≤2048, unset)* — "Only images hosted on Discord's CDN load"
- `cardShowMemberCount` *(boolean, true)*

The api exposes `GET /guilds/:id/cards/preview` — the dashboard can show a live card preview.

---

## 5.2 Keeping it safe

---

### `automod` — Automod
**Category** security · **On by default** no · **Schema v1** · **Commands** none
**Intents** Guilds, GuildMessages, MessageContent, AutoModerationConfiguration, AutoModerationExecution
**Permissions** View Channel
**Areas** Checks / Response / Discord AutoMod / Exemptions

The largest purely-generic module: ~45 flat fields, no bespoke controls, but far too many for one page.

It works on **two planes at once**:

1. **Enforced by Discord** — Proton *creates, updates and deletes this server's native Discord
   AutoMod rules* from the config (blocked words, allowed words, Discord's keyword presets, a
   mention limit, Discord's own spam filter, regex patterns). These block messages before Proton
   ever sees them.
2. **Enforced by Proton** — eleven checks Proton runs itself on each message.

**The severity model.** Rather than an enable-flag plus a response per check (22 fields to keep
consistent), every check has a **severity**: `off | low | medium | high`. Severity is then mapped
once to a response:

- `deleteFrom` *(enum `low|medium|high|never`, `low`)* — delete the message from this severity up
- `lowResponse` *(enum `none|warn|timeout|kick|ban`, `none`)*
- `mediumResponse` *(`warn`)*
- `highResponse` *(`timeout`)*
- `mediumTimeout` *(duration, `10m`)*, `highTimeout` *(duration, `1h`)*

**The eleven checks** (each `<check>Severity`, all default `off`):

| Check | Severity field | Tuning fields |
|---|---|---|
| Message flood | `floodSeverity` | `floodCount` *(2–50, 6)*, `floodWindow` *(duration, `5s`)* |
| Duplicate messages | `duplicateSeverity` | `duplicateCount` *(2–50, 3)*, `duplicateWindow` *(`30s`)* |
| Mass mentions | `mentionsSeverity` | `mentionsLimit` *(1–50, 8)* |
| Invite links | `invitesSeverity` | — |
| Blocked links | `linksSeverity` | `linkBlockDomains` *(string array ≤200)*, `linkAllowDomains` *(≤200)* |
| Attachments | `attachmentsSeverity` | `attachmentExtensions` *(string array ≤100; defaults to exe, scr, bat, cmd, com, pif, msi, vbs, jar, ps1, apk, lnk)* |
| Custom patterns | `patternsSeverity` | *(uses `regexPatterns`)* |
| Zalgo text | `zalgoSeverity` | — |
| Shouting | `capsSeverity` | `capsRatio` *(50–100, 70)* |
| Emoji spam | `emojiSeverity` | `emojiLimit` *(1–100, 12)* |
| Walls of text | `wallsSeverity` | `wallMaxLines` *(2–200, 15)* |

**Discord-plane fields:** `blockedWords` *(≤1000 strings ≤60 chars)*, `allowedWords` *(≤100)*,
`presets` *(enum array: profanity, sexualContent, slurs)*, `mentionLimit` *(0–50, 0; 0 = off)*,
`nativeSpam` *(boolean, false)*, `regexPatterns` *(≤10 strings ≤260)*.

**Exemptions:** `exemptRoleIds` *(role-id array, **max 20** — Discord's own `exempt_roles` caps at
20 and these are passed through verbatim)*, `exemptChannelIds` *(≤50)*, `exemptBots` *(true)*.
Plus `alertChannelId`.

**Validation worth surfacing:** regex patterns are compiled on save; an invalid pattern is rejected
by name, and a pattern that nests one unbounded repeat inside another is rejected as a
catastrophic-backtracking risk — *"Rewrite it without the nested + or *"*. This is caught on save,
not at message time, because otherwise the admin would never learn which pattern wedged the worker.

**Area tab count:** the Checks tab shows `"{n} of 11 on"`.

---

### `antiraid` — Anti-raid
**Category** security · **On by default** no · **Schema v1** · **Commands** none
**Intents** Guilds, GuildMembers · **Permissions** Manage Roles, Kick Members
**Emits** `proton.security_tripped`

Watches the join rate and how new the joining accounts are, and gates a suspected raid. Each join
gets a **score**; when the score crosses a threshold within the join window, the configured response
fires.

**Config**
- `enabled` *(boolean, false)*
- `joinWindow` *(duration, `10s`)*
- `joinThreshold` *(number 2–500, 10)* — Joins per window
- `newAccountAge` *(duration, `7d`)*
- `brandNewAccountAge` *(duration, `1d`)* — **cross-field rule:** must not be longer than
  `newAccountAge`; brand-new accounts are a subset of new ones and carry the heavier score.
- `scoreThreshold` *(number, min = the minimum actionable score)*
- `response` *(enum `verify|quarantine|kick`, `verify`)*
- `verificationRoleId` *(role-id)* — "Gates nothing unless the role's own permissions deny access"
- `quarantineRoleId` *(role-id)* — "Stays on until a staff member takes it off"
- `alertChannelId` *(channel-id)*

---

### `antinuke` — Anti-nuke
**Category** security · **On by default** **yes** · **Schema v1** · **Commands** `/antinuke status|maintenance|resume`
**Intents** Guilds, GuildModeration · **Permissions** View Audit Log, Manage Roles
**Emits** `proton.security_tripped`

Trips a breaker when one member destroys things too quickly. Reads the **audit log** to attribute
each destructive act to an actor, counts per actor per window, and on trip **strips the actor's
roles first**, then optionally kicks or bans.

Five independent rate thresholds, each a limit + a window:

| Threshold | Limit field *(2–100)* | Default | Window field | Default |
|---|---|---:|---|---|
| Channel deletions per member | `channelDeleteLimit` | 3 | `channelDeleteWindow` | `30s` |
| Role deletions per member | `roleDeleteLimit` | 3 | `roleDeleteWindow` | `30s` |
| Webhook deletions per member | `webhookDeleteLimit` | 5 | `webhookDeleteWindow` | `30s` |
| Emoji deletions per member | `emojiDeleteLimit` | 10 | `emojiDeleteWindow` | `1m` |
| Bans and kicks per moderator | `memberRemoveLimit` | 5 | `memberRemoveWindow` | `30s` |

Plus:
- `afterStrip` *(enum `none|kick|ban`, `none`)* — "Roles are stripped first whatever this is set to"
- `alertChannelId` *(channel-id, types 0 & 5)*
- `maintenanceMaxDuration` *(duration, `1h`)* — "Maintenance leaves the server unguarded for this long"

**Maintenance mode** is a first-class runtime state: `/antinuke maintenance <duration> <reason>`
suspends the breaker, `/antinuke resume` restores it, `/antinuke status` reports. A dashboard should
show this state prominently — the server is unprotected while it is on — and probably offer the
same three actions.

---

### `phishing` — Phishing links
**Category** security · **On by default** **yes** · **Schema v1** · **Commands** `/phishing`
**Intents** Guilds, GuildMessages, MessageContent · **Permissions** View Channel
**Cron job** blocklist refresh

Matches links in messages against a phishing blocklist Proton refreshes for itself on a schedule.
`/phishing` reports blocklist status (size, last refresh).

**Config**
- `enabled` *(boolean, true)*
- `action` *(enum `none|timeout|kick|ban`, `timeout`)* — "The message itself is never deleted"
- `timeoutDuration` *(duration, `1h`)*
- `alertChannel` *(channel-id; types 0,5,11,12)*
- `blockDomains` *(string array ≤100, domains ≤253 chars)* — Extra blocked domains
- `allowDomains` *(string array ≤100)* — "Never blocked. Also allows every subdomain"

---

### `honeypot` — Honeypot
**Category** security · **On by default** no · **Schema v2 (lossy lift from v1)** · **Commands** none
**Intents** Guilds, GuildMessages, MessageContent · **Permissions** Ban Members
**Emits** `proton.security_tripped` · **Limit** `honeypotChannels` (3 / 10 / 25)
**Areas** Bait channels / Camouflage / What happens / Exemptions / Warning / Direct message / Escalation

Channels nobody has a legitimate reason to post in. Anyone who posts in one is removed on the spot —
which is how spam bots and compromised accounts give themselves away.

Two supporting subsystems the dashboard must account for:
- **Camouflage** — two daily jobs that stop a bait channel from reading as a trap: post something
  once a day, and rotate the channel's name daily.
- **Appeals integration** — a caught account can be pointed at a specific appeal form
  (`appealPanelId`), which is an id picked from the **Appeals** module's panels, not typed.

**v1 → v2 migration is lossy and must be surfaced.** v1 kept the action, delete window and timeout
length on *every channel row*; v2 keeps one of each for the whole module. Rows that disagreed cannot
all be honoured — the first armed row decides. The dashboard is expected to tell a migrated guild to
open the page and check it.

**Config**
- `enabled` *(boolean, false)* — Honeypot enabled
- `channels` ⚙︎ *(array of `{ channelId, enabled }`, capped by tier)* — Bait channels. A per-row switch so a trap can be taken out of service without losing its setup. Duplicate channel is rejected: *"This channel is already a honeypot. Edit the row above instead of adding it twice."*
- `includeThreads` *(boolean, true)* — "A thread under a bait channel is part of the trap"
- `keepChannelActive` *(boolean, false)* — Keep the channel active
- `renameChannelDaily` *(boolean, false)* — Rename the channel daily
- `action` *(enum, `softban`)* — Softban ("remove them and delete what they posted") / Ban / Kick / Timeout / Warn / "Log it and do nothing else"
- `timeoutFirst` *(boolean, false)* — "Silences them before the action lands, so a burst stops immediately"
- `timeoutFirstDuration` *(duration, `5m`)* — **showWhen timeoutFirst = true**
- `timeoutDuration` *(duration, `1h`)* — **showWhen action = timeout**
- `deleteMessageSeconds` *(number 0–604800, 604800)* — "How far back their messages are deleted. Only a softban or a ban can do this"
- `waitBeforeActingSeconds` *(number 0–604800, 0)* — "Leave at zero to act immediately"
- `auditLogReason` *(string 1–512)* — what Discord's own audit log records
- `deleteTriggerMessage` *(boolean, true)*
- `exemptAdministrators` *(boolean, true)* — "Anyone holding Administrator is caught and counted, but not acted on"
- `exemptAdminRoleId` *(role-id)*, `exemptRoleIds` *(role-id array ≤50)*
- `postNotice` *(boolean, true)* — "Puts a notice in every bait channel so a member who wanders in knows to leave"
- `noticeCounterButton` *(boolean, true)* — "Shows the live number this trap has caught". **showWhen postNotice = true**
- `hideWhatIsAHoneypot` *(boolean, false)* — "Warns members off without saying the channel is a trap". **showWhen postNotice = true**
- `noticeLayout` ⚙︎ *(message object)* — the notice itself
- `sendDirectMessage` *(boolean, true)* — "Sent just before the action lands, while there is still a shared server"
- `offerWayBackIn` *(boolean, false)* — **showWhen sendDirectMessage = true**
- `inviteUrl` *(string ≤512)* — "Proton cannot mint one for you". **showWhen offerWayBackIn = true**
- `dmLayout` ⚙︎ *(message object)*
- `appealPanelId` ⚙︎ *(string, picked from Appeals' panels)*
- `addToBlacklist` *(boolean, false)* — "A blocked account cannot pass verification until a moderator lifts it"
- `quoteMessage` *(boolean, false)* — "Puts what they posted in the incident log"
- `logChannelId` *(channel-id; types 0,5,11,12)*

**Cross-module coupling to model in the UI:** honeypot → blocked-members store → verification
(a blocked account cannot verify) → moderation's "Blocked members" record view (with a *lift*
action, `POST /guilds/:id/blocked-members/:userId/lift`) → appeals (an approved appeal can lift the
block).

---

## 5.3 Moderating people

---

### `moderation` — Moderation
**Category** moderation · **On by default** **yes** · **Schema v1**
**Intents** Guilds · **Permissions** View Channel, Send Messages, Ban Members, Kick Members, Moderate Members, Manage Channels, Manage Roles
**Emits** `moderation.warned` · **Data view** Blocked members

The ban/kick/timeout/warn/purge commands and the policy Proton applies when staff run them. Very
few settings, a lot of commands.

**Command shape** — deliberately `verb add | verb remove` pairs rather than `verb` / `unverb`:

| Command | Subcommands | Options |
|---|---|---|
| `/ban` | `add` | user, duration, delete_message_days, reason |
| | `remove` | user_id, reason |
| `/kick` | — | user, reason |
| `/timeout` | `add` | user, duration, reason |
| | `remove` | user, reason |
| `/warn` | `add` | user, reason |
| | `remove` | case, reason |
| `/lockdown` | `add` | duration, reason |
| | `remove` | reason |
| `/slowmode` | — | duration, reason |
| `/role` | `add` / `remove` | user, role, reason |
| | `all` / `bots` / `humans` | role, reason |
| | `in` | role, target_role, reason |
| | `cancel` | — |

`/role` lives inside moderation and is the only command carrying an **invoker-rank guard** — a
moderator cannot hand out a role above their own highest role. Bulk role runs (`all`, `bots`,
`humans`, `in`) are long-running jobs scheduled on the `ROLE_RUN_JOB` schedule and cancellable with
`/role cancel`. A dashboard should show running role jobs with progress.

**Config**
- `enabled` *(boolean, true)*
- `requireReason` *(boolean, false)*
- `publicReplies` *(boolean, false)* — Announce outcomes in the channel
- `defaultTimeoutDuration` *(duration, `1h`)* — "Discord caps timeouts at 28 days"
- `defaultBanDeleteDays` *(number 0–7, 0)*

---

### `cases` — Cases
**Category** moderation · **On by default** **yes** · **Schema v1** · **Commands** none of its own
**Intents** Guilds · **Permissions** View Channel, Send Messages
**Data view** Case log · **Providers** `cases.no_active_case`, `cases.no_cases_in`

Every action Proton takes, numbered and searchable — the moderation record. Also owns the
**escalation ladder**: rules that turn repeat warnings into real punishments.

The ladder is a declarative rule set. `rules` seeds preset rules once; `compileRules(config)`
recompiles the guild's own ladder on **every save** — without which an edited ladder would change
nothing.

**Config**
- `enabled` *(boolean, true)*
- `historyLimit` *(number 1–25, 10)* — Cases shown in `/history`
- `escalationWindow` *(duration, `30d`)* — how far back warnings count
- `escalationLadder` ⚙︎ *(array of rungs, max 20)* — default: 3 warnings → timeout 1h; 5 warnings → timeout 1d

**A rung** is `{ atWarnings: 2–100, action: timeout|kick|ban, duration? }`. Two validation rules the
editor must enforce inline:
1. Rungs must be **strictly increasing** by `atWarnings` — *"two rungs at the same warning count
   would both fire on it."*
2. A `timeout` rung **needs a duration** — *"Discord timeouts are an expiry, not a flag."*

The dashboard already ships an escalation-ladder component (`components/cases/escalation-ladder.tsx`).

`cases` also publishes **providers** other modules consume — e.g. giveaways can require
"no active case" or "no cases in the last N days" without importing the cases module.

---

### `appeals` — Appeals
**Category** moderation · **On by default** no · **Schema v1** · **Commands** none
**Intents** Guilds · **Permissions** Ban Members · **Emits** `appeals.decided`
**Limit** `appealPanels` (1 / 5 / 15)

The forms somebody fills in to argue against a ban, and where moderators read and decide them.

A banned user cannot be in the server, so appeals are filed **through the public website**: there is
a `/appeal/$token` route and two api endpoints, `POST /guilds/:id/appeals/form` and
`POST /guilds/:id/appeals/submit`. The appeal lands as a message in a review channel with accept /
deny controls.

**Config (server-wide)**
- `enabled` *(boolean, false)* — Appeals enabled
- `reviewChannelId` *(channel-id; types 0,5,11,12)* — "Where an appeal lands when its form names no channel of its own"
- `reviewerRoleIds` *(role-id array ≤25)* — "Who may accept or turn down an appeal". Deliberately **server-wide only** — a per-form reviewer list would be a setting the dashboard has no control to edit, "and a setting nobody can see is a setting nobody can turn off."
- `panels` ⚙︎ *(array of appeal forms, tier-capped)*

**An appeal form (`panels[]`)** — this is the bespoke editor:
- `id` *(≤32)*, `name` *(≤80)*, `enabled` *(true)*
- `blurb` *(≤2000)* — text shown above the form
- `questions` *(1–5)*: each `{ key, label ≤120, placeholder? ≤100, required (true), maxLength 16–1024 (1024) }`
- `reviewChannelId` *(optional override)*
- `windowDays` *(1–30, 30)* — how long after the punishment an appeal may still be filed
- `cooldownDays` *(0–365, 30)* — how long before another may be filed
- `allowResubmit` *(boolean, false)*
- `onApprove` *(enum `unban|untimeout|nothing`, `unban`)*
- `liftBlocklistOnApprove` *(boolean, true)*
- `rejoinUrl` *(≤512)*
- `approvedMessage` *(≤2000)* — default: *"Your appeal was accepted. You can come back to the server."*
- `deniedMessage` *(≤2000)* — default: *"Your appeal was read and turned down. The decision stands."*

Duplicate form ids are rejected because *"a honeypot points at one by its id"*; duplicate question
keys are rejected because one answer would overwrite the other.

---

### `permissions` — Permissions
**Category** utility · **On by default** **yes** · **Schema v1** · **Commands** none
**Intents** Guilds · **Permissions** View Channel

Which roles may run each of Proton's commands. Off falls back to Discord's own command permissions.

The stored shape is a **record**: `{ [commandName]: roleId[] }`. An empty or absent list for a
command means "fall back to Discord's own permissions". The generic form cannot render a record,
so the dashboard builds a form schema **at runtime** from the installed command list —
`commandOverridesFormSchema(commandNames)` produces one `role-id` array field per command, labelled
`/ban`, `/kick`, and so on, each described as *"Empty falls back to Discord's own command
permissions"*.

Override keys must be valid Discord command names: lowercase, 1–32 chars, no spaces, no leading
slash — *"'ban', not '/Ban'"*.

**Retired-alias lift.** Some commands used to be top-level and are now subcommands. `untimeout →
timeout`, `unquarantine → quarantine`, `unlock → lockdown`. An override on a retired key is read as
the survivor's. Where a guild gated the two halves differently, only one can win; the survivor's
list wins, which *widens* access to the lifting half rather than the punishing half — deliberately
the safer direction.

**Config**
- `enabled` *(boolean, true)*
- `overrides` ⚙︎ *(record of command → role ids)*

**Design note:** this page is a matrix of ~25 commands × role pickers. It is the single largest
generated-at-runtime surface in the product (the route file is already 364 lines).

---

## 5.4 Things members use

---

### `tickets` — Tickets
**Category** utility · **On by default** no · **Schema v2 (lift from v1)** · **Command** `/ticket`
**Intents** Guilds, GuildMessages · **Permissions** View Channel, Send Messages, Read Message History, Attach Files, Embed Links, Manage Channels, Manage Roles
**Emits** `tickets.opened|claimed|closed|reopened|deleted`
**Limits** `ticketPanels` (2/10/40), `ticketTypes` (4/25/100), `openTicketsPerUser` (3/15/60)
**Postables** one per panel · **Data view** Ticket queue (+ stats endpoint)

The most configurable module by a wide margin. Private support channels members open from a panel.
The model has **three** editable collections:

**1. Ticket types (`types[]`)** — a kind of ticket, carrying its own staff, intake form, timers and
transcript policy. 26 fields each:

- `id`, `name` *(≤64, "Support")*, `emoji` *(≤64)*, `description` *(≤100)*
- `categoryId`, `archiveCategoryId` *(channel-ids)*
- `staffRoleIds` *(≤20)* — added to the server-wide support roles
- `namePattern` *(≤100)* — overrides the server default
- `defaultPriority` *(enum low|medium|high|urgent, `medium`)*, `askPriority` *(false)*
- `maxOpenPerUser` *(1–100, optional override)*, `cooldown` *(duration, optional)*
- `form` *(0–5 fields)* — Discord modals take at most five components, so a longer form is refused where the admin can see why. Each field: `{ id, label ≤45, style short|paragraph|select, placeholder ≤100, required (true), maxLength 1–4000, options[] ≤25 }`
- `welcomeMessage` *(≤2000)* — default: *"Thanks for getting in touch, {user}. Describe the problem below."*
- `mentionStaffOnOpen` *(true)*
- `claimMode` *(enum `off|single|assignable`, `single`)*, `claimRestrictsReplies` *(false)*
- `closeRequiresConfirmation` *(false)*, `closeRequestExpiresAfter` *(duration?)*
- `reopenEnabled` *(true)*, `archiveOnClose` *(false)*
- `autoCloseAfter`, `inactivityWarnAfter`, `autoDeleteAfter` *(durations, optional)*
- `transcript` *(enum `off|channel|owner|both`, `channel`)*, `transcriptChannelId`
- `captureMessages` *(boolean, **false**)* — turning it on starts retaining the text of every message in a ticket. Off by default because that "is a decision about the server's members and not one Proton makes for them."
- `askRating` *(false)*

**2. Panels (`panels[]`)** — the message members press. Buttons or a select menu, fronting one or
more ticket types:
`id`, `name`, `channelId`, `typeIds[] ≤25`, `style` *(buttons|select)*, `title`, `panelText`
*(≤2000, default "Need a hand? Open a ticket and the team will be with you.")*, `colour`,
`authorName`, `footerText`, `thumbnailUrl`, `imageUrl`, `selectPlaceholder`.

**3. Quick responses (`responses[]`, ≤50)** — canned replies staff insert: `{ id, label ≤64,
content ≤2000 }`.

**Server-wide config (the generic form)**
- `enabled` *(boolean, false)*
- `namePattern` *(string, `ticket-{number}`)* — must contain `{number}` or `{user}`; `{type}` also substituted
- `closeConfirmation` *(string ≤2000)* — Closing message
- `maxOpenPerUser` *(1–100, 3)* — "A ticket type may set a lower limit of its own. Your plan caps this too."
- `maxOpenPerGuild` *(1–500, 200)* — "Discord allows 500 channels in a server in total."
- `creationCooldown` *(duration, `5s`)*
- `logChannelId`, `transcriptChannelId` *(channel-ids, text only)*
- `staffRoleIds` *(role-id array ≤20)* — "Reach every ticket. A ticket type can add roles that reach only its own."
- `blacklistMessage` *(string ≤500)*

**Commands.** `/ticket` with 21 subcommands plus a `blacklist` group:
`panel`, `create`, `close`, `reopen`, `delete`, `claim`, `unclaim`, `assign`, `transfer`, `add`,
`remove`, `rename`, `move`, `priority`, `lock`, `unlock`, `transcript`, `info`, `list`, `response`,
`stats`; `blacklist add|remove|list`.

**Priority is never carried by an emoji** — Proton ships no stock unicode emoji of its own. Priority
shows as an accent colour plus the word: low `#4fcf95`, medium `#3874f3`, high `#f0b752`, urgent
`#ff7a86`. A guild wanting a glyph puts a custom emoji on the ticket type.

**v1 lift:** v1 kept staff, category and opening message on the panel, and every panel was exactly
one button. The lift creates a ticket type per legacy panel, preserves v1's delete-on-close by
setting `autoDeleteAfter: '1s'`, and sets `reopenEnabled: false`.

---

### `rolemenu` — Role menus
**Category** engagement · **On by default** no · **Schema v1** · **Command** `/rolemenu`
**Intents** Guilds, GuildMessageReactions · **Permissions** Manage Roles
**Postables** one per menu

Menus members interact with to give themselves roles. Three kinds and three modes:

- **kind** — `reaction` (emoji on a message), `button`, `select` (dropdown)
- **mode** — `toggle` (press again to remove), `add-only`, `unique` (picking one removes the others)

**Config**
- `enabled` *(boolean, false)*
- `menus` ⚙︎ *(array, max 25)*

**A menu:** `{ id, channelId, messageId?, kind, mode, bindings[1–25] }`; a binding is
`{ key, roleId, label? ≤80 }`.

Validation the editor must handle inline:
- A **reaction** menu requires `messageId` — *"a reaction only tells Proton the channel, the message
  and the emoji, so without it the menu can never be recognised. Turn on Developer Mode in Discord
  and copy the message id."*
- Duplicate binding keys are rejected — only the first would ever be reachable.
- Duplicate menu ids are rejected — *"a button cannot say which of the two it means."*
- **Custom-id budget:** menu id + binding key + Proton's prefix must fit Discord's 100-character
  `custom_id` limit. The error names the actual length and tells the admin to shorten one of the
  two. A live length indicator in the editor would pre-empt this.
- The key `*` is reserved (Proton uses it for the dropdown itself), and keys may not contain
  Proton's custom-id separator.

---

### `tags` — Tags
**Category** utility · **On by default** no · **Schema v1** · **Commands** `/tag`, `/tags create|edit|delete|list|info`
**Intents** Guilds · **Permissions** View Channel, Send Messages
**Limit** `tags` (25 / 125 / 500) · **Data view** Tag library

Saved snippets anybody can post with `/tag <name>`. The tag *contents* live in their own store
(`GET /guilds/:id/tags`), not in config — config only holds behaviour.

Tag names are normalised once on both create and recall: trimmed, lowercased, spaces → dashes,
`^[a-z0-9][a-z0-9._-]*$`, ≤32 chars. Content ≤2000.

**Config**
- `enabled` *(boolean, false)* — "Who may create and edit tags is set in the Permissions module"
- `ephemeral` *(boolean, false)* — Show tags only to whoever asked
- `allowMentions` *(boolean, false)* — "A stored @everyone becomes pingable by any member"

---

### `messages` — Messages
**Category** utility · **On by default** no · **Schema v4 (lift)** · **Command** `/message post|list|send`
**Intents** Guilds · **Permissions** View Channel, Send Messages, Embed Links
**Limit** `savedTemplates` (10 / 50 / 200) · **Areas** Templates / Components

Named messages you compose in the dashboard and post with `/message post`, plus a palette of button
and dropdown rows to drop into them. This module absorbed the retired **announcements** module —
a template can carry a schedule.

**Config**
- `enabled` *(boolean, false)* — "Who may run /message is set in the Permissions module"
- `templates` ⚙︎ *(array, tier-capped)*
- `components` ⚙︎ *(array ≤25)*

**A template** is a full message object plus `name` *(≤32)* and an optional `schedule`. The message
object supports content, embeds, action-row components and Components-V2 layouts, with a mention
policy. Embed limits mirror Discord's: title 256, description 4096, field name 256 / value 1024,
25 fields, footer 2048, author 256, 6000 total.

**A schedule** is `{ channelId, at (ISO timestamp *with* an offset), mode: once|repeat, every?
(duration, ≥1m), pingRoleId?, enabled }`. Deliberately **not cron** — Proton books one explicit next
run. The ISO error is explicit: *"must be a complete ISO timestamp carrying a timezone, such as
2026-01-31T09:00:00Z — without one there is no way to tell which server's 09:00 was meant."* A
repeating template without an interval is refused.

**A saved component** is a whole **row**, not a lone button — `components` on a message is an array
of rows, so a row is what can be dropped in without asking which row to drop it into. Inserting is
a **copy, never a reference**: keys are freshened against the template they land in (`key`, `key-2`,
`key-3`…) because the same key twice in one message is unroutable.

**Custom-id budget again:** template name + component key + Proton's prefix must fit 100 chars; the
error names the length and tells the admin which of the two to shorten.

---

### `leveling` — Leveling
**Category** engagement · **On by default** no · **Schema v4** · **Commands** `/rank`, `/leaderboard`, `/xp give|take|set`
**Intents** Guilds, GuildMessages, GuildVoiceStates · **Permissions** View Channel, Send Messages
**Emits** `xp.level_gained` · **Data view** Leaderboard
**Areas** Earning XP / Level-up / Role rewards / Rank card
**Providers** `leveling.level`, `.xp`, `.messages`, `.voice_minutes`, `.rank_top`, `.level_tier`

XP for talking and for time in voice, level-up announcements, role rewards, and a rendered `/rank`
card. Voice XP is credited **when the member leaves** the channel, not during.

**Config**
- `enabled` *(boolean, false)*
- `xpPerMessageMin` *(0–1000, 15)*, `xpPerMessageMax` *(0–1000, 25)* — **cross-field rule:** min must not exceed max. XP per message is rolled uniformly in this range.
- `messageCooldown` *(duration, `60s`)*
- `voiceXpPerMinute` *(0–100, 5)*
- `afkChannelId` *(channel-id; voice types 2, 13)*
- `excludedChannelIds` *(≤50)*, `excludedRoleIds` *(≤50)*
- `levelUpChannelId` *(channel-id)* — "Empty posts in the member's channel, silencing voice level-ups"
- `levelUpMessage` ⚙︎ *(message object)* — default `{user} reached level {level}.` Placeholders `{user}`, `{level}`, `{xp}`. Same two rules as greetings: an empty message means "level up silently", and only **link buttons** are allowed.
- `rewardMode` *(enum `stack|replace`, `stack`)*
- `roleRewards` ⚙︎ *(array ≤50 of `{ level, roleId }`)* — the same role at the same level twice is rejected
- Rank card: `rankCard` *(false)*, `cardPreset` *(enum, `midnight`)*, `cardAccent` *(colour)* — "Colours the progress bar, the rank number and the avatar ring" — `cardBackgroundUrl` *(https ≤2048; only Discord CDN images load)*, `cardShowRank` *(true)*, `cardShowPercent` *(true)*, `cardShowTotalXp` *(true)*

A scheduled prune job trims activity history. The api serves card previews.

---

### `giveaways` — Giveaways
**Category** engagement · **On by default** no · **Schema v3** · **Command** `/giveaway`
**Intents** Guilds · **Permissions** View Channel, Send Messages, Embed Links
**Limit** `activeGiveaways` (3 / 15 / 60)
**Emits** nine events (`giveaways.created|started|edited|paused|resumed|cancelled|ended|rerolled|bonus_granted`)
**Providers** `giveaways.no_recent_wins`, `.entered_before`, `.role_bonus`, `.booster_bonus`, `.premium_bonus`, `.loss_streak`

Giveaways members enter with a button, drawn and announced by Proton. Five scheduled job types
(start, end, entry-count flush, reconcile, claim window).

**Giveaway instances live in their own store, not in config** — the config below is only the
server-wide defaults and access policy. The dashboard would need a separate giveaway list/detail
surface fed by the module's store.

**Config**
- `enabled` *(boolean, false)* — "Who may run each /giveaway command is set in the Permissions module"
- `defaultWinnerCount` *(1–50, 1)*
- `managerRoleIds` *(role-id ≤25)* — "May pause, edit, end, cancel and reroll any giveaway, not only their own."
- `bypassRoleIds` *(≤25)* — "Skip every requirement on every giveaway. Multipliers still apply."
- `blacklistRoleIds` *(≤25)* — "Cannot enter any giveaway here. Checked before any requirement is evaluated."
- `announceInChannel` *(boolean, true)*, `dmWinners` *(boolean, false)*
- `claimWindowSeconds` *(60 – 7 days, **unset**)* — "Unclaimed wins are forfeited and rerolled". Off by default so a host who never touches it cannot reroll away a legitimate winner who was asleep.
- `logChannelId` *(channel-id)* — Giveaway warning channel
- `embedColor` *(colour, `0x5865f2`)*

**Requirements and multipliers are the interesting part.** A giveaway carries up to 10 requirements
and 10 multipliers, built from **providers** other modules register. That is how a giveaway can
require "level 10+" or "no active moderation case" without the giveaways module importing leveling
or cases. `GET /guilds/:id/providers` lists what is available, each with an id, label, description,
its own Zod config schema (so the dashboard can render a form for it), and a cost hint
(`facts` = free, `query` = hits the database).

Durations: 1 minute minimum, 56 days maximum, with human refusals — *"A giveaway has to run for at
least 1 minute, and "30s" is shorter than that. Anything briefer ends before most members have seen
it."*

**Commands.** `/giveaway` with 18 subcommands — `create` (a modal builder), `start`, `drop`, `end`,
`cancel`, `reroll`, `pause`, `resume`, `extend`, `shorten`, `edit`, `info`, `entrants`, `export`,
`history`, `stats`, `list`, `entries` — plus three groups: `template save|load|list|delete`,
`bonus add|remove|list`, `blacklist add|remove|list`.

---

### `polls` — Polls
**Category** utility · **On by default** no · **Schema v1** · **Command** `/poll create|end|list`
**Intents** Guilds, GuildMessagePolls · **Permissions** View Channel, Send Messages
**Limit** `activePolls` (3 / 15 / 60)

Runs **Discord's own native polls** (not a reaction fake), and announces the result when one closes.

**Config**
- `enabled` *(boolean, false)* — "Who may run /poll is set in the Permissions module"
- `announceResults` *(boolean, true)*
- `announceChannelId` *(channel-id; types 0,5,11,12)* — "Empty announces in the channel the poll was started in"
- `defaultDurationHours` *(number 1–768 — Discord's ceiling is 32 days — default 24)*

---

### `suggestions` — Suggestions
**Category** engagement · **On by default** no · **Schema v1** · **Commands** `/suggest`, `/suggestion <number> <reason>`
**Intents** Guilds · **Permissions** View Channel, Send Messages, Embed Links

Members suggest things, staff accept or deny them, each suggestion optionally keeps its own thread.
Suggestions are numbered and stored outside config. Content ≤1500 chars; decision reason ≤400.

**Config**
- `enabled` *(boolean, false)*
- `channelId` *(channel-id)* — "Needs View Channel, Send Messages and Embed Links there"
- `createThread` *(boolean, false)* — "Also needs Create Public Threads in the suggestion channel"
- `allowSelfVote` *(boolean, true)*
- `anonymous` *(boolean, false)* — "Hide who wrote each suggestion. Proton still stores the author and can tell staff on request"

---

### `starboard` — Starboard
**Category** engagement · **On by default** no · **Schema v1** · **Commands** none
**Intents** Guilds, GuildMessages, GuildMessageReactions
**Permissions** View Channel, Read Message History, Send Messages, Embed Links

Messages the server stars often enough get reposted to one channel. Star counts are **recomputed**
rather than incremented, so removals and Discord's eventual consistency cannot drift the count.

**Config**
- `enabled` *(boolean, false)*
- `boardChannelId` *(channel-id; 0,5,11,12)*
- `emoji` *(string 1–64, `⭐`)* — "Unicode emoji, or a custom one pasted straight from chat"
- `threshold` *(number 1–100, 3)* — Stars needed
- `sourceChannelIds` *(channel-id array ≤50)* — "Empty watches every channel Proton can see"
- `ignoreBots` *(boolean, true)*
- `selfStarAllowed` *(boolean, false)*
- `ignoreNsfw` *(boolean, true)* — Ignore age-restricted channels

---

### `tempvc` — Temporary voice channels
**Category** utility · **On by default** no · **Schema v2** · **Command** `/voice`
**Intents** Guilds, GuildVoiceStates · **Permissions** View Channel, Manage Channels, Move Members, Connect, Manage Roles
**Limit** `tempVcHubs` (2 / 10 / 40)

"Join to create": a member joins a **creator channel** (hub) and Proton makes them their own voice
channel, with a control panel. Privacy is enforced with **real permission overwrites**, never in
application logic alone.

**Server-wide config (generic form)**
- `enabled` *(boolean, false)* — "Does nothing until at least one creator channel is added"
- `ownerCommands` *(boolean, true)* — "Turns off /voice and the control panel everywhere, whatever each creator channel allows"
- `serverCreationLimit` *(number 1–200, 30)* — New channels per minute. "Discord rate-limits channel creation per server; past this Proton waits". Server-wide rather than per-hub because it is a property of the guild.

**Hubs (`hubs[]`) ⚙︎** — the bespoke editor. Each hub has 16 settings **plus** an 11-toggle
permission block:
- `channelId` *(the creator channel)*, `categoryId` *(where new channels go)*, `enabled` *(true)*
- `nameTemplate` *(≤100, `{user}'s channel`)* — must contain one of `{user}`, `{displayName}`, `{username}`, `{userId}` "or every channel it makes has the same name". `{user}` is kept as an alias of `{displayName}` because every stored template already uses it.
- `userLimit` *(0–99, 0)*, `bitrate` *(8000–384000, optional)*
- `privacy` *(enum)* — **public** "anyone who can see it may join" / **locked** "visible, but only trusted members may join" / **private** "hidden from everyone but trusted members"
- `ownerlessMode` *(enum)* — **claim** "Anyone left inside may claim it" / **keep** "It keeps running with no owner" / **transfer** "Hand it to whoever has been in it longest"
- `temporaryRoleMode` *(enum `off|owner|everyone`)* + `temporaryRoleId` — cross-field: a non-`off` mode requires a role, *"pick the role to hand out, or set the temporary role back to nobody."*
- `interfaceEnabled` *(true)* — the in-channel control panel
- `autoDeleteEmpty` *(true)*, `emptyDeleteDelay` *(duration 0–5m, `5s`)* — the delay exists because Discord emits a burst of voice states when somebody switches channel, and an immediate delete races the rejoin
- `maxChannelsPerUser` *(1–10, 1)*, `creationCooldown` *(duration 0–10m, `5s`)*
- `permissionSync` *(enum)* — **off** "start from the category Discord gives it" / **category** "Copy the destination category's overwrites" / **creator** "Copy the creator channel's overwrites"
- `allow` — **eleven boolean toggles**, all default true: rename, limit, privacy, trust, block, invite, kick, region, claim, transfer, delete

**Commands.** `/voice rename|limit|privacy|member|region|claim|delete` — each gated by the
corresponding `allow` toggle *and* by `ownerCommands`.

---

### `reminders` — Reminders
**Category** utility · **On by default** no · **Schema v1** · **Commands** `/remind`, `/reminders list|cancel`
**Intents** Guilds · **Permissions** View Channel, Send Messages
**Limit** `remindersPerUser` (10 / 50 / 200 — **per member**)

Members ask Proton to remind them later, in the channel they asked from. Reminder text ≤1500 chars;
`/reminders list` shows 25.

**Config**
- `enabled` *(boolean, false)*
- `minDuration` *(duration, `30s`)* — Soonest
- `maxDuration` *(duration, `365d`)* — Furthest ahead
- **cross-field rule:** min must not exceed max, *"or every reminder in this server would be refused."*

Every refusal is written for the member, not the admin — including the case where the *stored
bounds themselves* are unreadable, which names the two values and tells the member an admin must fix
them under Reminders in the dashboard.

---

### `counters` — Counter channels
**Category** utility · **On by default** no · **Schema v1** · **Command** `/counters refresh`
**Intents** Guilds · **Permissions** View Channel, Manage Channels
**Limit** `counters` (5 / 25 / 100)

Channels whose *names* carry a live count — members, roles, or channels. **Proton creates and owns
these channels** (they are created in the refresh job and filed in a store); a counter may
alternatively be pointed at a channel somebody else made, which is the only shape that existed
before.

Refresh is **every 10 minutes, not instant**, and this is a floor rather than a default with
deliberately no setting: Discord's channel-rename bucket is two per ten minutes per channel.

**Config**
- `enabled` *(boolean, false)* — "Counts refresh every 10 minutes, not instantly"
- `counters` ⚙︎ *(array, tier-capped)*

**A counter:** `{ id (≤32, slug), channelId? , template (≤90), source }`
- `channelId` **absent** → Proton makes the channel and owns it. **Present** → Proton renames a channel somebody else made. Description: *"Discord rewrites text channel names to lowercase-with-dashes"*.
- `template` must contain `{count}` — *"that is where the number goes, as in "Members: {count}". Without it the channel would be renamed to a fixed string that never changes."*
- `source` *(enum `members|roles|channels`)*
- Two counters cannot share a channel (*"they would rename it in turn and each one would spend the other's rename allowance"*) or an id.

---

## 5.5 What gets written down

---

### `serverlog` — Server logs
**Category** logging · **On by default** no · **Schema v1** · **Commands** none
**Intents** Guilds, GuildMembers, GuildModeration
**Permissions** View Channel, Send Messages, Embed Links, View Audit Log
**Areas** Categories / Individual events / Filters

Discord's own audit events routed to the channels you pick. **Three levels of routing, most
specific wins:** per-event override → per-category channel → default channel.

**Thirteen categories**, each with a toggle and a channel:

| Category | Default on? |
|---|---|
| Server | on |
| Channels | on |
| Roles | on |
| Members | on |
| Messages | **off** |
| Voice | **off** |
| Moderation | on |
| Invites | on |
| Integrations | on |
| Emoji & stickers | on |
| Events & stages | on |
| AutoMod | on |
| Proton | on |

**Config**
- `enabled` *(boolean, false)*
- `defaultChannelId` *(channel-id, text types only)* — "Category and per-event channels override this"
- `categories` *(object of 13 booleans)*
- `categoryChannels` *(object of 13 channel refs)* — kept as **two parallel one-level objects** rather than one two-level object, because the form generator walks a top-level object but refuses to nest twice
- `events` ⚙︎ *(record: eventKey → `{ enabled?, channelId? }`)* — the bespoke **event matrix**, **88 rows** across the 13 categories. An unknown key is rejected: *"'x' is not a log Proton knows about — it was probably renamed. Remove it."*
- `ignoredChannelIds` *(≤100)*, `ignoredRoleIds` *(≤50)*, `ignoredUserIds` *(≤100)*, `ignoreBots` *(false)*

Channel refs are plain strings with a permissive pattern (`^(\d{17,20})?$`) rather than a union with
`z.literal('')`, because the form generator builds a channel picker from `ZodString` only and
rejects a union outright. Empty means "inherit".

---

### `logging` — Message logs
**Category** logging · **On by default** no · **Schema v2** · **Commands** none
**Intents** Guilds, GuildMessages, MessageContent · **Permissions** View Channel
**Cron job** partition maintenance

Edited and deleted messages, archived for **30 days**. It stores personal data, so it is **off by
default** and the label says so.

Two distinct stores with separate consent:
1. The 30-day archive (partitioned, maintained by a cron job).
2. An in-memory cache of *recent* message text, so a deletion log can show what was deleted. Its own
   toggle and its own retention.

**Config**
- `enabled` *(boolean, false)* — "Stores message content — personal data — for 30 days"
- `logEdits` *(boolean, true)*, `logDeletes` *(boolean, true)*
- `ignoredChannels` *(channel-id array ≤50; types 0,5,11,12)*
- `cacheMessageContent` *(boolean, false)* — "Personal data, held in memory apart from the 30-day archive"
- `cacheRetention` *(duration, `24h`)*

Message-log retention is a **recorded product decision: opt-in, 30 days.** The dashboard has legal
copy components (`components/legal/privacy-policy.tsx`) and `/privacy` + `/terms` routes.

---

## 5.6 The server itself

---

### `branding` — Branding
**Category** utility · **On by default** no · **Schema v3 (lift)** · **Command** `/branding`
**Intents** Guilds · **Permissions** Change Nickname, Manage Roles
**Flagged server-level** — sits above the categories, not beside Tickets and Tags

What Proton is called and what it looks like **in this server only**. Other servers are unaffected.

There is deliberately **no applied-state table** — teardown happens in the listener. Avatar and
banner are uploaded through their own API routes (`GET|PUT|DELETE /guilds/:id/branding/:kind`) and
stored as hashes whose only job is to change when the image does, so a save reconciles and the
fingerprint sees a new picture.

**What Discord does and does not allow a bot to set** — a real constraint on this page's copy:
per-guild nickname, avatar, banner and bio **are** settable; fonts, name effects and profile colours
are **not** directly settable. So:

- `typeface` works by spelling the name in **Unicode look-alike letters**. The description says so
  plainly: *"Discord has no font setting a bot can use… Members can still mention Proton, but
  searching the member list for its plain name stops finding it, and screen readers read the letters
  out one at a time."*
- `nameEffect` works by **colouring a role Proton holds here**. Gradient and holographic require the
  server to have Discord's Enhanced Role Colours feature.
- `bio` is **write-only** — it can be set but not read back.

**Config**
- `enabled` *(boolean, false)*
- `nickname` *(string 1–32, optional)* — "leave it empty to use its own name"
- `bio` *(string ≤190, optional)* — Discord documents no maximum; 190 is what its own client enforces
- `typeface` *(enum, `none`)*
- `nameEffect` *(enum `none|solid|gradient|holographic`, `none`)*
- `primaryColor` *(colour, `0x0ab9fe` — brand cyan)*, `secondaryColor` *(colour, `0x5944ec` — brand violet)*
- `restoreOnDisable` *(boolean, true)* — "Clears the nickname, avatar, banner and bio in this server when this module is turned off"
- `avatarHash`, `bannerHash` ⚙︎ — not admin-editable; written by the upload route

A blocklist of disallowed names is deliberately **kept out of `configSchema`**.

---

### `backup` — Backup
**Category** security · **On by default** **yes** · **Schema v1** · **Command** `/backup create|list|restore`
**Intents** Guilds · **Permissions** View Channel

Snapshots this server's channels and roles. **`/backup restore` previews until it is confirmed** —
this is the *only* dry run anywhere in Proton. Everything else Proton does is performed for real in
every environment; there is no staging/production rail.

**Config**
- `enabled` *(boolean, true)*
- `retainBackups` *(number 1–25, 10)* — "A new snapshot deletes the oldest beyond this count"

The restore confirmation is a `confirm` option on the command. A dashboard equivalent needs a
genuine diff preview + explicit confirmation, not a modal saying "are you sure".

---

### `help` — Help
**Category** utility · **On by default** **yes** · **Schema v1** · **Command** `/help`
**Intents** Guilds · **Permissions** View Channel

The `/help` overview of what Proton does, and the link that sends a member back to the dashboard.

**Config**
- `enabled` *(boolean, true)*
- `ephemeral` *(boolean, true)* — "Turn this off to post the overview into the channel, where everyone can read it."

---

### `ping` — Ping
**Category** utility · **On by default** **yes** · **Schema v1** · **Command** `/ping`
**Intents** Guilds · **Permissions** View Channel, Send Messages

Answers `/ping`, so anyone can tell whether Proton is responding. Its manifest declares a `general`
section with **zero fields** — the only module whose settings page is effectively empty besides the
switch and two trivial fields.

**Config**
- `enabled` *(boolean, true)*
- `response` *(string 1–200, `Pong!`)* — Reply text
- `restrictToChannel` *(channel-id nullable, null; text only)*

---

## 6. Cross-cutting mechanics a dashboard design must respect

### 6.1 Duration is a string, not a number
Everywhere a length of time appears it is a string like `30s`, `10m`, `1h`, `7d`, `2w` — parsed with
a shared parser. The `duration` field kind exists for it. Invalid durations are caught on save, and
modules that read an unparseable stored duration refuse loudly with a message naming the field and
telling the admin which dashboard page to fix it on.

### 6.2 Cross-field validation exists and must render inline
At least seven modules carry `superRefine` rules that fail on one field because of another's value:

| Module | Rule |
|---|---|
| `antiraid` | `brandNewAccountAge` ≤ `newAccountAge` |
| `reminders` | `minDuration` ≤ `maxDuration` |
| `leveling` | `xpPerMessageMin` ≤ `xpPerMessageMax` |
| `cases` | ladder strictly increasing; timeout rungs need a duration |
| `tempvc` | non-`off` temporary-role mode needs a role; no duplicate creator channels |
| `counters` | no duplicate channel or id; template contains `{count}` |
| `rolemenu` | reaction menus need a message id; no duplicate keys; custom-id length |
| `tickets` | no duplicate type/panel/response ids |
| `appeals` | no duplicate panel ids or question keys |
| `messages` | no duplicate template names; custom-id length |
| `automod` | regex validity and catastrophic-backtracking check |

The error carries a `path`, including array indices (`['components', 2, 'buttons', 0, 'style']`), so
the editor can anchor the message to the exact row.

### 6.3 `showWhen` — conditional fields
`{ path, equals: string[] }`. Used today by `verification` (5 captcha fields + 1 nested) and
`honeypot` (5 fields). Values are compared as strings, including booleans (`equals: ['true']`).

### 6.4 Message objects are a first-class type
Six modules store an authored Discord message rather than a string: `welcome` (×2), `verification`,
`leveling`, `honeypot` (×2), `messages` (many). They share one schema — content, embeds, action-row
components, Components-V2 layout, mention policy — one builder, and one preview. The dashboard
already has `components/message/{builder,preview,markdown}.tsx`.

Per-module restrictions the same builder must enforce differently:
- **welcome / leveling**: link buttons only; an empty message means "post nothing"
- **verification**: no components at all and no V2 layout — Proton owns the one row
- **honeypot**: its own layout refinement
- **messages**: everything allowed, plus custom-id budgeting

### 6.5 Emoji
Guild emoji are fetched through a dedicated rest-proxy call. A generated Unicode emoji table exists
but must stay behind a **dynamic import** — it is large enough to matter to the bundle.

### 6.6 Actions, events and idempotency
- Every state-changing Discord operation goes through a single **`ActionExecutor`**; there are
  **40 action kinds** (`send`, `ban`, `create_channel`, `set_bot_profile`, `giveaway_draw`, …).
- A module's manifest **must declare** every action kind it uses; an undeclared kind throws at boot,
  and `invitePermissions()` is derived from the union — so a missing declaration means the bot is
  never invited with the permission and the action silently fails its precheck.
- Modules **never import other modules.** Cross-module effects go over the event bus. There are
  **72** internal event types.
- **Every event arrives at least twice.** Gateway RESUME redelivers. Every handler and executor call
  carries an idempotency key. Anything the dashboard shows as a count or a feed must tolerate this.
- Interactions are deferred within 3 seconds if the handler touches the database or Discord REST.
  So a dashboard button that triggers Discord work should show "requested", then resolve.

### 6.7 Providers — reusable conditions and multipliers
14 providers across three modules (`cases` ×2, `leveling` ×6, `giveaways` ×6). Each carries an id
namespaced to its owning module, a label, a description, its own Zod config schema, and a cost hint
(`facts` = free from the event payload, `query` = database round-trip). `GET
/guilds/:id/providers` enumerates them. A condition can report **indeterminate** — "judged nothing"
as distinct from "judged and said no" — which names a missing intent or absent fact, and the UI must
not render it as a failure the member can act on.

### 6.8 Permissions and intents to surface
Privileged intents in use: **Server Members** and **Message Content**. Presence is not used. Modules
needing Message Content: `automod`, `honeypot`, `logging`, `phishing`. Modules needing Server
Members: `antiraid`, `joinroles`, `serverlog`, `verification`, `welcome`.

A module whose required intent or permission is missing reports it through
`status.disabledReason = { code, humanReason }`. The dashboard must show this as a distinct state
from "the admin turned it off".

---

## 7. Summary table

| Module | Category | Nav group | On? | Commands | Bespoke UI | Areas | Tier limit | Postables |
|---|---|---|:-:|---|:-:|:-:|:-:|:-:|
| verification | security | Joining | — | `/verify`, `/quarantine` | ✓ | — | — | ✓ |
| joinroles | utility | Joining | — | — | — | — | — | — |
| welcome | engagement | Joining | — | — | ✓ | 3 | — | — |
| automod | security | Safety | — | — | — | 4 | — | — |
| antiraid | security | Safety | — | — | — | — | — | — |
| antinuke | security | Safety | ✓ | `/antinuke` | — | — | — | — |
| phishing | security | Safety | ✓ | `/phishing` | — | — | — | — |
| honeypot | security | Safety | — | — | ✓ | 7 | ✓ | — |
| moderation | moderation | People | ✓ | 7 commands | — | — | — | — |
| cases | moderation | People | ✓ | — | ✓ | — | — | — |
| appeals | moderation | People | — | — | ✓ | — | ✓ | — |
| permissions | utility | People | ✓ | — | ✓ | — | — | — |
| tickets | utility | Members | — | `/ticket` | ✓✓✓ | — | ✓✓✓ | ✓ |
| rolemenu | engagement | Members | — | `/rolemenu` | ✓ | — | — | ✓ |
| tags | utility | Members | — | `/tag`, `/tags` | — | — | ✓ | — |
| messages | utility | Members | — | `/message` | ✓✓ | 2 | ✓ | — |
| leveling | engagement | Members | — | `/rank`, `/leaderboard`, `/xp` | ✓✓ | 4 | — | — |
| giveaways | engagement | Members | — | `/giveaway` | — | — | ✓ | — |
| polls | utility | Members | — | `/poll` | — | — | ✓ | — |
| suggestions | engagement | Members | — | `/suggest`, `/suggestion` | — | — | — | — |
| starboard | engagement | Members | — | — | — | — | — | — |
| tempvc | utility | Members | — | `/voice` | ✓ | — | ✓ | — |
| reminders | utility | Members | — | `/remind`, `/reminders` | — | — | ✓ | — |
| counters | utility | Members | — | `/counters` | ✓ | — | ✓ | — |
| serverlog | logging | Written down | — | — | ✓ | 3 | — | — |
| logging | logging | Written down | — | — | — | — | — | — |
| branding | utility | Server | — | `/branding` | ✓ | — | — | — |
| backup | security | Server | ✓ | `/backup` | — | — | — | — |
| help | utility | Server | ✓ | `/help` | — | — | — | — |
| ping | utility | Server | ✓ | `/ping` | — | — | — | — |

---

## 8. What a dashboard design has to solve

Ranked by how much design work they actually represent.

1. **One page shape that scales from 2 fields to 45.** `ping` has three settings; `automod` has
   forty-five; `tickets` has nine plus three collection editors. The same chrome must not make the
   small ones look broken or the large ones unusable. Areas (sub-pages) are the existing answer for
   six modules — the design should decide whether that generalises.
2. **Twelve bespoke collection editors.** Ticket types/panels/responses, tempvc hubs, rolemenu menus,
   appeal forms, counters, honeypot bait channels, leveling role rewards, cases escalation ladder,
   messages templates/components, serverlog’s 88-row event matrix, permissions' ~25-command role
   matrix. These are the product, not an afterthought — and each needs list → detail navigation,
   inline validation anchored to array indices, and a tier-limit counter.
3. **A message builder used six ways with different restrictions.** Content, embeds, components,
   Components-V2, mention policy, placeholder substitution, live preview, custom-id length budget.
4. **Progressive disclosure driven by data** (`showWhen`) rather than hand-authored per page.
5. **Three states per module, not two.** Off by the admin; on; and *cannot run here* (missing intent,
   permission or tier) with a reason string to render.
6. **Async by default.** Posting a panel, restoring a backup and bulk role runs are requests with
   receipts, not synchronous results. The UI needs a vocabulary for "requested → happening → done".
7. **Tier limits as ambient information** — counters on list editors, not locked doors. No module is
   tier-gated; only volume is.
8. **Records vs settings.** Five data views (cases, blocked members, ticket queue, leaderboard, tag
   library) plus giveaway and suggestion lists that currently have no dashboard surface at all.
9. **Privacy copy is load-bearing.** `logging`, `tickets.captureMessages`, `suggestions.anonymous`
   and `honeypot` all store personal data behind an explicit opt-in, and the labels say so.
10. **Error copy is written for administrators and must be shown verbatim.** These are full
    sentences explaining the consequence, not developer strings to be replaced with "Invalid input".
