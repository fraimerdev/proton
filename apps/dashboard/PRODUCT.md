# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Discord server administrators — the same audience the mainstream multipurpose bots serve. Typically the
owner or a small staff team of a community, gaming, creator or interest server, not security
professionals. They are Discord-fluent and interface-fluent, but not administrators by trade: they know
roles, channels, permissions and embeds by heart, and they learn a bot by clicking through it rather than
by reading documentation. They arrive already using one or more bots and are deciding whether one
platform can replace them. They configure in bursts — set something up, leave it running for weeks, come
back when something breaks or when the server grows.

## Product Purpose

Proton is one bot that covers what a Discord server normally installs several bots to get: moderation,
automatic moderation, anti-raid and anti-nuke protection, verification, honeypot traps, tickets, appeals,
leveling, giveaways, starboard, polls, suggestions, role menus, temporary voice channels, welcome
messages, counters, reminders, tags, backups, phishing-link blocking, branding, and Discord audit-event
logging. Success is a server owner running Proton alone where they used to run three or four bots, and
being able to answer "what did this bot do in my server, and why" at any point.

## Positioning

The owner's framing: **"Why MEE6 when you've got Proton?"** Proton competes for the mainstream
multipurpose-bot audience rather than positioning itself as niche security tooling — but it carries depth
those bots do not:

- **Everything is written down.** Every state-changing action goes through one executor and lands as a
  numbered case carrying the moderator, the target, the reason typed and the time. Reversals attach to the
  case they undo instead of rewriting it, and actions Proton takes on its own are recorded beside human
  ones.
- **It refuses to pretend.** Every module ships switched off. When Proton cannot act it names the exact
  permission or privileged intent it is missing, in the wording the server's own settings use, rather than
  failing silently. A module that cannot run is never greyed out — its switch stays live, so the admin can
  always turn it back off.
- **Serious protection sits beside the community features.** An anti-nuke breaker, join-rate anti-raid
  gating, honeypot channels and verification live in the same product, config store and case ledger as
  leveling and giveaways.

## Operating Context

Configured on the web, used in Discord. Almost every setting produces something a member sees inside
Discord — an embed, a panel with buttons, a role, a channel, a logged event — so the dashboard's job is
to make the Discord-side result predictable before it is posted. Admins work per server and often
administer more than one. The product spans five runtime services (gateway, worker, REST proxy, API,
dashboard); the dashboard never talks to Discord directly, so some data an admin might expect (live member
counts, per-guild permission truth) is not available to it today.

## Capabilities and Constraints

- 30 modules, 121 slash commands (counted at subcommand level), 88 Discord audit-log events across 13
  categories, all derived in-app from the catalogue rather than hard-coded.
- Sign-in is Discord OAuth, scopes `identify`, `guilds` and `guilds.members.read`. Only servers where the
  visitor is owner or holds Manage Server are listed.
- Modules default to off; a module's row is written only on first save.
- Entitlement tiers exist (free / plus / pro) and cap list sizes — ticket panels and types, tags, counters,
  temp-VC hubs, saved templates, honeypot channels, appeal forms, polls. No module is gated as a whole,
  and no prices are published anywhere in the product.
- Message-log and ticket-transcript capture are opt-in and expire after 30 days.
- Not available to the dashboard today: live member counts, real per-guild permission checks (the API
  reports every permission as granted), and any tier that is not "free" (nothing writes one).
- Terminology the product uses with members and admins: server, channel, role, member, module, switch,
  case, appeal, ticket, panel, giveaway, level, XP.

## Brand Commitments

- **Standing preference: the category standard, played straight.** Offered a derived visual world
  (a matchday/league-table system) against the conventional one, the owner chose convention on purpose.
  Proton keeps the shape its category's users already know — a marketing site that explains and
  demonstrates, and a sidebar dashboard of per-module settings — and competes on execution quality rather
  than on an invented metaphor. Do not re-pitch a metaphor-led identity.
- **Craft bar: MEE6, Dyno and Carl-bot, beaten on execution.** The comparison set is the category's own
  products; the bar is clearer hierarchy, better controls, better copy and less clutter than any of them.
- **The conventional shape does not license the generic-AI look.** The owner's ban list holds inside the
  convention: no gradient hero or gradient text, no glowing orbs or decorative glows, no glassmorphism or
  gratuitous blur, no oversized radii, no everything-in-a-floating-card or nested cards, no pill soup or
  ornamental badges, no icon+heading+description grids or repeated three-column feature sections, no giant
  cards holding almost nothing, no fake charts, no generic purple/blue SaaS palette, no vague marketing
  headlines, and no single settings template reused for every module.
- The Proton mark (`/proton-mark.png`) and the name "Proton" are fixed.
- Discord's own conventions are respected: blurple for Discord actions, message and embed previews that
  look like genuine Discord output, role colours, and channel-type distinctions.
- Not affiliated with or endorsed by Discord Inc., and the product says so.

## Evidence on Hand

- A working signed-in dashboard against a real test server, with real cases, modules and configuration.
- Genuine Discord output previews already built from the product's own renderer (`components/site/scene.tsx`,
  `components/message/preview.tsx`) — moderation replies, a rank card, a starboard post, a ticket panel, a
  server-log embed, a refusal message.
- Module artwork for six modules in `public/art/modules/`.
- No testimonials, no customer names, no user counts, no benchmarks, no pricing. None of these may be
  invented.

## Product Principles

1. Every claim the interface makes must be checkable against what the code actually does.
2. Show the Discord-side result rather than describing it; the admin should never have to imagine what a
   setting will produce.
3. Nothing runs until someone switches it on, and the interface says plainly when something cannot run and
   what to do about it.
4. Depth is available but never mandatory: a first-time owner and an experienced admin use the same
   screens, and neither is punished.
5. The record is permanent and legible — what happened, who did it, and why, retrievable months later.

## Accessibility & Inclusion

WCAG AA is the working floor: body text at 4.5:1, control borders and state graphics at 3:1, visible
keyboard focus everywhere, state never carried by colour alone (every state colour has a word beside it),
and `prefers-reduced-motion` honoured.
