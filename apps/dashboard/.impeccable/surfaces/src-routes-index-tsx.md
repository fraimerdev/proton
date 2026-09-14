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
  Proton's real output format from the module code, and every one is captioned illustrative. No invented
  counts, testimonials, logos or prices.
- Lead belief (owner): one bot for everything.

## Chosen direction

The familiar bot-site structure played at full polish (owner's pick; peers: other bot sites and modern
product sites), carrying the **Spectral edge** treatment (seed key 50f22bd7): the page stays graphite and
achromatic; the logo spectrum appears only as 2px edges on what Proton touches — the top edge of each
Discord window and the dashboard shot, the hero's Proton messages, the primary CTA's underline and the
closing band's top edge. No gradient text, no glow.

Order: centred hero (headline, lede, Add to Discord + Open the dashboard, commands link) over a Discord
client window (#general: a welcome, a member reply, the default level-up line) with a floating #mod-log
(Honeypot's incident embed, then Anti-Raid's raid-mode alert) → three alternating feature rows: Security
(Anti-Nuke and Phishing alerts), Moderation (/warn reply, appeal review card), Member tools (giveaway card)
→ every module, grouped, with its catalogue description → one-dashboard section with a real-component
shot showing the "Proton cannot run" banner → storage statements (split layout) → closing band.

## Memorable moment

The hero chat comes alive: messages arrive in sequence and a spectrum edge draws across each Proton
message group as it lands. The sequence is paused from first paint and starts once 60% of the #general message column is on screen.

## Unresolved

- The public header is a floating surface-1 island (Modules, Commands, FAQ; Add to Discord secondary; the
  blue primary is Log in with Discord or Open the dashboard). The landing CTA stays white with the spectrum
  edge; the nav carries no spectrum.
- Desktop feature rows keep their module chip lists even though the full list follows.
