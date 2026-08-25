---
name: Proton Dashboard
description: A dark control surface for a Discord bot — four tonal steps, hairline rules, and the mark's gradient reserved for whatever is currently live.
colors:
  rail-black: "#0a0c11"
  console-ground: "#0f1116"
  card-slate: "#161920"
  raised-slate: "#1d212b"
  well-black: "#0b0d12"
  hairline: "#242833"
  lifted-hairline: "#333949"
  control-stroke: "#646e86"
  paper: "#e9ebf1"
  muted-paper: "#aab1c0"
  quiet-slate: "#868e9f"
  signal-cyan: "#0ab9fe"
  node-blue: "#3874f3"
  edge-violet: "#5944ec"
  cold-link-blue: "#6ba1ff"
  committed-blue: "#3369e8"
  committed-blue-hi: "#3a6fea"
  link-wash: "#141c30"
  link-line: "#2a3c68"
  running-green: "#4fcf95"
  running-wash: "#0e2019"
  running-line: "#1c4536"
  advisory-amber: "#f0b752"
  advisory-wash: "#241c0f"
  advisory-line: "#4b3919"
  blocked-coral: "#ff7a86"
  blocked-wash: "#241318"
  blocked-line: "#542630"
  discord-blurple: "#5865f2"
  discord-blurple-hi: "#6a75f4"
typography:
  display:
    fontFamily: "Onest, ui-sans-serif, 'Segoe UI', system-ui, sans-serif"
    fontSize: "clamp(30px, 4.2vw, 44px)"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Onest, ui-sans-serif, 'Segoe UI', system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Onest, ui-sans-serif, 'Segoe UI', system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.02em"
  lead:
    fontFamily: "Onest, ui-sans-serif, 'Segoe UI', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.62
    letterSpacing: "normal"
  subhead:
    fontFamily: "Onest, ui-sans-serif, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Onest, ui-sans-serif, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  caption:
    fontFamily: "Onest, ui-sans-serif, 'Segoe UI', system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Onest, ui-sans-serif, 'Segoe UI', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.05em"
    fontFeature: "set in uppercase"
  button:
    fontFamily: "Onest, ui-sans-serif, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "normal"
  mono:
    fontFamily: "'Spline Sans Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
    fontFeature: "tabular-nums; no ligatures"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  full: "999px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "20px"
  s6: "24px"
  s7: "32px"
  s8: "40px"
  s9: "56px"
  s10: "72px"
components:
  button-primary:
    backgroundColor: "{colors.committed-blue}"
    textColor: "#ffffff"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.committed-blue-hi}"
  button-quiet:
    backgroundColor: "{colors.card-slate}"
    textColor: "{colors.paper}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-quiet-hover:
    backgroundColor: "{colors.raised-slate}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-paper}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.raised-slate}"
    textColor: "{colors.paper}"
  button-danger:
    backgroundColor: "{colors.blocked-coral}"
    textColor: "#2a0d12"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-discord:
    backgroundColor: "{colors.discord-blurple}"
    textColor: "#ffffff"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0 24px"
    height: "44px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.muted-paper}"
    rounded: "{rounded.sm}"
    size: "34px"
  input-text:
    backgroundColor: "{colors.well-black}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
    width: "420px"
  input-text-focus:
    backgroundColor: "{colors.console-ground}"
    textColor: "{colors.paper}"
  input-textarea:
    backgroundColor: "{colors.well-black}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "88px"
  switch-track:
    backgroundColor: "{colors.well-black}"
    rounded: "{rounded.full}"
    width: "42px"
    height: "24px"
  switch-track-blocked:
    backgroundColor: "{colors.blocked-coral}"
  switch-track-degraded:
    backgroundColor: "{colors.advisory-amber}"
  checkbox-checked:
    backgroundColor: "{colors.committed-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.xs}"
    size: "18px"
  card:
    backgroundColor: "{colors.card-slate}"
    textColor: "{colors.paper}"
    rounded: "{rounded.lg}"
  module-row:
    backgroundColor: "{colors.card-slate}"
    textColor: "{colors.muted-paper}"
    typography: "{typography.body}"
    padding: "12px 16px"
  module-row-hover:
    backgroundColor: "{colors.raised-slate}"
    textColor: "{colors.paper}"
  area-card:
    backgroundColor: "{colors.card-slate}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "16px 20px"
  area-card-hover:
    backgroundColor: "{colors.raised-slate}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted-paper}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "34px"
  nav-item-active:
    backgroundColor: "{colors.raised-slate}"
    textColor: "{colors.paper}"
  nav-group-label:
    textColor: "{colors.quiet-slate}"
    typography: "{typography.label}"
    padding: "0 8px 8px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.muted-paper}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  chip-ok:
    backgroundColor: "{colors.running-wash}"
    textColor: "{colors.running-green}"
  chip-warn:
    backgroundColor: "{colors.advisory-wash}"
    textColor: "{colors.advisory-amber}"
  chip-system:
    backgroundColor: "{colors.link-wash}"
    textColor: "{colors.cold-link-blue}"
  pill:
    backgroundColor: "{colors.raised-slate}"
    textColor: "{colors.muted-paper}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "3px 8px"
  tile:
    backgroundColor: "{colors.raised-slate}"
    textColor: "{colors.quiet-slate}"
    rounded: "{rounded.lg}"
    size: "40px"
  tile-sm:
    backgroundColor: "{colors.raised-slate}"
    textColor: "{colors.quiet-slate}"
    rounded: "{rounded.sm}"
    size: "26px"
  table-header-cell:
    backgroundColor: "{colors.card-slate}"
    textColor: "{colors.quiet-slate}"
    typography: "{typography.label}"
    padding: "12px 16px"
  table-cell:
    backgroundColor: "transparent"
    textColor: "{colors.muted-paper}"
    typography: "{typography.body}"
    padding: "12px 16px"
  master-switch:
    backgroundColor: "{colors.card-slate}"
    textColor: "{colors.paper}"
    typography: "{typography.lead}"
    rounded: "{rounded.lg}"
    padding: "16px 20px"
  master-switch-on:
    borderColor: "{colors.link-line}"
  master-switch-blocked:
    borderColor: "{colors.blocked-line}"
  master-switch-degraded:
    borderColor: "{colors.advisory-line}"
  rule-row:
    backgroundColor: "{colors.card-slate}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    padding: "16px 20px"
  rule-param-label:
    textColor: "{colors.quiet-slate}"
    typography: "{typography.caption}"
  form-section-title:
    backgroundColor: "{colors.card-slate}"
    textColor: "{colors.paper}"
    typography: "{typography.subhead}"
    padding: "16px 20px"
  field:
    backgroundColor: "{colors.card-slate}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    padding: "16px 20px"
  filters-bar:
    backgroundColor: "{colors.card-slate}"
    rounded: "{rounded.lg}"
    padding: "16px"
  gap-card:
    backgroundColor: "{colors.blocked-wash}"
    textColor: "{colors.muted-paper}"
    rounded: "{rounded.lg}"
    padding: "16px 20px"
  gap-card-warn:
    backgroundColor: "{colors.advisory-wash}"
  alert-banner:
    backgroundColor: "{colors.blocked-wash}"
    textColor: "{colors.blocked-coral}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  save-bar:
    backgroundColor: "{colors.raised-slate}"
    textColor: "{colors.paper}"
    rounded: "{rounded.lg}"
    padding: "12px 12px 12px 20px"
  palette:
    backgroundColor: "{colors.card-slate}"
    textColor: "{colors.paper}"
    rounded: "{rounded.lg}"
    width: "560px"
  kbd:
    backgroundColor: "{colors.card-slate}"
    textColor: "{colors.quiet-slate}"
    rounded: "{rounded.xs}"
    padding: "3px 4px"
---

# Design System: Proton Dashboard

## Overview

**Creative North Star: "The Night Switchboard"**

Proton's dashboard is a dark room full of switches, and the only thing that glows is what is
currently live. The ground is a cool near-black that never resolves to pure black; surfaces step up
from it in four small increments and are cut apart by 1px hairlines rather than shadows or gaps. On
that ground, one gradient — cyan through blue to violet, sampled from the product's own mark — is
allowed to appear, and only ever as a 2–6px sliver marking a thing that is on: the server you are
looking at, the section you are in, the tab you are reading, the module that is running. Everything
else in the interface is greyscale plus a small, disciplined set of semantic colours.

The arrangement is deliberately the one a Discord admin already knows: a narrow icon rail of
servers, a sidebar of categories, a single centred column of work. The craft, not the layout, is
where the product differentiates. That means an obsessive typographic hierarchy — ten roles, all
Onest, with a second face reserved strictly for machine strings — and state carried by precise
small type sitting beside colour, never by colour alone. A module that cannot run says "A permission
is missing" in amber-or-coral text and recolours its own switch track; it is never greyed out and
never silently dead.

The density is high and unapologetic: 34px nav rows, 36px controls, 12px vertical padding on list
rows, no decorative whitespace. What the room does not contain is as deliberate as what it does. No
tinted glass, no glows behind cards, no gradient buttons, no card that lifts on hover, no colour
that appears once for effect.

**Key Characteristics:**

- Cool near-black ground (`#0f1116`) with four tonal surface steps and 1px hairline separation
- The mark's cyan→blue→violet gradient reserved exclusively for slivers that mark live state
- Onest for all UI text; Spline Sans Mono for identifiers, timestamps, commands, counts and keycaps
- Semantic colour ships as ink + near-black wash + hairline, never as a saturated block
- 880px reading column, widened to a hard-capped table width only when a table is on the page
- Flat at rest: two shadows exist and both mean "this floats above the page"
- Uppercase micro-caps label a *set*; sentence-case semibold is a *heading*

## Colors

A greyscale console — five near-blacks and three greys carrying almost every pixel — punctured by
one blue for interaction, three semantic hues for state, and a gradient that is never a fill.

### Primary

- **Cold Link Blue** (`#6ba1ff`): The interaction colour. Links, focus rings, the checked-checkbox
  fill's inner mark, the selected command-palette icon, the accented icon tiles, the top-rank chip.
  Bright enough to hold AA against the ground; never used as a large fill.
- **Committed Blue** (`#3369e8`): The solid, deeper form of the same hue, used only where the blue
  becomes a filled surface — the primary button, the checked checkbox, the skip link, the embed
  preview's default accent bar. **Committed Blue Hover** (`#3a6fea`) is its only variant.
- **Link Wash** (`#141c30`) / **Link Line** (`#2a3c68`): The blue's surface pair — a near-black tint
  and a hairline. Backs the icon tile of a switched-on module row, the system chip, the field-flash
  animation, and the border of an enabled master switch.

### Secondary

- **Signal Cyan** (`#0ab9fe`), **Node Blue** (`#3874f3`), **Edge Violet** (`#5944ec`): The three
  stops of the brand mark's gradient, sampled from `public/proton-mark.png`. They are never used as
  flat colours on their own — they exist so the gradient can be composed
  (`linear-gradient(135deg, cyan, blue 52%, violet)`).

### Tertiary

- **Running Green** (`#4fcf95`) with wash `#0e2019` and line `#1c4536`: Reserved for confirmed,
  verified good — a live module's status word, the "Saved" line after a successful write, the OK
  tile. Proton cannot verify overall health, so green is deliberately rare.
- **Advisory Amber** (`#f0b752`) with wash `#241c0f` and line `#4b3919`: Something is degraded or
  plan-gated. The module row's warning text, the degraded switch track, the rehearsal chip, the
  advisory variant of the gap card.
- **Blocked Coral** (`#ff7a86`) with wash `#241318` and line `#542630`: Something cannot run, or the
  user is about to destroy something. Field validation errors, the alert banner, the gap card, the
  blocked switch track, the destructive button.
- **Discord Blurple** (`#5865f2`) with hover `#6a75f4`: Discord's own colour, used on exactly one
  element in the entire product.

### Neutral

- **Rail Black** (`#0a0c11`): The guild rail and the sidebar. The room's back wall — the only
  surface darker than the page that is not sunken.
- **Well Black** (`#0b0d12`): Sunken surfaces — every input, textarea, select, switch track,
  XP-bar groove, ladder rung and log-category body. Anything a user can type into or toggle reads
  as cut *into* the card, not laid on top of it.
- **Console Ground** (`#0f1116`): The page. Everything is measured from here.
- **Card Slate** (`#161920`): The default surface — cards, module lists, form sections, filter
  bars, table cards, menus, the palette, the confirm dialog.
- **Raised Slate** (`#1d212b`): One step up. Row hover, active nav item, icon tiles, pills, code
  spans, the save bar, the selected palette item.
- **Hairline** (`#242833`): Every structural boundary — card borders, row separators, table rules,
  section rules.
- **Lifted Hairline** (`#333949`): The border of things that float (menus, dialogs, save bar,
  palette), the keycap border, the chip border, the scrollbar thumb.
- **Control Stroke** (`#646e86`): Input, select, textarea, switch and checkbox borders only. It is
  lighter than every other line so a control reads as touchable before it is focused. It is also the
  only line in the system held to WCAG 1.4.11: the boundary of an input is what says it is one, so it
  clears 3:1 against every ground it lands on — 3.02:1 on Raised Slate, 3.30:1 on Card Slate. The
  original `#4b5468` read 2.12:1 there and failed.
- **Paper** (`#e9ebf1`): Primary text, headings, the name of a module that is on.
- **Muted Paper** (`#aab1c0`): Secondary text — body copy in cards, table cells, the name of a
  module that is off, nav items at rest.
- **Quiet Slate** (`#868e9f`): Tertiary text — descriptions, timestamps, counts, micro-caps labels,
  placeholders, resting icons.

### Named Rules

**The Gradient Is A Sliver Rule.** The brand gradient is only ever a thin marker of something that
is live. It never fills a button, a card, a surface, a tile or text. It appears in exactly six
places: the guild-rail indicator (4px wide), the active nav-item indicator (3px), the active tab
underline (2px), the on-switch track, the XP bar fill (6px tall), and the signed-out door's halo
(12% opacity behind a 90px blur). Adding a seventh has to pass the same test — does it mark
something that is currently running? *(The world was declared with three jobs; the build settled at
six. Six is the system. The three additions all still mark live state or are the mark itself.)*

**The Switch Carries The State Rule.** A module that is switched on but cannot run recolours its own
switch track — coral for blocked, amber for plan-gated — and is *never* disabled. The switch is the
only way to turn the module back off, so it stays live; the state goes into the track and into a
named line of text beside it.

**The Wash-And-Line Rule.** Every semantic colour ships as a triple: the ink, a near-black wash and
a hairline. Semantic surfaces sit a few percent above the ground, never as saturated blocks. There
is no such thing as a coral card or an amber banner — only a coral hairline around a coral-tinted
near-black.

**The Blurple Is A Doorknob Rule.** Discord blurple appears on exactly one element: the "Continue
with Discord" button on the signed-out door. Anywhere else it makes Proton read as a Discord clone
instead of a tool that manages one.

## Typography

**Display / Body Font:** Onest (with `ui-sans-serif`, Segoe UI, system-ui fallbacks), weights 400–700
**Label / Mono Font:** Spline Sans Mono (with `ui-monospace`, SF Mono, Menlo, Consolas), weights 400–500

**Character:** Onest is a neutral geometric grotesque with a large x-height that stays legible at
11px and tightens well under negative tracking at display sizes — the whole ramp is one family, and
hierarchy comes from size, weight and tracking rather than from a second voice. Spline Sans Mono is
the second voice, and it never speaks prose: it exists so a snowflake ID, a UTC stamp or a
`/timeout` line is instantly recognisable as a machine string.

### Hierarchy

- **Display** (600, `clamp(30px, 4.2vw, 44px)`, 1.1, tracking `-0.035em`): The signed-out door's
  single headline. Nowhere else in the product.
- **Headline** (600, 28px, 1.2, tracking `-0.025em`): The one `h1` per page, and the `h1` inside
  long-form prose pages.
- **Title** (600, 18px, tracking `-0.02em`): The confirm dialog's title, the door wordmark, and `h2`
  in prose.
- **Lead** (400, 15px, 1.62): The page lede paragraph (capped at 68ch), the sidebar server name, the
  master-switch line, the door subtitle, the palette input.
- **Subhead** (600, 14px, tracking `-0.02em`): Section headings inside the page — the module-category
  headings (in Muted Paper) and the form-section headings (in Paper). Sentence case, always.
- **Body** (400, 14px, 1.55): Default text, table cells, nav items, controls, buttons (at 600).
- **Caption** (400, 12.5px, 1.5): Tooltip copy (capped at 280px), timestamps, counts, secondary
  lines, status text, error text, breadcrumbs.
- **Label** (600, 11px, tracking `0.05–0.06em`, uppercase): Micro-caps. Nav group labels, table
  column headers, filter field labels, the sidebar role line.
- **Mono** (400/500, 12.5px, `tabular-nums`, ligatures off): IDs, timestamps, case numbers, ranks,
  slash-command strings on module rows, section counts, nav badges, keycaps (10px), inline code.

### Named Rules

**The Micro-Caps Label A Set Rule.** Uppercase 11px tracked type labels a *set* of things — a nav
group, a table column, a filter input, a role line. Sentence-case semibold is a *heading* for a
region of the page. These do not swap. A form field label is a heading for one control and is
therefore sentence case at 14px/500; a table column header labels a column of values and is
therefore micro-caps.

**The Mono Is For Machine Strings Rule.** Spline Sans Mono is for things a machine produced or a
machine will parse: snowflake IDs, UTC timestamps, case numbers, ranks, counts, slash-command lines,
keycaps and inline code. Never prose, never a heading, never a button label. Every mono number
carries `font-variant-numeric: tabular-nums` so digits stack in a column.

**The One Family Rule.** All UI text is Onest. Hierarchy is size, weight and tracking — never a
second display face, never letter-spaced uppercase outside the Label role, never italics.

## Layout

**The shell** is a three-part flex row occupying exactly `100vh` with its own scroll containment:
a 72px guild rail, a 248px sidebar, and a flexed main column that scrolls independently. Rail and
sidebar share Rail Black and are separated from each other and from the page by 1px hairlines. The
main column carries the page ground.

**The page column** is capped at 880px and centred, with 40px side padding and 72px of bottom slack
(`.page`). This is the reading and configuration width — a module's settings form, the module list,
the guild picker. Tables need more, and the widening is done on the page rather than on the table:
`.page:has(.panel-wide)` widens to `min(1260px, 100vw - 72px - 248px)` so the `h1`, the tabs, the
filter bar and the table rows all keep the same left edge instead of the table hanging off a
narrower heading. Prose pages cap at 820px and measure at 68ch.

**Spacing rhythm** is a 4px scale used in 10 steps (4, 8, 12, 16, 20, 24, 32, 40, 56, 72). In
practice: 8px inside a control, 12–16px inside a row, 16–20px inside a field or card, 24px between
a section head and its body, 40px between sections, 56–72px of page padding. Vertical gaps are
carried by padding and hairlines, not by margins between siblings.

**Density targets** are fixed and shared: 34px for nav items, menu items, icon buttons and module
icon tiles; 36px for every text control and standard button; 44px for guild avatars and the door's
call to action; 40px for the standard icon tile.

**Responsive** behaviour has three steps and turns the desktop shell into a drawer shell:

- **≤1080px** — page padding tightens from 40/40/72 to 32/24/56. Nothing else moves.
- **≤900px** — a fixed 52px topbar appears (hamburger, server name, search, account), the rail
  becomes a fixed 60px overlay column under it, and the sidebar becomes an off-canvas drawer
  (`transform: translateX(...)`, 0.22s, `visibility: hidden` when closed) behind a scrim. The
  table-widening rule is dropped — the page is already full width. The door drops its art panel and
  goes single-column.
- **≤620px** — the rail joins the drawer, the page falls to 24/16/40 padding, the `h1` drops to
  22px, the module row reflows into a two-line grid (`icon name switch` / `. warn warn`), and the
  filter bar becomes a two-column grid with selects spanning both.

**Text measure** is capped everywhere it can run long: 68ch for ledes and prose, 280px for tooltip
copy, 62ch for gap-card text, 56ch for door facts, 52ch for empty-state and door copy.

## Elevation & Depth

Depth is **tonal, not cast**. Five ground values do the work — Well Black (`#0b0d12`) and Rail Black
(`#0a0c11`) *below* the page, Console Ground (`#0f1116`) as the page, Card Slate (`#161920`) as the
default surface, Raised Slate (`#1d212b`) as the one step above it — and every boundary between them
is a 1px hairline. A card at rest has a border and no shadow. Hover raises a row by one tonal step,
never by a shadow and never by a transform.

Shadows exist only to say "this is not part of the page" — a thing that is floating over the
document and can be dismissed. There are two, and no third should be added.

### Shadow Vocabulary

- **Floating** (`box-shadow: 0 4px 12px rgba(0, 0, 0, 0.36)`): The field tooltip, and any other
  medium-lift surface that sits over the page without taking it over.
- **Detached** (`box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5)`): The user menu, the command palette,
  the confirm dialog, the sticky save bar, and the mobile sidebar drawer. Everything that is
  dismissible and overlays the page.

### Named Rules

**The Flat-At-Rest Rule.** Surfaces are flat. A shadow is not decoration and not hierarchy — it
means the element is floating over the document and can be dismissed. If it cannot be dismissed, it
does not get a shadow.

**The Cut-In Rule.** Anything the user types into or toggles is sunken (Well Black) with a Control
Stroke border, cut into the card rather than laid on it. Anything that displays is raised (Raised
Slate) with no border. This is how an input and a pill are told apart at a glance even though they
are the same height.

## Shapes

The form language is **rounded rectangles at four fixed radii**, with a fifth for anything that
should read as a track or a token.

- **12px (`--r-lg`)** — the container radius. Cards, module lists, form sections, filter bars, table
  cards, menus, the palette, the confirm dialog, the save bar, the 40px icon tile, the guild avatar.
- **8px (`--r-md`)** — the control radius. Buttons, inputs, selects, textareas, ladder rungs, log
  categories, alert banners, the search trigger, the 34px module icon tile.
- **6px (`--r-sm`)** — the row radius. Nav items, menu items, icon buttons, palette items, the 26px
  small tile.
- **4px (`--r-xs`)** — the token radius. Pills, keycaps, rank chips, inline code, the focus-ring
  radius, and the flat edge of every indicator sliver (which is rounded only on its outer end:
  `border-radius: 0 4px 4px 0`).
- **999px (`--r-full`)** — tracks and capsules. Switch tracks and thumbs, checkbox-free chips, the XP
  bar and its fill, the scrollbar thumb, the tab underline's top corners.

Borders are always exactly 1px. The one gesture that breaks the radius scale is the guild avatar,
which sits at 15px and morphs to 12px on hover or when it is the current server — a rounded-square
that squares up slightly as it activates.

### Named Rules

**The Hairline Rule.** Every boundary in the product is a 1px `#242833` rule. There are no 2px
borders, no dividers with margins around them, no double rules, and no shadow used as a separator.
Rows are separated with `+ .row { border-top }` inside a clipped container so the container's 12px
radius survives.

**The Clipped Container Rule.** A list of rows is one bordered, 12px-radius container with
`overflow: hidden` and hairlines between rows — not a stack of individually-bordered cards with gaps.
A gap between rows is a different, louder statement than this system makes.

There is exactly one exception, and it is the Module Overview. Its cards are destinations rather
than rows of a list, and the louder statement is the one the page is for. Nothing else in the
product may claim it: if a new surface wants gaps, it wants to be a clipped container.

## Components

### Buttons

Solid, compact, and quiet unless they commit something.

- **Shape:** Gently rounded (8px), fixed 36px height, 16px horizontal padding, `white-space: nowrap`,
  1px transparent border so ghost and quiet variants share the same box.
- **Primary:** Committed Blue fill, white label at 14px/600. The single committing action on a
  surface — "Save changes", "Continue".
- **Quiet:** Card Slate fill with a Lifted Hairline border and Paper label. The default for
  secondary actions, pagination, and "Open".
- **Ghost:** Transparent, Muted Paper label; fills to Raised Slate on hover. Reset, dismiss, remove
  an array item.
- **Danger:** Blocked Coral fill with a very dark coral text (`#2a0d12`) — the fill is bright enough
  that the label must be dark, not white. Only inside a confirm dialog.
- **Discord:** Blurple fill, white label, 44px tall at 24px padding. Sign-in only.
- **Hover / Focus:** 0.13s colour transition on background, border and text; no lift, no scale, no
  shadow. Focus is the global 2px Cold Link Blue ring at 2px offset.
- **Disabled:** `opacity: 0.45` and `not-allowed`. Buttons may be disabled; switches may not.
- **Icon button:** 34px square, 6px radius, transparent, 19px glyph, fills to Raised Slate on hover.

### Chips and Pills

Two different objects that are easy to confuse.

- **Chip** (`999px`, 1px Lifted Hairline border, transparent fill, 11px/500): a *state* readout —
  "active", "reverted 2026-08-20 19:40", "Rehearsal". Semantic variants swap the border and fill to
  the matching wash/line pair: `chip-ok`, `chip-warn`, `chip-system` (blue, for actions Proton took
  itself rather than a human moderator).
- **Pill** (`4px`, Raised Slate fill, no border, 12.5px/500): a *resolved reference* — a Discord
  channel or role picked in a field, rendered under the select as `#mod-log` or `@Moderators`. The
  role variant takes its colour from the role's real Discord colour through three custom properties
  (`--role-color`, `--role-wash`, `--role-text`) and carries it as an inset 1px ring.

### Cards / Containers

- **Corner Style:** 12px.
- **Background:** Card Slate; sunken children use Well Black.
- **Border:** 1px Hairline. Always present — the border, not a shadow, is what makes it a card.
- **Shadow Strategy:** None at rest (see Elevation).
- **Internal Padding:** 16px 20px for form sections and fields; 12px 16px for list rows and table
  cells; 16px for filter bars; 24px for the confirm dialog.

### Module Header

The first thing on every module page, and the answer to the two questions an admin arrives with:
what is this, and is it on.

- **Crumb:** a 12.5px Quiet Slate line above the `h1`. On the module's own page it is the category
  the sidebar filed it under; inside an area it is the module's name, linked back to the module.
  It never takes the link blue — a coloured line above an `h1` outranks the heading.
- **Lede:** one sentence saying what the module does, in the page lede role. An area shows its own
  blurb instead. A data view shows neither — the view carries its own lede about its rows.
- **Master switch:** a full-width card, Card Slate on a Hairline, wrapping the switch in its own
  `<label>` so the whole bar toggles. "Enabled" in Lead over a Caption note in Quiet Slate —
  "Turn this module on or off for this server." The border goes Link Line when the module is on,
  Blocked Coral's line when it cannot run, Advisory Amber's when it is plan-gated — and the switch
  track takes the matching colour.
- **It is a settings row, not a status report.** The bar names what the control does; no glyph, and
  no sentence restating the position of the switch beside it. The one thing it adds is the failure:
  a module that is on but cannot run prints the short reason at the far end of the line in the
  matching ink, because the recoloured track may never be the only carrier of that state.
- **Position:** above the tabs, because it governs the whole module rather than one face of it. A
  gap card follows it directly with the sentence and the Discord path.

### Module Overview

The landing page of a module that is too big for one form. It is a menu of that module's areas, and
the only place in the product where a list is drawn as separated cards rather than a clipped
container — see the exception recorded under The Clipped Container Rule.

- **Card:** Card Slate on a Hairline at 12px radius, 16px/20px padding, stacked 12px apart. Hover
  takes it one tonal step to Raised Slate and the border to Lifted Hairline. No shadow, no lift.
- **Contents:** the 40px icon tile left; Title (15px/600 Paper) over the area's blurb in Caption
  (Quiet Slate, capped at 62ch); the area's count in mono at the right, then a `caret-right` in
  Quiet Slate that goes Muted Paper on hover. An area with nothing to count shows no count at all;
  one that counts nothing yet says "None yet" in the sans face, because that is a sentence.
- **Target:** the link is stretched under the whole card with an inset `::after`, so the count and
  the chevron are inside the hit rather than dead space beside it. The focus ring goes on the card
  for the same reason.
- **Below 620px** the card reflows to a two-row grid — icon, text and chevron on the first row, the
  count under the text on the second.

### Section Card

A settings section is a card that carries its own name. There is no heading floating above it.

- **Header:** a full-width `<button>` inside an `h2` at 12px/20px padding — the title left in Title
  (15px/600 Paper), a caret right in Quiet Slate. Hover fills the header to Raised Slate, the one
  tonal step. The hairline that separates header from body belongs to the body, so a collapsed card
  is a single bordered bar rather than a bar with a rule under it.
- **Collapse:** the caret is `caret-up` when open and `caret-down` when closed — the state is drawn,
  not animated, because a rotation would be the only transform transition in the system. The button
  carries `aria-expanded` and `aria-controls`; the body carries `hidden`.
- **Memory:** which sections a user has closed is kept in `localStorage` under
  `proton.collapsed-sections`, keyed `moduleId:sectionId`. It is applied after mount, never seeded
  into the first render — the server cannot read it, and a disagreement is a hydration mismatch.
- **Untitled:** a group no section claims renders the card with a body and no header. There is
  nothing to name and nothing to collapse.

### Picker

The one control for anything drawn from the guild itself. Discord's own admins already know it, and
it is the only way a role's colour and a channel's type reach the page.

- **Trigger:** a 36px sunken control matching a text input — Well Black, Control Stroke, 8px radius —
  holding the chosen value's mark, its name, and a caret. Unset, the name sits in Quiet Slate. Open,
  the border goes Cold Link Blue and the ground lifts to Console Ground, exactly as a focused input.
- **Mark:** a role is a 10px dot in its own colour, defaulting to Quiet Slate for Discord's
  "no colour" (which is `0`, not black). A channel is its type's Phosphor glyph — hash, speaker,
  megaphone, microphone-stage, chats-circle — in Quiet Slate. A channel's label is its bare name: the
  glyph already says `#`, and printing both says it twice.
- **Popover:** Raised Slate on a Lifted Hairline at 8px radius with the Detached shadow, matched to
  the trigger's width (240–340px). A search box on a hairline at the top, then a 244px scrolling
  list. It is the search box that holds focus, not the options.
- **Options:** 32px rows at 6px radius, Muted Paper, lifting to Card Slate and Paper under the
  cursor. A chosen option carries a Cold Link Blue tick on the right. Channels group under their
  category in micro-caps; uncategorised channels sit above the first group, as they do in Discord.
- **Keyboard:** the search box is a `combobox` with `aria-activedescendant`; up and down move,
  Enter picks, Escape closes and returns focus to the trigger. Picking with the mouse uses
  `mousedown`, not click, so focus never leaves the search box and a second pick costs one click.
- **Single vs many:** a single picker closes on pick. A multi picker stays open and ticks, because
  choosing five exempt roles should cost one trip.

### Token List

How a set is shown once it has been chosen. Chips, not rows.

- **Chip:** 28px, fully rounded, Raised Slate on a Lifted Hairline, 12.5px Paper, with the option's
  mark on the left and a 20px round remove button on the right that fills to Lifted Hairline on
  hover. Labels clamp at 22ch.
- **Adding:** a 28px dashed-outline `+` at the end of the flow opens the same picker popover. At the
  schema's ceiling it disables and a Quiet Slate line says "Limit of N reached".
- **Typed sets** (blocked words, domains) swap the `+` for an inline entry: type, Enter to commit,
  Backspace on an empty box to take the last one back. Those chips carry no mark — a word has
  nothing to colour.
- **A value the guild no longer has** keeps its chip under its raw id, dashed and in mono. A role
  deleted in Discord is still in the saved config, and a chip nobody can see is one nobody can
  remove.

### Tooltip

The only thing in the system that appears on hover.

- **Surface:** Raised Slate at 8px radius with a Lifted Hairline border and the Floating shadow,
  8px/12px padding, 12.5px/1.5 Muted Paper, capped at 280px and centred over its trigger.
- **Reveal:** opacity only, 0.12s. It is faded rather than removed, because `aria-describedby` on
  the control has to reach the text while the tooltip is closed; `display: none` would take it out
  of the accessibility tree. `pointer-events: none` keeps it from swallowing the click beneath it.
- **Never load-bearing.** A tooltip holds a consequence worth knowing, never the sentence a user
  needs to complete the task. Anything required goes in the label, the placeholder, or an error.

### Inputs / Fields

- **Style:** Sunken (Well Black) with a 1px Control Stroke border, 8px radius, 36px tall, 12px
  horizontal padding, 14px/400 Onest. Text inputs cap at 420px, number inputs at 160px — a duration
  field is not as wide as the card.
- **Hover:** Border lifts to Quiet Slate.
- **Focus:** Border becomes Cold Link Blue *and* the background lifts from Well Black to Console
  Ground — the field brightens as it takes input. `:focus-visible` adds the 2px ring at 1px offset.
- **Error:** `aria-invalid="true"` turns the border coral; the message renders below in coral at
  12.5px. A field is never left red without a sentence explaining it.
- **Select:** Native, appearance stripped, with a caret drawn from two 5px linear-gradient triangles
  in Quiet Slate — no icon dependency. Native selects are for closed vocabularies the schema owns:
  an enum, a sort order, a direction. Anything drawn from the guild — a role, a channel — is a
  Picker, because a native `<option>` cannot carry a colour or a glyph.
- **Field row:** `.field` is a two-column grid at 16px/20px padding inside a form section, separated
  from its neighbour by a hairline: the label on the left, the control on the right, on one
  alignment line down the whole form. The label is sentence case 14px/500 in Paper and is a real
  `<label for>` naming its control, so clicking it focuses or toggles. A boolean field puts the
  switch on the right of the same row with 20px of gap. A row carries no prose. Rows whose control
  grows stack instead — see The Stacked-When-It-Grows Rule.
- **Field info:** a field that genuinely needs explaining gets an 18px Quiet Slate info glyph beside
  its label, and nothing else. It is a real `<button>` sitting outside the `<label>` — inside one it
  would toggle the switch it is explaining — and it reveals a tooltip on hover and on focus. Most
  fields have no info button; see The One-Line Row Rule.

### Rule Row

A field family rendered as one setting with parts. `floodSeverity`, `floodCount` and `floodWindow`
are not three settings; they are one check and the two numbers it reads.

- **Head:** the family's name on the left and its own control on the right, on the same two-column
  grid as `.field`, so a rule and a plain row hold one alignment line down the form.
- **Parameters:** a wrapping flow under the head at 16px, each a Caption Quiet Slate label over its
  control. Number inputs sit at 110px, durations at 130px, enums at a 156px floor — a threshold is
  not as wide as the card. A parameter whose label repeats the rule's name is labelled for screen
  readers only; two controls telling apart by type is not two names.
- **Off is empty.** When the head is a severity set to `off`, the parameters are not rendered. The
  values are kept and come back the moment it is switched on; eleven checks' worth of thresholds
  for checks nobody enabled is the page's whole weight problem.
- **A growing parameter still stacks.** Token lists and colour pairs take the full width under the
  head rather than joining the inline flow. See The Stacked-When-It-Grows Rule.
- **It has to earn itself.** Grouping applies only where a section yields two or more rules. One
  family among unrelated rows reads better as plain rows, and a form that groups in one section and
  not the next has traded the alignment line for nothing.

### Matrix

Where a section's fields are two parallel objects over one set of keys, it is a table, and it is
built as one. Server Logs declares thirteen category switches and thirteen category channels; as
plain rows that is twenty-six rows printing thirteen labels twice, with each category's two halves
a screenful apart.

- **Head:** micro-caps column names in Quiet Slate on a hairline — the name of the row set first
  ("Category"), then one per column ("Logged", "Channel"). This is the Micro-Caps Label A Set Rule
  doing exactly its job: labelling a column of values, not a control.
- **Rows:** a `<th scope="row">` in Paper at 14px/500 carrying the name once, then one cell per
  column at 12px/20px padding with a hairline between rows. The name column takes all the slack so
  every control column shrinks to its own control.
- **Named per cell.** Every control in a column inherits the same label from the schema, so each
  gets an accessible name composed from its row and its column — "Server — Channel". Thirteen pairs
  of controls all called "Server" is a table nobody can navigate by ear.
- **It has to earn itself.** The table is built only when every column is populated on every row.
  A renamed root or a leaf one column is missing drops the whole table back to plain rows rather
  than rendering a grid with holes in it.
- **On a phone** the columns stop being columns: each row becomes a block, the head is dropped, and
  every cell takes its column's name as its own Caption label — the same shape a rule row's
  parameters take at the same width.

### Switch

The system's signature control and the one place the brand gradient touches a full element.

- **Track:** 42×24, fully rounded, Well Black with a Control Stroke border when off; the border goes
  transparent and the track fills with the brand gradient when on.
- **Thumb:** 16px circle, Quiet Slate when off, white when on, sliding 18px over 0.2s.
- **State variants:** `[data-state="blocked"]` recolours the checked track to Blocked Coral;
  `[data-state="degraded"]` to Advisory Amber. Both remain interactive.
- **Never disabled.** See The Switch Carries The State Rule.

### Navigation

- **Guild rail** (72px, Rail Black): the mark at the top, a 28px hairline separator, then 44px guild
  avatars at 15px radius. The active-server indicator is a 4px gradient sliver drawn as a `::before`
  on the avatar itself — 26px tall when current, 18px on hover — so it cannot displace the avatars
  below it. A circular account button pins to the bottom.
- **Sidebar** (248px, Rail Black): server name (15px/600) over a micro-caps role line; a 34px
  ⌘K search trigger on a sunken well; then nav groups separated by 20px. Nav items are 34px, 6px
  radius, Muted Paper, with a 17px leading icon in Quiet Slate and an optional mono badge (`5/8`)
  on the right.
- **Nav states:** hover fills to Card Slate; `aria-current="page"` fills to Raised Slate, sets the
  label to Paper/500, and draws a 3px×18px gradient sliver on the left edge. A module row also
  carries `[data-state]`: Signal Blue on its icon when the module is running, and a 6px dot after
  the label in Coral or Amber when it is on but cannot.
- **The sidebar is one level deep.** A module row never expands. Opening a module that has areas
  lands on its Module Overview, and the areas are chosen there — an open module rendering a second
  list of links inside the sidebar is a second navigation competing with the page it opened.
- **Tabs:** a hairline-underlined row with 20px gaps, Quiet Slate at rest, Paper when current, with a
  2px gradient underline sitting on the hairline (`bottom: -1px`). Tabs scroll horizontally without a
  scrollbar on small screens.
- **Mobile:** below 900px the sidebar becomes a scrimmed drawer behind a fixed 52px topbar; below
  620px the rail joins it.

### Tables

Authority through alignment, not through rules and fills.

- **Header:** sticky, Card Slate background so rows pass under it, 1px hairline beneath, micro-caps
  in Quiet Slate, left aligned, `nowrap`. Sortable headers are borderless buttons that inherit the
  header's type entirely and add a 12px caret.
- **Rows:** 1px hairline between (never after the last), Raised Slate on hover, 12px/16px cell
  padding, Muted Paper text, middle aligned.
- **Emphasis:** identifier columns (case number, rank) switch to mono + tabular numerals + Paper —
  the key of the row is the only thing in the row set in full-strength text.
- **Fixed columns:** the case ledger sets explicit per-column widths and a 940px minimum, because
  its virtualised body takes rows out of the table layout; the widths are what keeps the head and
  the body aligned.
- **Container:** wrapped in a `.table-card` (12px, hairline, clipped) with a 544px max-height scroll
  region, a filter bar above it and a pager below.

### Command Palette

Centred at 12vh, 560px wide, 60vh tall, Card Slate on a `rgba(6, 7, 10, 0.7)` backdrop, 12px radius,
Detached shadow, entering with a 0.16s 8px drop. A hairline-separated head holds an 18px search
glyph, a borderless 15px input and an `ESC` keycap. Results are 6px-radius rows; the selected row
fills to Raised Slate, tints its icon Cold Link Blue and shows an `ENTER` keycap. Each row carries
a label over a Quiet Slate breadcrumb path (`Automod / settings`).

### Save Bar

A sticky bar pinned 20px from the bottom of the scroll container, Raised Slate on a Lifted Hairline
border, 12px radius, Detached shadow, entering with a 0.24s 12px rise. It carries a 14px/500
sentence on the left and Reset / Save on the right. Its presence — not a dialog — is how unsaved
work announces itself; the page reserves 116px of scroll padding so a focused field is never hidden
behind it.

### Gap Card

The product's honesty device, and the thing the category does not do. A wash-and-line card (coral
for blocked, amber for degraded) holding a filled 17px status glyph, a 14px/600 name of the failure
("Not running"), a sentence naming the exact missing permission or intent capped at 62ch, and a
`.where` line — a small elbow-arrow glyph plus the literal Discord path
(`Server Settings → Roles → Proton`) in Quiet Slate. Never a bare red border; always a sentence and
a destination.

### Embed Preview

The one element in the system that carries a heavy coloured left border: a 4px stripe on a sunken
well at 4px radius, defaulting to Committed Blue and overridden per-embed from the embed's real
Discord colour. It is domain truth — a faithful reproduction of Discord's own embed accent bar,
inside a preview of a Discord embed — and it is fenced there. See the Don'ts.

### Server Picker

The signed-in landing page, and the one screen in the product where a server is the subject rather
than the context. Built to the owner's reference (2026-08-25), which overrides the resting-card and
brand-gradient rules below — for this page only.

- **Page:** centred, 780px, no breadcrumb-and-`h1` page head. A 28px/600 title over a 15px Muted
  Paper subtitle, both centred, then the grid.
- **Grid:** `repeat(auto-fill, minmax(210px, 1fr))` at 16px gaps — three across at full width, two
  on a tablet, two on a phone at 146px.
- **Card:** 12px radius on a Hairline, clipped. A 176px picture over a 54px bar. Hover lifts the
  border to Lifted Hairline; nothing else moves.
- **The wash.** The server's own icon, `object-fit: cover` at `scale(1.8)` under the whole card,
  `blur(36px) saturate(1.6)` at 42–50% — so each card takes its colour from the server it stands
  for. It is scaled well past the frame on purpose: a blur that runs off its source fades to
  transparent and rings the card in a dark halo. A server with no icon gets the mark's gradient at
  `blur(44px)`, 30%, which is the only place in the product the gradient is not a sliver.
- **Crest:** the same icon again, crisp, 72px, `--r-full`, over the wash. Initials on Raised Slate
  when there is none. Requested from Discord at `?size=256`, not the rail's 64.
- **Bar:** `rgba(11, 13, 18, 0.72)` laid over the wash rather than beside it, so the tint carries
  the whole card and the name still reads. Name left in Body/600, one line, ellipsised; a 30px
  button right — **Manage** in Committed Blue when Proton is in the server, **Invite** in the quiet
  fill when it is not.
- **Absent:** the wash goes to `saturate(0.15)` at 20% and the crest to 60%. The bar never dims —
  the button's own word is what carries the state, and it names the server in its `aria-label`.
- **Target:** the button's `::after` is stretched over the whole card, so the 176px picture is part
  of the same decision. The focus ring goes on the card.

### Empty State

Centred column: a 40px tile holding a 20px outline glyph, a 15px/600 sentence-form title
("Nobody has earned XP yet."), and a 12.5px Quiet Slate line capped at 52ch saying what would make
content appear. Titles are full sentences with terminal punctuation, not labels.

### Named Rules

**The One-Line Row Rule.** A settings row is one line tall: a label and its control, nothing else.
The label carries the meaning. A field earns an info button only when getting it wrong has a
consequence the row cannot show — personal data kept, a permission silently depended on, a cost per
event, a change that does or does not apply to what is already there. "It explains the setting" is
not a reason; that is what the label is for. A form where most rows carry an info button has a
labelling problem, not a tooltip problem.

**The Stacked-When-It-Grows Rule.** A row keeps its label left and its control right for as long as
the control is one fixed-height thing: a switch, a number, a duration, an enum, a single picker.
The moment the control's height depends on its contents — a token list, a colour pair — the label
moves above it and the control takes the full width. Mixing the two down one form is what makes a
generated form look generated; the alignment line has to survive, and a wrapping chip row breaks it.

**The Guild Vocabulary Rule.** Roles and channels are never a native `<select>` and never a raw id
in a text box. They are Pickers, everywhere they appear — the generated form, every hand-built
panel, and the bot's own Discord modals, which use Discord's native Role and Channel selects for the
same reason. A role without its colour and a channel without its glyph are two lines of text an
admin has to read instead of recognise.

**The Section Names Itself Rule.** A section's title lives inside its card, in a header that
collapses it. Nothing is titled by a heading hovering above a container — a name and the thing it
names are one object.

**The Switch Is On The Page Rule.** The control that turns a module on lives on that module's page,
as the master switch, with the sentence that says what its current position means. It is not in the
chrome. A second copy of it in the sidebar is one control disagreeing with another about which one
the admin is meant to use, and an unlabelled 33px switch in a nav row cannot carry "switched on but
a permission is missing" the way the bar can.

**The Family Is One Row Rule.** Fields that name one subject and differ only in aspect — a severity
and its thresholds, a limit and its window — render as a rule row, not as one row each. What
decides whether a family groups is the section it is in: two or more families group, one does not.

**The Label Is Printed Once Rule.** No name appears twice down one card. Two parallel objects over
one set of keys are a matrix, whose row header carries the name and whose column headers carry what
the two controls are. A form that prints "Server" on a switch and again on a picker eleven rows
later has made the reader hold the pairing in their head, which is the table's job.

## Do's and Don'ts

### Do:

- **Do** build a page as `.page-head` (optional 12.5px breadcrumb, then one `h1`) → optional lede →
  optional `.tabs` → sections, each a hairline-bordered card carrying its own header, 40px apart.
  A module page puts its master switch and any gap card between the lede and the tabs.
- **Do** reach for an existing container (`.card`, `.module-list`, `.form-section`, `.table-card`)
  before inventing a surface. All four are the same object: 1px `#242833`, 12px radius, `#161920`.
- **Do** put separators *inside* the container as `+ el { border-top: 1px solid #242833 }` and clip
  the container with `overflow: hidden`, so the 12px radius survives the first and last row. The one
  exception is `.form-section`, which stays unclipped so a field's tooltip can leave the card.
- **Do** express a failure as a gap card: name what is missing, then give the literal Discord path
  to fix it on a `.where` line.
- **Do** pair every state colour with a word. The coral track is always accompanied by "A permission
  is missing"; the amber track by "Not on this plan".
- **Do** set every number that appears in a column in mono with `tabular-nums`.
- **Do** sink anything the user edits (Well Black + Control Stroke) and raise anything that only
  displays (Raised Slate, no border).
- **Do** transition only colour, and only over 0.12–0.2s on `cubic-bezier(0.2, 0.9, 0.3, 1)`. The
  reduced-motion block collapses every duration to 0.01ms and must keep working.
- **Do** cap measure: 68ch for prose and ledes, 280px for tooltip copy, 62ch for failure copy.

### Don't:

- **Don't** put the brand gradient on a surface, a button, a card, an icon or text — outside the
  Server Picker's iconless wash, which the owner's reference calls for. It is a
  2–6px sliver marking live state, and it already has its six jobs.
- **Don't** disable a switch to say "cannot run" — recolour the track and name the reason in text.
- **Don't** build a role or channel chooser out of a native `<select>`, and don't grow a list by
  adding a whole control per entry. See The Guild Vocabulary Rule and the Token List.
- **Don't** write a field description because the field could have one. See The One-Line Row Rule:
  the label is the explanation, and a form of tooltips is a form nobody reads.
- **Don't** use uppercase micro-caps on a form field label, a page heading, or a button. Micro-caps
  label a set of things, nothing else.
- **Don't** set prose, headings or button labels in Spline Sans Mono.
- **Don't** give a resting card a shadow, a hover lift, a transform, or a glow. The Server Picker's
  wash is the single exception and is not a precedent: it is a server's own icon carrying that
  server's colour, not decoration, and it exists on one page. Hover is one tonal
  step.
- **Don't** add a thick or coloured left border to anything other than `.embed-preview`. That stripe
  is Discord's own embed accent bar reproduced inside a preview of a Discord embed; used anywhere
  else it is a decorative side-tab.
- **Don't** introduce a fifth surface step, a second hairline value, or a third shadow. The Server
  Picker's bar is a translucent Well Black over the wash, not a new step in the scale.
- **Don't** use Discord blurple anywhere but the sign-in button, and don't reproduce Discord's,
  MEE6's, Sapphire's or Wick's layouts or assets.
- **Don't** let colour be the only carrier of a state — every semantic colour in this system appears
  next to a word that says the same thing.
- **Don't** introduce a second sans face, letter-spaced uppercase outside the Label role, italics, or
  a weight above 600 for UI text.
