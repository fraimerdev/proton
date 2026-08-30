# Module Spec — `branding`

Status: shipped. Parent spec: `docs/PLAN.md`; all invariants in PLAN.md §3 apply. Where this file
and PLAN.md conflict, PLAN.md wins.

How Proton is named and drawn **inside one server**. Four fields — nickname, avatar, banner, bio —
set per guild, cleared per guild, and unaffected by what any other server chooses.

---

## 1. What Discord actually permits

One route carries the whole feature:

```
PATCH /guilds/{guild.id}/members/@me
  nick    ?string   CHANGE_NICKNAME
  avatar  ?string   (no permission listed)   Image Data URI
  banner  ?string   (no permission listed)   Image Data URI
  bio     ?string   (no permission listed)
```

`null` clears a field; an omitted field is left as Discord holds it. Bots were granted `avatar`,
`banner` and `bio` here by the **2025-09-10** developer change-log entry.

Two consequences shape the design:

- **Only `nick` is gated.** That is the entire reason branding issues two actions rather than one.
  A server that has stripped Change Nickname still gets its avatar, banner and bio.
- **`bio` is write-only.** It is on the request and on nothing else — not the Guild Member object,
  not `GUILD_MEMBER_UPDATE`. Proton can set it and can never read it back. The dashboard preview
  says so rather than claiming to be live.

## 2. Display name style, and what it really is

Discord's own Display Name Styles are Nitro SKUs. `display_name_styles` (`font_id`, `effect_id`,
`colors`) appears **three times in Discord's entire published documentation corpus**, all three
inside read-only example payloads, and in **zero** write routes. A bot cannot set one. Neither can
it set a nameplate, an avatar decoration, a profile effect, or `accent_color`.

The style controls therefore reach the same *look* through the two mechanisms that do exist.

**Typeface is Unicode substitution** (`typeface.ts`). Every offered face renders every letter: the
Mathematical Alphanumeric blocks have holes wherever a Letterlike Symbol already carried the glyph,
and each hole is filled explicitly. That is also why there is no small-caps face — its letters are
scattered across three unrelated blocks and **X does not exist at all**, so it would silently change
shape depending on how a name is spelled. Astral glyphs cost two UTF-16 units, so a styled nickname
gets 16 characters where a plain one gets 32; `wide` stays in the BMP and keeps all 32. The budget
is enforced before the push, with the real number in the refusal.

Its costs are real and are stated in the field's own help text: `GET /guilds/{id}/members/search`
prefix-matches raw nicknames, so searching for the plain name stops finding Proton, and screen
readers read the letters out one at a time. Mentions still resolve, because `<@id>` never carried
the name.

**Effect and colour are role colours** (`colour.ts`). A member's name colour comes from their
highest coloured role, and role colours *are* bot-settable: `primary_color`, `secondary_color`
(gradient) and `tertiary_color` (holographic), all under `MANAGE_ROLES`. Proton creates one role,
colours it, wears it, and remembers its id in `branding_roles`. Gradient and holographic need the
guild's `ENHANCED_ROLE_COLORS` feature, which no dispatch Proton consumes reports — so the request
is made and Discord's refusal is what names the missing feature.

Holographic takes Discord's three fixed values (11127295 / 16759788 / 16761760) and nothing else, so
the two colour pickers are ignored for that effect rather than sent and rejected.

The default gradient is **Proton's own**, cyan to violet. Its middle blue stop is dropped rather than
approximated: a role gradient takes two colours.

`add_bot_role` and `remove_bot_role` exist because `add_role` targets a member, and when that member
is the bot the `target_is_self` precheck refuses it — the same trap the identity kinds avoid.

## 3. Images are uploaded and stored

An admin uploads a file. It is validated (PNG/JPEG/GIF by magic number, 1 MB for an avatar, 2 MB for
a banner) and stored base64 in `branding_assets`, keyed `(guild_id, kind)`.

base64 in `text`, not `bytea`: Discord's Image Data wants `data:<mime>;base64,<payload>` and this is
already that payload, so the push is a concatenation rather than a driver-specific binary round
trip — and there is no `bytea` anywhere else in this schema to copy a working one from.

The type is **sniffed from the bytes**, never taken from the upload's declared type or its
extension: Image Data carries the type inside the URI, so a PNG named `.jpg` reaches Discord as a
400 that names no field.

The upload writes the bytes **and** the config hash, and the hash goes through the ordinary
`ModuleConfigService.update` path on purpose — that is what writes the audit row and publishes
`config_changed`, which is what makes the worker push the new picture. An upload that only wrote
bytes would be silent and unattributed. The hash is also what the preview's `?v=` is keyed on, so a
replaced image repaints instead of showing the overwritten one from cache.

Storing admin-supplied media is why the privacy policy gained a "Branding images" bullet and why its
"attachments, images and voice are never stored" sentence was rewritten rather than left to read as
a flat denial.

## 4. Reconciliation, and why there is no applied-state table

Two moments push:

- **`proton.config_changed`** — the admin saved, or uploaded an image. Both legs are pushed. The
  idempotency key is seeded with the save's `auditId`, which is unique per save, so a redelivered
  event dedupes and a new save never collides inside the executor's 24-hour window.
- **`guild.available`** — Proton reconnected, restarted, or was re-invited. `GUILD_CREATE` carries
  the bot's own member, which is the only place Proton learns what it already looks like.

Reconciling against **observed** state rather than a stored applied-hash is what makes a kick and
re-invite self-heal: the member comes back blank, the observed fingerprint changes, the key changes,
and the push happens. An applied-state book would still match and the bot would sit unbranded
forever while the dashboard claimed otherwise.

Images compare on **presence**, not identity — Discord returns a hash of its own re-encode and there
is no way back from it to the bytes Proton uploaded. Absence is the case that matters. A nickname
compares exactly. A bio cannot be compared at all, so it never triggers a reconcile by itself.

`guild.available`'s event id is the bare guild id and never changes, so it can never seed an
idempotency key.

## 5. Teardown runs in the listener, never in a job

`apps/worker/src/module-jobs.ts` **drops** a scheduled job whose module is switched off. A teardown
booked as a job would therefore never run, and Proton would wear a former customer's face forever.

`ModuleListenerRuntime` has a carve-out that delivers `proton.config_changed` to a module that has
just been switched off. That is the only moment branding can take its own face back off, and it is
where teardown lives. `restoreOnDisable` (default on) decides whether it does.

## 6. Failure has a voice

Branding is the first module whose work happens entirely in a background reconciler with no
interaction to answer. `apps/api/src/index.ts` passes `ALL_PERMISSIONS` to `registry.evaluate`
deliberately, so the dashboard's `missing_permission` gap card can never fire for it.

`/branding` is the answer: it re-applies on demand and reports exactly what Discord said, naming the
missing permission and where. It defers first — two store reads and two PATCHes do not finish
inside Discord's three-second window.

## 7. Impersonation

The nickname is checked against a small list of names that read as Discord itself or as server
staff, after NFKC folding and `\p{Cf}` stripping so a fullwidth or zero-width-joined spelling is
caught by the same list.

The check lives in the **reconciler and the panel, never in `configSchema`**. `ModuleConfigService`
re-parses stored config on *read* and throws `invalid_stored_config`, so a blocklist in the schema
would mean that tightening it later 400s the settings page of every server already holding a
now-failing value, and stops their module running, with no UI path to fix it.

## 8. Where it sits in the dashboard

Branding is a `ModuleManifest` underneath — it needs the config store, the audit trail, the listener
runtime and the disable-teardown carve-out, and rebuilding all four for one feature would be worse
code. But it configures Proton's own identity in this server rather than adding a feature to it, so
listing it beside Tickets and Tags reads wrong. `isServerLevel` in the dashboard's `module-meta.ts`
drives three things, and it took all three before the page stopped reading as a module:

- The server home renders it as a **`ServerSettingRow`**, not a `ModuleRow` — its own "This server"
  section, outside the category groups and outside `.module-list`, with a status word and a chevron
  instead of a toggle. The switch still exists, on its own page, where the sentence beside it can
  say what it governs.
- `ModuleHeader` shows a **"This server"** crumb rather than the Utility category, and
  `switchNote()` replaces "Turn this module on or off" with what the switch actually does.
- The page lede no longer claims everything below it is a module.

That set is presentation only; nothing in `packages/` knows about it.

## 9. The previews

Two, because no single view shows all four fields. `BrandingDiscordPreview` renders a message line —
avatar, display name, APP badge, timestamp — inside the existing `.dc-fence` / `.dc-surface` system,
which is the project's sanctioned way to show Discord truth without becoming a Discord clone: every
Discord colour is scoped under `.dc-surface` and may not be used outside it. `BrandingPreview` is the
profile card, and carries the banner and the bio, which a message line never shows.

The honesty caption belongs to the second one: Discord does not report a bot's bio at all, so the
card shows what Proton last sent rather than what Discord holds.

## 10. Not covered

- Premium gating. PLAN.md §8 puts entitlements in Phase 5, and `requiredEntitlement` is not read by
  the worker at all today (`runtime.ts` checks only `enabled`), so declaring it would grey a tile
  while the reconciler pushed anyway.
- Image moderation. An admin supplies a URL Discord already hosts; Proton does not classify it.
  Accepted risk, recorded here.
- Drift between reconnects. A nickname changed by hand is corrected on the next `guild.available`,
  not immediately.
