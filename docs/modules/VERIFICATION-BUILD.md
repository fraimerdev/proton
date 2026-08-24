# Verification — build record

Companion to `docs/modules/VERIFICATION.md` (the spec) and `docs/PLAN.md`. Records what was actually
built in the second pass over `verification`, what deviates from the spec and why, and what is proven
versus written-but-unproven.

**Answers to the spec's open questions**, given by the owner before implementation: conditional form
fields are shared infrastructure in `packages/core`, not a bespoke panel · website verification is a
Discord OAuth ownership proof only, with no browser captcha and no account-age heuristics · the panel
is published from the dashboard, not by a slash command — since revised to post itself on save, see §4.

---

## 1. What landed

### A — shared form infrastructure (`packages/core/src/config/descriptor.ts`)

Two metadata keys, because a mode selector that cannot hide the settings belonging to other modes is
unusable, and because an admin was previously reading `website` and `off` as literal option text.

| Key | Effect |
|---|---|
| `showWhen: { path, equals }` | The descriptor renders only when `values[path]` is one of `equals`. |
| `optionLabels: Record<string,string>` | Enum only. What an admin reads instead of the schema string. |

Four build-time refusals, all `UnsupportedSchemaError` in the file's existing sentence shape:
`optionLabels` on a non-enum; an `optionLabels` key that is not one of that enum's options;
a `showWhen.path` naming no field; an empty `showWhen.equals`. A fifth was added during review —
a `showWhen.equals` value that is not one of the target enum's options — because without it a typo
hides a field in *every* mode and, since hidden fields keep posting their stored value, makes it
permanently uneditable with nothing named anywhere.

A hidden field renders `hidden` on its own `.field` root rather than inside a wrapper, so the form's
`.field + .field` hairline still matches. A section whose descriptors are all hidden hides too.

**The bug that only a browser caught.** Marking the element `hidden` was not enough: `[hidden]` lives
in the UA stylesheet and *any* author `display` outranks it, so `.field { display: grid }` rendered
every hidden row in full while carrying the attribute. Every string-matching test passed. The fix is
one global `[hidden] { display: none !important }` in `styles.css`; the regression test asserts the
rule exists, and says why a markup assertion cannot.

### B — the captcha renderer (`packages/cards/src/captcha.ts`)

No new dependency: `@napi-rs/canvas` was already in `packages/cards`. `newCaptchaAnswer(length)` draws
unbiased over `ABCDEFGHJKMNPQRTUVWXY346789` — upper-case latin and digits minus `0 O 1 I L 5 S 2 Z`,
the pairs a human cannot separate once a glyph is warped.

`renderCaptcha` composes: gradient backdrop and speckle, noise strokes *under* the glyphs, per-glyph
rotation, skew, vertical jitter, size and typeface (Manrope or Inter), a variable-advance walk, a
whole-line baseline tilt, one thin stroke over the top, then a sine warp over everything.

Two things drove the tuning, in this order:

1. **The first render was unreadable by a human.** With a kick or ban on the other side of the image,
   that is a defect, not a security feature. Glyphs were enlarged, strokes thinned, warp reduced.
2. **That made it template-matchable.** The recovered resistance came from distortions that cost a
   template everything and a reader nothing — variable advance (the original evenly-spaced glyphs sat
   on the same centres whatever the text was), per-glyph scale and typeface, and the baseline tilt.

The distortion tests were rewritten during review from five hand-picked seeds — which the constants
had been tuned against — to a sampled distribution over 60 seeds with median, tail-share and
worst-case bounds. Measured over 400 seeds, strengthening moved `agreement` p95 from 0.544 to 0.516
and the share of seeds leaking ≥0.15 to a template match from 3.25% to 1.25%.

### C — the module (`packages/modules/verification/`)

Config goes to `schemaVersion: 2`. Every v1 key kept its name and meaning, so a stored v1 config
parses unchanged and no `liftStoredConfig` was needed.

| File | What it is |
|---|---|
| `panel.ts` | Pure builders: the panel message, the captcha message, the captcha modal, the website link message. Each returns `{ok}` or a `humanReason`, so a `custom_id` overflow surfaces as a sentence. |
| `challenge.ts` | Minting a challenge, its TTL, and the case- and whitespace-insensitive comparison. |
| `failure.ts` | `planFailure` — the config enum to an `ActionRequest` payload, plus the copy the member is told and the phrase the log uses. |
| `interactions.ts` | The component and modal handlers: the Verify press in all three modes, the Enter-code modal, Different image, and the answer. |
| `service.ts` | `reconcilePanel` on every config save, and granting the role after a website pass. |
| `store.ts` | `RedisCaptchaStore` (TTL, and `KEEPTTL XX` on update) and `RedisPanelStore` alongside the existing quarantine store. |

`actionKinds` grew from three to ten. That is not bookkeeping: `moduleExecutor` throws
`UndeclaredActionError` on anything absent, and `invitePermissions()` is derived from it, so a failure
action left off the list is a member told they were kicked who was not.

### D — the seams

- **`packages/core`**: `verification.web_passed` in `EVENT_TYPES`
  *and* `SERVICE_EMITTED_EVENT_TYPES`; `verify-link.ts` (HMAC-SHA256 over base64url claims, constant-
  time compare, 15-minute expiry).
- **`apps/api`**: one route behind the shared secret publishing that event. It refuses with a named
  503 when the bus is absent — the api boots without Redis on purpose, and a 200 here would tell the
  website a member was verified when the worker was never told.
- **`apps/dashboard`**: a public `/verify/$token` route; the `completeWebVerification` server
  function; `VERIFY_LINK_SECRET`.
- **`apps/worker`**: the two new stores, `applicationId`, `DASHBOARD_URL` and the optional secret.

---

## 2. Deviations from the spec

| Spec said | Built | Why |
|---|---|---|
| "Different image" edits the message in place | It replies with a fresh ephemeral message | `edit_message` carries no `files`, so an attachment can be sent but never replaced. A new reply is the only way to show a new image. |
| Panel identity encoded in `custom_id` | Kept, and the panel message id is remembered in Redis besides | The id is what lets a later save edit rather than post a twin. The `custom_id` still carries no message id, so a press re-reads live config. |
| `showWhen` inherited by a nested object | Registering either key on a nested object throws | Propagation has to decide what happens when a child carries its own `showWhen`. The spec specifies per-field only, and CLAUDE.md forbids speculative abstractions. A loud refusal beats a silent drop. |

---

## 3. What is proven, and what is not

**Proven on this host.** 4155 unit tests pass, `bunx turbo run typecheck --force` is 36/36, and
`bun run lint` is clean. The verification module alone carries 157 tests across 10 files, all plain
`.test.ts`: the three modes, the modal ordering rules Discord imposes, attempt accounting, the TTL
that a wrong answer must not extend, the DM fallback when Discord refuses on the *send*, each failure
action, the fire-once guarantee, the panel post/edit/404-re-post lifecycle, and the permission-failure
path CLAUDE.md requires. The captcha renderer is asserted as a distribution over 60 seeds, and the
form's mode-switching was verified in a real browser, not only as a string.

**Not proven.** The 31 `*.integration.test.ts` suites remain dark on this Windows host — Bun cannot
open the Docker named pipe, so Testcontainers cannot start. A skipped suite is not a passing suite;
these need a run somewhere Docker is reachable before any gate is claimed. Nothing in this change is
covered *only* by an integration suite, but the executor, bus and Redis paths it rides on are.

Three further gaps worth naming:

- The captcha's agreement metric measures where ink lands, not its shape, so it is blind to per-glyph
  rotation and skew — zeroing both leaves the distribution unchanged. Those two distortions are
  currently unguarded by any test.
- The tail bound catches a distortion being *removed* (deleting the tilt or the warp turns the suite
  red) but not a modest weakening.
- Nothing exercises the real `@napi-rs/canvas` path from inside the module: the renderer is injected
  and stubbed there so the suites stay runnable on Windows. The real render is covered in
  `packages/cards/test`.

---

## 4. The panel posts itself

The first cut put a **Post panel** button in the dashboard and a `verification.panel_requested` event
behind it. Both are gone. A gate whose panel an admin forgot to post is a gate nobody can pass, and
there is no version of that failure worth keeping a button for.

`reconcilePanel` now runs on `proton.config_changed`, which the api already publishes on every save.
On each save: post the panel if there is none, edit the one already there if there is, post a fresh
one if the remembered message has been deleted (`discord_404`), take the old message down first if
the panel channel changed, and take it down entirely if the channel is cleared or the module is
switched off. The panel and the settings can no longer drift apart.

The same change was made to `honeypot`'s channel notice, for the same reason.

**One bug this shook out.** Verification's manifest did not declare `delete_message`, which the new
take-down path executes. `moduleExecutor` throws `UndeclaredActionError` on an undeclared kind and
`listener-runtime` awaits the handler with no `try`/`catch`, so every take-down would have thrown out
of the handler rather than degrading. Module tests drive `DefaultActionExecutor` unwrapped, so no
suite could have caught it — the manifest assertion now pins the list with a comment saying what the
throw costs. Honeypot had the mirror of the same bug, missing `edit_message`.
