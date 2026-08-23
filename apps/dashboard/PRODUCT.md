# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Discord server owners and their admin/mod staff — anyone the server grants `MANAGE_GUILD`, or a
staff role resolved through `guilds.members.read`. They arrive holding a specific intent ("turn
on tickets", "why did the welcome message stop", "find case #412") and leave once it is done.

Usage is **config-first**: the centre of gravity is switching modules on and configuring them.
Day-to-day operations — reading the case ledger, checking the leaderboard — happen too, but one
level deeper, not on the way in.

Physical scene: a wide desktop screen, in Discord's own visual company, usually with the server
open in another window or on a second monitor. Phones are a real secondary surface that must work
and must not embarrass, but the design is sized for desktop.

## Product Purpose

Proton is one Discord bot covering moderation, security and engagement, with this dashboard as its
only configuration surface. The dashboard exists so an admin can see exactly what Proton is
allowed to do in their server, change it, and have the change be live in Discord immediately.

Success: an admin finds the switch or field they came for in seconds, changes it, and trusts that
the change took effect.

## Positioning

The stated success metric for the whole product is **predictable degradation**, not flawlessness.
When Discord's API misbehaves Proton queues rather than drops, and it names the exact missing
permission or intent instead of failing silently. Every state-changing action becomes a numbered,
searchable, reversible case with actor, target, reason and time. Competitors in this category
(MEE6, Sapphire, Wick) do not make the audit trail the product.

## Operating Context

- Configuration is per-server. A user may administer several servers and switches between them.
- Modules are loaded from Proton's own deployment; a server cannot add or remove modules, only
  switch the ones it has on and off and configure them.
- ~27 modules exist, grouped into five categories: Moderation, Security, Engagement, Utility,
  Logging.
- Every module's settings form is **generated** from its Zod schema into `FieldDescriptor[]`.
  Supported field kinds: `string`, `number`, `boolean`, `enum`, `channel-id`, `role-id`,
  `duration`, and flat arrays of those; objects nest one level. Some modules add bespoke panels
  (server-log event matrix, role-menu builder, escalation ladder, embed preview, ticket panels).
- Three modules also carry data views reached as tabs: cases (filterable ledger), leveling
  (leaderboard), tags (browser). All table filter state lives in Zod-validated URL search params
  and must stay shareable by URL.
- Unsaved settings edits are blocked on navigation and confirmed before discarding.
- No websockets in v1; freshness comes from TanStack Query refetching.
- Auth is Discord OAuth (`identify`, `guilds`, `guilds.members.read`). The browser never talks to
  Discord directly; every mutation is authorised and audited server-side.

## Capabilities and Constraints

- Stack is fixed: TanStack Start (React), TanStack Router/Query, hand-written CSS in a single
  stylesheet, Bun. Pinned exact versions for `@tanstack/*`.
- Dark only. `color-scheme: dark` is declared at the root and there is no light theme.
- Discord's API cannot report a bot's own guild permissions, so Proton can never truthfully claim
  "everything is fine". It can only report the failures it knows about.
- Members are shown by ID, not name: Discord's rate limits do not permit fetching a whole member
  list.
- Channels the bot cannot view are never returned by Discord and so cannot be listed.
- English only in v1, but strings stay externalizable.
- **Owner directive (2026-08-21): the server home is the module list and nothing else.** No stats
  strip, no health section, no activity feed, no "needs attention" page. Users see only what they
  need to see. A module's own inability to run stays visible on that module (its row and its page),
  because a silently dead module contradicts the product's core promise — see Product Principles.

## Brand Commitments

- Name: **Proton**.
- The mark (`apps/dashboard/public/proton-mark.png`) is a circular wireframe node graph — vertices
  joined by thin edges — filled with a cyan → blue → violet gradient. It is the one fixed visual
  asset.
- Voice: plain, specific, non-hyped. It names the thing that went wrong and where to fix it. No
  exclamation marks, no marketing adjectives, no emoji.
- Not Discord. Proton must read as a tool that manages a Discord server, not as a Discord clone,
  and must never copy Discord's, MEE6's, Sapphire's or Wick's assets or layouts.
- **Standing preference (2026-08-21): familiarity over invention.** Offered a set of distinctive
  visual worlds, the owner chose the category standard — the arrangement people already know how
  to use — rendered in Proton's own theme. The craft bar they named is **Discord's own settings**
  (for familiarity and native-feeling affordances) and the **Stripe Dashboard** (for typographic
  discipline, authoritative tables, and state carried by precise small type rather than colour
  blocks). Future visual work meets that bar; it does not reopen the choice.

## Evidence on Hand

- Real: the module catalog and every module's real field schema; the case record shape; the
  leaderboard and tag query results; Discord channel/role lists for the connected guild.
- Real: the brand mark, favicon, apple-touch-icon.
- Absent, and not to be invented: pricing, plan names beyond the existing `insufficient_entitlement`
  state, customer counts, testimonials, uptime figures, server counts, benchmarks.
- Message volume is genuinely not measured — message logging is opt-in and off by default.

## Product Principles

1. **Show only what this person needs for the job they came for.** Density is not the enemy;
   irrelevance is.
2. **Never fail silently.** If Proton cannot do something, the surface names what is missing and
   where to fix it. "The bot did nothing" is a bug.
3. **State is honest.** Never claim health that cannot be verified; distinguish "switched off",
   "cannot run" and "not on this plan".
4. **Every change is auditable and addressable.** URLs carry filter state; every mutation is
   audited; unsaved work is never lost quietly.
5. **Configured here, run in Discord.** The dashboard is a control surface, not a second Discord.

## Accessibility & Inclusion

Keyboard-complete: skip link, focus trapping in dialogs, visible focus rings, `aria-current` on
navigation, live regions for save and failure messages. Colour is never the only carrier of state.
Target WCAG 2.1 AA contrast against the dark ground.
