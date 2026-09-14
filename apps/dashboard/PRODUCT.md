# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, weighted equally (owner, 2026-09-13):

- **Server owners and administrators deciding on a bot.** They run a Discord community and are
  comparing bots for moderation, security and community tooling. Their job on the public site is to
  understand what Proton covers and add it to a server or sign in.
- **Existing Proton admins and moderators.** They already run Proton and come back to configure a
  server in the dashboard, look up a command, or check a policy. Their job is to get where they are
  going quickly.

## Product Purpose

Proton is one Discord bot and a web dashboard that together cover moderation, security and
community engagement for a server. Success is predictable behaviour rather than flawlessness: when
Discord misbehaves Proton queues instead of dropping work, and when it cannot act it tells the admin
exactly which permission or intent is missing and where.

## Positioning

**One bot for everything** (the edge the owner chose to lead with): Proton's modules replace the
stack of separate bots a server usually runs for moderation, security and engagement, configured
from one dashboard. Supporting truths from the product, not the lead: it names the missing
permission or intent instead of failing silently; every action it takes becomes a numbered case;
nothing is switched on until an admin switches it on.

## Operating Context

- Members meet Proton inside Discord: slash commands, buttons, select menus, panels, embeds and
  Components V2 messages in the server's channels.
- Admins configure it in the dashboard after signing in with Discord (scopes: `identify`, `guilds`,
  `guilds.members.read`), picking a server they own or hold Manage Server in.
- The public site has a landing page, a command reference, an FAQ, privacy and terms pages, and an
  invite route that asks Discord for exactly the permissions the installed modules need.
- Production runs at `prtn.xyz`.

## Capabilities and Constraints

- Modules, by group (source of truth: `src/lib/modules/catalogue.ts`, each with a code-checked
  one-line description):
  - Joining: Verification, Join Roles, Welcome & Goodbye.
  - Security: Automod, Anti-Raid, Anti-Nuke, Phishing, Honeypot.
  - Moderation: Moderation, Cases, Appeals, Permissions.
  - Member tools: Tickets, Role Menus, Tags, Messages, Leveling, Giveaways, Polls, Suggestions,
    Starboard, Temporary Voice Channels, Reminders, AFK, Counters.
  - Logs: Server Logs, Logging. Server: Branding, Backup, Help, Ping.
- The command reference is generated from the bot's real commands (`src/components/site/command-set.gen.ts`).
- Tiers are Free, Plus and Pro (Discord App Subscriptions and Stripe). Limits are shown as ambient
  counters, never paywalls. No public pricing exists; prices are undecided on the site.
- Privacy defaults: every module starts off; message logging and ticket transcripts are opt-in;
  stored message content is deleted after 30 days. Privileged intents are Server Members and
  Message Content; Presence is not used.
- Destructive actions are performed for real; every state change goes through one action executor
  and lands in the case log.

## Brand Commitments

- Name: Proton. Marks: `assets/brand/proton-mark.png` (transparent mark, used in the UI) and
  `assets/brand/proton-icon.png` (tiled icon, favicon and touch icon).
- The logo's spectrum (cyan, blue, indigo, violet) is Proton's identity. The owner allows it to make
  large brand moments on the landing page; the dashboard stays restrained.
- Voice: concise, plain, functional, administrative rather than promotional. No marketing clichés,
  no AI filler, "Proton" only where it adds clarity.
- Everything is an original implementation: no copied code, assets, embed layouts or branding from
  MEE6, Sapphire, Wick or any other bot.
- Discord interface shown on Proton's surfaces reproduces Discord's own look accurately and is a
  picture of what Proton does.

## Evidence on Hand

- The product itself: accurate Discord message rendering (`src/components/discord/`), the dashboard,
  the generated command set, the module catalogue and its descriptions, the FAQ and privacy copy.
- Absent and never to be fabricated: server or member counts, uptime or performance figures,
  testimonials, customer or partner logos, press, ratings and prices. Demonstrations of Proton at
  work are illustrative and must be labelled as such wherever a visitor could take them for a real
  server.

## Product Principles

1. Show the work instead of claiming it: Proton doing its job in Discord is the proof.
2. One place for the whole job: modules share one dashboard, one case log and one voice.
3. Say exactly what is wrong: a refusal names the missing permission or intent and where.
4. Off until switched on: nothing acts, logs or stores until an admin chooses it.
5. Honest by default: no invented numbers, customers or capabilities.
