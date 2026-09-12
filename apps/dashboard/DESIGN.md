---
name: Proton
description: The Discord bot dashboard the category already knows, executed at full craft.
colors:
  bg: "#08080f"
  rail: "#0a0a14"
  surface: "#0b0b16"
  surface-hi: "#131326"
  sunken: "#07070e"
  line: "rgba(125, 140, 255, 0.1)"
  line-hi: "rgba(125, 140, 255, 0.18)"
  control-line: "#5b6286"
  control-fill: "rgb(255 255 255 / 3%)"
  fill: "rgb(255 255 255 / 4%)"
  hover: "rgb(255 255 255 / 8%)"
  active: "rgb(255 255 255 / 12%)"
  text-hi: "#f4f5fb"
  text: "#e9eaf4"
  text-2: "#a3a5c0"
  text-3: "#7d7f9a"
  accent: "#8fb4ff"
  accent-hi: "#c9daff"
  accent-solid: "#5865f2"
  accent-solid-hi: "#4954e6"
  accent-edge: "#757ff7"
  accent-wash: "rgba(124, 140, 255, 0.14)"
  indigo: "#7c8cff"
  indigo-text: "#9aa8ff"
  indigo-hi: "#c9d2ff"
  sky: "#3fb0ff"
  sky-text: "#6fc0ff"
  sky-wash: "rgba(63, 176, 255, 0.14)"
  ok: "#6ed18c"
  ok-wash: "rgba(59, 165, 93, 0.14)"
  warn: "#e2a03f"
  warn-wash: "rgba(226, 160, 63, 0.14)"
  warn-line: "rgba(226, 160, 63, 0.26)"
  danger: "#ec5f56"
  danger-wash: "rgba(224, 82, 74, 0.14)"
  danger-line: "rgba(224, 82, 74, 0.34)"
  dc-blurple: "#5865f2"
  dc-grey-button: "#4e5058"
  dc-green: "#248046"
  dc-red: "#da373c"
typography:
  display:
    fontFamily: "Public Sans, ui-sans-serif, Segoe UI, system-ui, -apple-system, Helvetica Neue, sans-serif"
    fontSize: "clamp(40px, 4.6vw, 60px)"
    fontWeight: 700
    lineHeight: 1.04
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "clamp(30px, 3.1vw, 42px)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.03em"
  title:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "-0.02em"
  section:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "normal"
  body:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  field-label:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  meta:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.06em"
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "tabular-nums; ligatures off"
rounded:
  xs: "6px"
  md: "10px"
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
    backgroundColor: "{colors.accent-solid}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.xs}"
    padding: "0 {spacing.s4}"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.accent-solid-hi}"
    textColor: "#ffffff"
  button-primary-disabled:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.text-3}"
  button-quiet:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.text}"
    rounded: "{rounded.xs}"
    padding: "0 {spacing.s4}"
    height: "36px"
  button-quiet-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.text-hi}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.xs}"
    padding: "0 {spacing.s4}"
    height: "36px"
  button-danger:
    backgroundColor: "{colors.danger-wash}"
    textColor: "#ff8f87"
    rounded: "{rounded.xs}"
    padding: "0 {spacing.s4}"
    height: "36px"
  button-xl:
    backgroundColor: "{colors.accent-solid}"
    textColor: "#ffffff"
    typography: "{typography.section}"
    rounded: "{rounded.xs}"
    padding: "0 {spacing.s6}"
    height: "50px"
  input:
    backgroundColor: "{colors.control-fill}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.xs}"
    padding: "0 {spacing.s3}"
    height: "36px"
  input-focus:
    backgroundColor: "rgba(124, 140, 255, 0.06)"
    textColor: "{colors.text}"
  input-disabled:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.text-3}"
  surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.s3} {spacing.s4}"
  popover:
    backgroundColor: "{colors.surface-hi}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.s2} {spacing.s3}"
  chip:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.text-3}"
    typography: "{typography.field-label}"
    rounded: "{rounded.xs}"
    padding: "3px 8px"
  chip-ok:
    backgroundColor: "{colors.ok-wash}"
    textColor: "{colors.ok}"
  chip-warn:
    backgroundColor: "{colors.warn-wash}"
    textColor: "{colors.warn}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.field-label}"
    rounded: "{rounded.xs}"
    padding: "5px {spacing.s2}"
  nav-item-current:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.indigo-hi}"
  master-switch:
    backgroundColor: "{colors.control-fill}"
    textColor: "{colors.text-hi}"
    typography: "{typography.field-label}"
    rounded: "{rounded.xs}"
    padding: "0 {spacing.s3} 0 {spacing.s4}"
    height: "40px"
  master-switch-on:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.text-hi}"
---

# Design System: Proton

## Overview

**Creative North Star: "The Night Console"**

Proton is the shape its audience already knows — a marketing page that explains and demonstrates,
then a sidebar dashboard of per-module settings — drawn as if it were an instrument rather than a
brochure. The ground is a near-black blue-black; every boundary in the product is a single hairline
of low-alpha indigo; every surface is one 10px box that never contains another. Nothing glows,
nothing floats, nothing is gradient. What carries the eye is contrast in text weight and the rhythm
of hairlines, not decoration.

The density is a working density. A module page is a two-column grid of settings sections whose rows
are label-left, control-right, separated by 1px lines — closer to a mixing desk or an aircraft
settings page than to a marketing dashboard. Every screen is expected to hold real content: real
case numbers, real role names, real Discord output. The type ramp is deliberately short, six styles
for the whole product, so the product's own words do the differentiating rather than the styling of
them.

The system carries one fidelity obligation that overrides its own taste: wherever Proton shows what
Discord will draw, it draws Discord's colours, radii and accent bars exactly, inside a visible
fence. Everything inside a `.dc-*` fence is a reproduction and is exempt from the rules below.
Everything outside one obeys them without exception. Confirmed rejections, held inside the
conventional shape: no gradient hero or gradient text, no decorative glow, no glassmorphism, no
oversized radii, no floating or nested cards, no icon-plus-heading-plus-text feature grid, no fake
charts, no single settings template reused for every module.

**Key Characteristics:**

- Near-black blue-black ground; one 10px bordered surface, never nested
- Hairline rules (1px, 10% indigo) as the primary structural device
- One sans across site and product; monospace only for machine strings
- Six app type styles and no seventh; two display sizes on the public pages
- Status colour always ships as a wash plus an ink, and always with a word beside it
- Zero gradients, zero decorative blur, zero shadows on resting surfaces
- One authored motion moment on the whole site

## Colors

A single blue-black family stretched from ground to surface, lit by one indigo accent and four
functional states; the accent is pale for text and saturated only where an action is Discord's.

### Primary

- **Sheet Indigo** (`accent`): the app's own accent voice. Links, focus rings, the inline accent on
  text. Pale on purpose so it can appear in body copy at 4.5:1 without shouting.
- **Blurple** (`accent-solid`): Discord's own brand blue, and the only saturated fill in the
  product. It is the solid behind primary buttons, checked switches and checked checkboxes, and the
  edge (`accent-edge`) that keeps that fill legible against the ground.
- **Signal Indigo** (`indigo` / `indigo-text` / `indigo-hi`): the accent as ink — a focused control's
  border, an active nav row's label, the tick beside the current server. `indigo-hi` is the brightest
  step and belongs to the current item, not to hover.
- **Accent Wash** (`accent-wash`, 14% indigo): the flat tint that marks a row, chip or nav item as
  current. It is a state, never a decoration.

### Secondary

- **Signal Sky** (`sky` / `sky-text` / `sky-wash`): reserved for things Proton did on its own —
  system actions, automated cases — so an admin can tell a bot decision from a human one at a glance.

### Neutral

- **Void** (`bg`): the page ground behind everything, site and app alike.
- **Rail** (`rail`): a half-step darker than the ground, used only for the sidebar rail so the
  navigation reads as chrome rather than content.
- **Slate Surface** (`surface`): the one card colour. Every bordered box in the product is this.
- **Raised Slate** (`surface-hi`): reserved for things that genuinely float — menus, popovers,
  tooltips, the command palette — and for Discord-style pills.
- **Sunken** (`sunken`): the recessed fill. A disabled control, and any discrete object sitting
  inside a surface that would otherwise have needed a border of its own.
- **Hairline** (`line`, 10% indigo) and **Hairline Raised** (`line-hi`, 18%): every structural edge
  in the product. `line` divides; `line-hi` is the same edge when it must also read as a control.
- **Control Edge** (`control-line`): the stroke on inputs, selects and textareas. Measured at 3.3:1
  against the surface; a step darker drops it under WCAG 1.4.11 and is not available.
- **Ink Ramp** (`text-hi` / `text` / `text-2` / `text-3`): headings, body, secondary copy, and
  help/meta respectively. Four steps, and placeholder text stops at `text-3`.
- **Interaction Ramp** (`fill` / `hover` / `active`, white at 4 / 8 / 12%): one hover step and one
  active step, shared by every row, menu item and quiet button in the product.

### Tertiary

- **Signal Green** (`ok`), **Signal Amber** (`warn`), **Signal Red** (`danger`): healthy, degraded,
  blocked. Each ships with a 14% wash and, for warn and danger, a line colour for the bordered
  banner form.
- **Discord Palette** (`dc-blurple`, `dc-grey-button`, `dc-green`, `dc-red`): Discord's own button
  colours, used only inside a message preview or its swatch picker.

### Named Rules

**The Word Beside the Colour Rule.** No state is ever carried by colour alone. A recoloured switch
track, a warn chip, a red banner — each has the word for its state set beside it in text. If you
cannot name the state in words next to the colour, the colour is decoration and does not ship.

**The Blurple Belongs to Discord Rule.** The saturated blurple is Discord's, spent on primary calls
to action and Discord-bound buttons only. The app's own accent voice is the pale indigo. Never tint a
surface, a heading or a divider with the solid blurple.

**The Wash-and-Ink Rule.** A status colour appears only as a matched pair: a 14% wash behind, its
bright ink in front. Never a saturated status fill, never status ink on the bare ground.

## Typography

**Display Font:** Public Sans (with `ui-sans-serif`, Segoe UI, system-ui fallbacks)
**Body Font:** Public Sans — the same family
**Label/Mono Font:** IBM Plex Mono (with `ui-monospace`, SF Mono, Menlo, Consolas), ligatures off,
tabular figures on

**Character:** One neutral, slightly condensed grotesque doing every job, tightened hard at display
sizes (-0.03em) and left alone at reading sizes. The single family is the point: the product's
seriousness comes from hierarchy and restraint, not from a second voice. The mono is a working face,
not a costume — it appears only where a string is machine-generated and must be compared
character-by-character.

### Hierarchy

- **Display** (700, `clamp(40px, 4.6vw, 60px)`, 1.04, -0.03em): the landing-page hero headline, and
  nothing else. Balanced wrapping; a line break is a block, never a `<br>`.
- **Headline** (600, `clamp(30px, 3.1vw, 42px)`, 1.08, -0.03em): one public section heading. A step
  down in *both* size and weight from Display, deliberately — at equal weight the page had seven
  joint-loudest elements.
- **Title** (700, 26px, 1.18, -0.02em): the page title in the app. Every dashboard page opens here.
- **Section** (600, 15px, 1.25, `text-hi`): a settings-section heading, a band title, a figure head,
  an empty-state title. The workhorse heading of the product.
- **Body** (400, 14px, 1.55): body copy and every control's own text. Prose measure capped at
  64–75ch; a lede at 72ch, a description at 64ch, a status sentence at 65ch.
- **Field Label** (500, 13px): the label beside a control, a table row header, a nav item, a chip.
- **Meta** (400, 12px, 1.6, `text-3`): help text under a field, a figure caption, save status, group
  hints.
- **Label** (600, 11px, 0.06em, uppercase, `text-3`): the only uppercase in the app. Sidebar group
  headers, table column heads, definition-list terms, fence labels. Eight selectors share it.
- **Mono** (400, 13px, 1.4, tabular): case ids, snowflakes, timestamps, channel names, durations.

### Named Rules

**The Six Styles Rule.** The app has six type styles and no seventh: page title, section heading,
field label, body, meta, and the uppercase label. A new screen picks one of the six. If none of them
fits, the screen is wrong, not the ramp.

**The Two Display Sizes Rule.** The public pages add exactly two sizes above the app ramp — the hero
and one section heading. Everything below a section heading on a marketing page is set in the app's
own scale, so the site and the product read as one artifact.

**The Machine-String Rule.** Monospace is for strings a machine produced and a human must compare:
ids, timestamps, case codes, channel names, durations. Never for prose, never for emphasis, never to
make something look technical.

## Layout

The product is a fixed 236px sidebar rail plus a 60px top bar over a scrolling workspace; the
content column is capped at 1240px, or 1560px for the wide tables. The public site runs a 1200px
measure with 24px gutters and 80px between sections.

Spacing is a ten-step 4px scale (4, 8, 12, 16, 20, 24, 32, 40, 56, 72). Inside a surface the rhythm
is tight: 8/16 padding on a row, 12/16 on a head. Between surfaces it opens to 16; between bands of
settings, 40; between public sections, 80. A heading always gets more space above it than below it.

A module page is a `auto-fit` grid of settings sections at a 440px column minimum, so column count
follows the space left after the sidebar rather than a viewport number. Inside a section, fields
respond to the *section's* width through container queries, not the viewport's: label-left above
780px, a narrowed control track at 700px, string and array fields stacking at 560px, and everything
stacked at 420px. Viewport media queries are reserved for chrome — the drawer at 1000px, the site
nav at 940px, phone layout at 620px.

### Named Rules

**The One-Line Row Rule.** A settings row is one line: a label, optionally one short description,
and its control. A second sentence restating what the control does is deleted, not styled. Anything
that needs more explanation gets a tooltip or a band hint, not another line in the row.

**The Container-Not-Viewport Rule.** A component that lives inside a settings column asks its
container how wide it is. A component that is chrome asks the viewport. Never mix them.

## Elevation & Depth

The system is flat, and depth is tonal. There are exactly three ground tones (`sunken`, `bg`/`rail`,
`surface`) and one hairline, and a resting surface has no shadow at all. Shadows exist only for
things that genuinely leave the page — menus, popovers, tooltips, the switcher, the command palette,
the mobile drawer — and a floating thing takes a shadow *instead of* a border, never in addition to
one.

### Shadow Vocabulary

- **Pop** (`box-shadow: 0 2px 6px rgba(0,0,0,0.55), 0 18px 48px -14px rgba(0,0,0,0.9)`): what an
  overlay carries instead of a border. Two offsets, so the panel keeps a visible edge on a near-black
  ground where a single soft shadow disappears.
- **Drawer** (`box-shadow: 0 24px 60px -18px rgba(0,0,0,0.85)`): the mobile navigation drawer only.
- **Knob** (`box-shadow: 0 2px 6px rgba(0,0,0,0.45)`): the switch knob, so it reads as sitting on
  its track. Removed when the switch is disabled.

Inset rings (`box-shadow: inset 0 0 0 1px …`) are not elevation — they are a border drawn without
taking layout space, used for a selected card, a role pill's own colour, and a disabled icon button.

### Named Rules

**The Declare-Elevation-Once Rule.** Border or shadow, never both. A resting surface is a 1px
hairline and a flat fill. A floating surface is a shadow and no border. A 1px border under a wide
soft shadow is the ghost card and does not ship.

**The No Nested Box Rule.** Nothing bordered nests inside a bordered surface. An inner group is a
heading and a hairline; a discrete object inside a surface is a `sunken` fill with no border of its
own.

## Shapes

Three radii and no fourth. **6px** (`r-xs`) is the control radius: buttons, inputs, selects, chips,
pills, tokens, nav rows, tiles — anything you click or that holds a short string. **10px** (`r-md`)
is the surface radius: cards, settings sections, tables, popovers, menus, the command palette, the
figures on the public site. **999px** (`r-full`) is round: avatars, server crests, switch tracks and
knobs, status dots, the scrollbar thumb. A nested corner inside a 10px surface is computed as
`calc(var(--r-md) - 1px)` so the inner fill meets the border cleanly rather than being eyeballed.

Borders are 1px, always. The product's silhouette is a stack of hairlined rectangles: a row is
separated from the next row by a hairline, not by a gap and not by its own box. Icons come from one
drawn set (Phosphor, inlined as SVG paths, regular and fill weights) at three sizes only — 14, 16,
20px — sized on the icon or its box, never as a raw pixel value.

### Named Rules

**The Fenced Fidelity Rule.** Discord's own drawing — its 4px embed accent bar, its button colours,
its 4px radii, its blockquote stripe — is reproduced exactly, and only inside a `.dc-*` preview
fence or a builder card previewing an embed. That accent bar is the single licensed exception to the
1px border rule, because it is Discord's mark, not Proton's. It never appears on a Proton card, list
item, callout or alert.

## Components

### Buttons

- **Shape:** control radius (6px), 36px tall, 16px horizontal padding, 600 weight at body size.
- **Primary:** blurple fill with a lighter blurple edge and white text; darkens on hover; presses
  down 1px on active.
- **Quiet:** a `fill` wash with a raised hairline, standard ink. Hover lifts the fill to `hover` and
  the border to the accent line.
- **Ghost:** no fill, no border, secondary ink; hover is the shared `hover` wash.
- **Danger:** danger wash with a danger line and a bright coral label — never a solid red fill.
- **Discord:** the blurple face, reserved for buttons that take the admin into Discord.
- **XL:** the hero and closing call only — 50px tall, 24px padding, 15px label.
- **Disabled:** never opacity. A raised hairline, a `sunken` fill and `text-3` ink, so every pair
  stays a contrast number you can check. Save sits disabled for the whole time an admin is reading.
- **Busy:** the label goes transparent and a `currentcolor` ring spins over it, so the button keeps
  its width and never resizes mid-action.

### Inputs / Fields

- **Style:** 36px tall, 6px radius, 3% white fill, `control-line` stroke, body type. Textareas open
  to 88px minimum and resize vertically only. Selects draw a custom caret and drop it when disabled.
- **Hover:** the stroke warms to `text-3`.
- **Focus:** the stroke goes indigo and the fill lifts to a 6% accent tint; keyboard focus adds a 2px
  `accent` outline at 1px offset.
- **Error:** `aria-invalid` turns the stroke danger; the message is written beside the field.
- **Disabled:** the shared disabled vocabulary (raised hairline, sunken fill, `text-3` ink) and the
  placeholder goes fully transparent.
- **Field row:** a 44px-minimum grid, label and help on the left, control right, one hairline between
  consecutive fields. Help text sits under the label at meta size; a longer explanation is a tooltip
  on an 18px info button whose pointer target is padded out to 24px and which stays hoverable so a
  sentence can be read without it vanishing.

### Switches and Checkboxes

- **Switch:** a 40×23 pill, 17px knob, blurple when checked, 180ms travel. When a module is switched
  on but cannot run, the track recolours to warn or danger rather than going disabled — the switch
  stays live so the admin can always turn it back off, and the reason is written beside it.
- **Checkbox:** 18px, 6px radius, blurple when checked with a drawn white tick.

### Cards / Containers

- **Corner Style:** surface radius (10px).
- **Background:** `surface`, flat.
- **Border:** one 1px hairline. **Shadow Strategy:** none — see Elevation.
- **Internal Padding:** 12/16 on heads and rows, 16/20 inside bodies.
- A settings section is this box plus a heading and hairlined rows; it is a container-query root, and
  its border warms to `line-hi` on `focus-within`.

### Chips and Pills

- **Chip:** `fill` wash, transparent border, `text-3` ink, 6px radius, 3×8 padding, 13px/500. State
  variants swap to the matching wash-and-ink pair (ok, warn, system-sky).
- **Pill:** `surface-hi` fill for Discord-shaped tokens; a role pill takes the role's own colour as an
  inset 1px ring and tinted ink, so the dashboard shows the colour Discord will show.

### Navigation

- **Sidebar:** a 236px rail on the darker `rail` ground, headed by a server switcher and grouped into
  collapsible sections. A group header is the uppercase Label style and is itself the control that
  opens the group; its tally is mono. A nav item is a 13px/400 row at 6px radius; hover takes the
  shared `hover` wash; the current item takes `accent-wash` with `indigo-hi` ink.
- **Top bar:** 60px, hairline underneath, `bg` ground, sticky. Its right side is the save slot, which
  says nothing at rest — the divider and gutter arrive with the content rather than standing over an
  empty corner.
- **Site header:** sticky, hairlined, with the nav links in a single bordered 10px capsule; the
  section in view owns the highlight while the scroll-spy is running, not the hash in the address bar.
- **Mobile:** below 1000px the rail becomes a drawer carrying the one large shadow in the system.

### Figure (signature)

The public site does not use feature cards. It uses **figures**: a 10px hairlined surface with a
head (title left, note right), hairline-separated definition rows or a table, and a caption under a
top border — a real case record, a real permission table, a real Discord scene. The three showcase
sections are composed differently from each other on purpose (`show-caption` sets one artefact
against a caption column; `show-pair` sets the settings beside the message they produce; `show-stack`
runs a capped Discord scene over a two-column list), so the page never degrades into three identical
cards.

### Discord Preview (signature)

Inside a labelled fence, Proton redraws Discord: its embed and container accent bars at 4px, its
button colours, its 4px radii, its blockquote stripe, its muted ink. The fence itself is the frame,
so a scene carries no border of its own. Nothing in this component obeys the Proton rules above, and
nothing outside it may borrow from it.

### Motion

One authored moment on the whole site: `scene-arrive` settles a figure as it enters the viewport —
scroll-driven, behind `@supports (animation-timeline: view())` and `prefers-reduced-motion:
no-preference`, with the resting rule as the finished state so nothing is staked on it running.
Everything else is state feedback: 150–180ms on the shared ease (`cubic-bezier(0.2, 0.9, 0.3, 1)`)
for background, border and colour. A global reduced-motion block collapses every transition and
animation to 0.01ms.

## Do's and Don'ts

### Do:

- **Do** put every bordered box on one 10px radius, one 1px hairline and the `surface` fill — the
  six class names that share that rule are one component.
- **Do** obey the Declare-Elevation-Once Rule: a hairline at rest, `shadow-pop` and no border when
  something floats.
- **Do** write the state in words next to its colour, every time (the Word Beside the Colour Rule).
- **Do** take disabled styling from the shared vocabulary — raised hairline, `sunken` fill, `text-3`
  ink — and never from `opacity`, which makes contrast unmeasurable.
- **Do** keep the accent pale in text and save the solid blurple for primary calls and Discord-bound
  actions.
- **Do** pick one of the six app type styles. A new size is a design error, not a new token.
- **Do** ask the container, not the viewport, how wide a settings component is.
- **Do** set ids, timestamps, case codes and channel names in the mono face with tabular figures.
- **Do** keep prose to a 64–75ch measure and give a heading more space above it than below.
- **Do** draw icons from the generated Phosphor set at 14, 16 or 20px.

### Don't:

- **Don't** nest a bordered box inside a bordered box. Use a heading and a hairline, or a `sunken`
  fill.
- **Don't** ship a gradient of any kind — background or text. The build has zero, and that is the
  standing answer to the generic-AI look.
- **Don't** add `backdrop-filter` anywhere except the command palette's backdrop, which is the one
  existing use and exists only while the palette is open.
- **Don't** put a coloured left border above 1px on a Proton card, list item, callout or alert. The
  4px bar belongs to Discord and lives only inside a preview fence.
- **Don't** place the uppercase Label style above a heading as a kicker. It is a group header, a
  column head and a definition term — never an eyebrow.
- **Don't** introduce a fourth radius, a fourth icon size, a third font family, or a second hover
  alpha.
- **Don't** grey out a control to mean "this cannot run". Recolour its track to warn or danger, keep
  it operable, and name the missing permission or intent beside it.
- **Don't** restate a control's purpose in a second line under its label (the One-Line Row Rule).
- **Don't** build a page out of same-size icon-plus-heading-plus-text cards, or reuse one settings
  template across modules. Compose each showcase and each module page for what it actually shows.
- **Don't** scatter entrance animations. The site has one authored motion moment; everything else is
  state feedback under 200ms.
