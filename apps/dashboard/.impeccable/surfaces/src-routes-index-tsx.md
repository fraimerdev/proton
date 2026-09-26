---
version: 1
slug: "src-routes-index-tsx"
primary_target: "src/routes/index.tsx"
related_targets: ["src/components/site/landing-discord.tsx","src/components/site/landing-dashboard.tsx","src/styles/landing.css"]
---

# Landing page (`/`)

## Scope and mode

The public landing page. Mode: Persuade.

## Audience, job, action

- Server owners and admins deciding on a bot: understand the breadth, then **Add to Discord** (`/invite`,
  also in the header on every public page).
- Existing Proton admins: **Open the dashboard** (goes to `/signin` when signed out) or the command reference.
- Proof is the product itself: Discord UI reproduced with Discord's own look. Every Discord example copies
  Proton's real output format from the module code. The hero and the dashboard shot are captioned
  illustrative; the feature rows are not (owner, 2026-09-18). No invented
  counts, testimonials, logos or prices.
- Lead belief (owner): one bot for everything.

## Chosen direction

The familiar bot-site structure played at full polish (owner's pick; peers: other bot sites and modern
product sites), carrying the **Spectral edge** treatment (seed key 50f22bd7): the page stays graphite and
achromatic; the logo spectrum appears only as 2px edges on what Proton touches — the top edge of each
Discord window and the dashboard shot, the hero's Proton messages, the primary CTA's underline and the
closing card's top edge. No gradient text.

One owner-requested depth moment (2026-09-18, from a SaaS reference) is the only glow on the page: a
diffused cyan → blue → violet glow behind the hero preview, which sits in a translucent bezel
(`.landing-frame`). It is layered radial gradients on a pseudo-element; the page ground stays graphite.
Don't strip it in a "no glow" sweep, and don't spread glow to other sections.

The closing CTA is a flat `--surface-1` card with the Discord windows' 12px radius and spectrum top edge,
laid out like the page's split sections (heading and line left, actions right; stacked below 1000px). The
owner rejected a centred card with an inner glow, gradient surface and ring as looking AI-generated.

Order: centred hero (headline, lede, Add to Discord + Open the dashboard, commands link) over a Discord
client window (#general: a welcome, a member reply, the default level-up line) with a floating #mod-log
(Honeypot's incident embed, then Anti-Raid's raid-mode alert) → a scroll story (owner's pick, 2026-09-18,
replacing the zig-zag rows; the owner tried a pinned stage with tabs and went back to this): a sticky rail
of seven headings — Joining (#verify panel + #welcome greeting), Security (Anti-Nuke and Phishing alerts),
Moderation (/warn status embed, appeal card), Tickets (panel + #ticket-42 welcome container), Leveling
(level-up line + /rank card image), Community (giveaway card), Dashboard (the real-component shot, moved
in) — where the step whose example crosses the viewport centre turns primary, takes the sidebar's cyan
inset marker and opens its lede and modules. Each example's messages play in once when it is 45% visible.
Verify, Support, Claim and Enter giveaway are real buttons answering with Proton's exact ephemeral status
embeds ("Proton is thinking…" first where Proton defers); every string was traced to the module code.
Below 1000px the story stacks via `display: contents` + `--step` order → the module index as the page's
second peak (owner's pick): a full-bleed `--app-topbar` band, the heading at hero scale, per-group counts,
icons on neutral dashboard-style tiles → storage statements (split layout) → closing CTA card.

## Memorable moment

The hero chat comes alive: messages arrive in sequence and a spectrum edge draws across each Proton
message group as it lands. The sequence is paused from first paint and starts once 60% of the #general message column is on screen.

## Unresolved

- The public header is a floating surface-1 island (Modules, Commands, FAQ; Add to Discord secondary; the
  blue primary is Log in with Discord or Open the dashboard). The landing CTA stays white with the spectrum
  edge; the nav carries no spectrum.
- The story's highlight and the hero chat are the page's only scroll-driven behaviours; don't add a
  per-section entrance on top of them.
