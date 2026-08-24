# Module Spec — `verification`

Status: expands the existing Phase 3 module. Parent spec: `docs/PLAN.md`; all invariants in PLAN.md §3 apply.
Where this file and PLAN.md conflict, PLAN.md wins.

This is the second pass over `verification`. The first pass built a role gate (`unverifiedRoleId` on
join, `/verify` to swap it for `verifiedRoleId`) plus quarantine. That gate had no front door: a member
had to know to type `/verify`. This pass gives it one, and gives an admin a choice of how hard the door
is to open.

---

## 1. What is being added

A **verification panel** — a Proton-authored message in a configured channel, carrying a button. The
panel is the first thing a new member sees. Pressing the button starts one of three challenges, chosen
per guild:

| `mode` | What the member does | Why an admin picks it |
|---|---|---|
| `button` | Presses the button. That is all. | Friction-free; stops nothing but drive-by lurkers and satisfies "click to accept the rules". |
| `captcha` | Reads a distorted-text image Proton renders, types the characters into a modal. | Stops scripted joins and token-stealer bots, which cannot read the image. |
| `website` | Opens a one-time link to Proton's dashboard and signs in with Discord. | Proves the human holds the Discord account, not just a stolen token. Nothing to solve, so it is the most accessible of the three. |

Plus a **failure action** — what Proton does to a member who exhausts their captcha attempts.

---

## 2. Locked decisions

| Area | Decision |
|---|---|
| Panel publish | **Automatically, when the config is saved.** No button and no slash command: a gate whose panel an admin forgot to post is a gate nobody can pass. Saving again edits the panel already there; moving the panel channel takes the old message down first; clearing the channel or switching the module off takes it down. |
| Panel identity | The button's `custom_id` carries the module and action only. A press re-reads live config, so an edited panel behaves correctly even if the posted message was never re-rendered. |
| Panel message id | Redis, `proton:verification:panel:{guildId}`. Re-posting **edits** the existing message when the id is still good and `send`s a new one on a `discord_404`. Verification owns no Postgres table and this pass does not add one. |
| Captcha rendering | `@proton/cards` on `@napi-rs/canvas`, already a dependency. **No new package.** |
| Captcha delivery | Configurable: ephemeral reply in the panel channel, or DM. A DM that cannot be delivered falls back to the ephemeral reply rather than failing — a closed DM must never be a dead end. |
| Captcha answer store | Redis with a TTL, `proton:verification:captcha:{guildId}:{userId}`. The quarantine store is the shape to copy, but it sets no expiry and a challenge must expire. |
| Captcha alphabet | Upper-case latin + digits, minus `0O1IL5S2Z` — the pairs a human cannot tell apart in a distorted render. Answers compare case-insensitively. |
| Web token | Stateless HMAC-SHA256, minted by the worker, verified by the dashboard. Nothing to store and nothing to clean up. Short expiry; see §7. |
| Web verification depth | Discord OAuth sign-in only. Proton confirms the session's Discord id equals the id the link was minted for. No browser captcha, no account-age heuristics. |
| Reaching Discord from the web | The dashboard and api **never** call Discord (PLAN.md I1). The web flow publishes a bus event; the worker's verification listener is what grants the role. |
| Failure action | `none` \| `kick` \| `ban` \| `timeout` \| `quarantine`, fired once when the last attempt is spent. `quarantine` reuses `quarantineRoleId`. |
| Existing behaviour | The join gate, `/verify`, `/quarantine` and `/unquarantine` keep working exactly as they do today. `mode` does not change what `/verify` does. |

---

## 3. Config

`VERIFICATION_SCHEMA_VERSION` goes to `2`. **Every existing key keeps its name, type and meaning**, so
this is a pure addition and needs no `liftStoredConfig` — a stored v1 config parses unchanged under v2.

```
enabled                boolean                         (existing)
mode                   'button' | 'captcha' | 'website'  default 'button'

panelChannelId         channel-id                      where the panel lives
panelTitle             string                          heading on the panel
panelBody              string                          the explanatory paragraph
panelButtonLabel       string                          default 'Verify'

unverifiedRoleId       role-id                         (existing)
verifiedRoleId         role-id                         (existing)
applyUnverifiedOnJoin  boolean                         (existing)

captchaDelivery        'channel' | 'dm'    default 'channel'    showWhen mode = captcha
captchaLength          number 4..8         default 6            showWhen mode = captcha
captchaAttempts        number 1..5         default 3            showWhen mode = captcha
captchaExpiry          duration            default '5m'         showWhen mode = captcha

failureAction          'none'|'kick'|'ban'|'timeout'|'quarantine'  default 'none'   showWhen mode = captcha
failureTimeout         duration            default '1h'         showWhen failureAction = timeout

quarantineRoleId       role-id                         (existing; also the failureAction target)
```

`showWhen` is new shared form infrastructure — §5.

---

## 4. Flows

### 4.1 The panel

An admin sets `panelChannelId`, writes the copy and saves. The worker posts a message carrying one
button whose `custom_id` is `proton:verification:verify`.

Every later save **edits that message** rather than posting another, so the panel and the settings
cannot drift apart. The message id is remembered in Redis; if somebody deletes the panel by hand, the
next save sees the `discord_404`, forgets the dead id and posts a fresh one.

### 4.2 `mode: 'button'`

```
press  →  defer ephemeral  →  planVerification  →  grant/clear roles  →  follow up
```

`planVerification` is already pure and already correct; it is reused unchanged.

### 4.3 `mode: 'captcha'`

```
press  →  render PNG  →  deliver (ephemeral, or DM)  →  store challenge (TTL)
       →  member presses "Enter code"  →  MODAL  →  submit  →  compare
          ├─ match     → grant/clear roles, clear challenge
          ├─ attempts left → tell them how many, offer a new image
          └─ spent     → failure action
```

Two ordering rules the Discord API imposes, both already load-bearing elsewhere in this repo:

- **A modal cannot follow a defer.** Opening the modal *is* the three-second acknowledgement, so the
  "Enter code" press must respond with the modal as its first and only response.
- **A modal cannot be answered with another modal.** A wrong code is answered with an ephemeral
  message carrying a fresh "Enter code" button, never by re-opening the modal.

This is why the image and the modal are two separate presses: a modal cannot carry an attachment, so
the image has to arrive in the message *before* it.

### 4.4 `mode: 'website'`

```
press  →  mint HMAC token  →  ephemeral reply carrying a link button
       →  dashboard /verify/$token  →  Discord sign-in  →  session id == token id?
       →  dashboard → api → bus: verification.web_passed
       →  worker verification listener  →  grant/clear roles
```

The member never returns to Discord to finish. The role appears while they are still on the page.

---

## 5. New shared form infrastructure (`packages/core/src/config/descriptor.ts`)

Two metadata keys, because the mode selector is unusable without them:

```ts
showWhen?: { path: string; equals: string[] }
optionLabels?: Record<string, string>
```

- `showWhen` — the descriptor renders only when `values[path]` is one of `equals`. It follows the
  existing `ruleIsOff` convention and marks the field `hidden` rather than unmounting it, so a hidden
  field keeps posting its stored value on save and switching modes never silently erases settings.
- `optionLabels` — maps an enum member to the text an admin reads. Today `EnumFieldInput` renders the
  raw schema string, so an admin literally reads `website`. Only legal on an enum, and every key must
  be one of that enum's options, enforced at descriptor-build time like every other hint.

A section whose descriptors are all hidden hides too, otherwise switching to `button` leaves two empty
captcha cards on the page.

**Blast radius**: `descriptor.ts` (types + validation), `generated-form.tsx` (visibility), `fields.tsx`
(`EnumFieldInput`). No existing module registers either key, so no existing form changes.

---

## 6. New bus events (`packages/core/src/events/types.ts`)

One new event. It is service-emitted — published by `apps/api`, never by the gateway — so it belongs in
`SERVICE_EMITTED_EVENT_TYPES` as well as `EVENT_TYPES`, or the registry's "somebody emits this" check
reads a verification listener for it as a typo.

| Event | Published when | Payload |
|---|---|---|
| `verification.web_passed` | The dashboard has verified a token against a signed-in session | `{ guildId, userId, jti, verifiedAt }` |

Posting the panel needs no event of its own: `proton.config_changed` is already published on every
save and already carries the guild, the module and the new enabled state.

`apps/api`'s bus is optional today and the process boots without Redis on purpose. This route is the
first that genuinely needs it, so it must refuse with a named, readable error when the bus is absent —
not silently succeed.

---

## 7. The web token

Minted in the worker, verified in the dashboard. Two processes, one shared secret, nothing stored.

```
body = base64url(json({ g: guildId, u: userId, e: expiresAtSeconds, j: jti }))
sig  = base64url(hmacSha256(VERIFY_LINK_SECRET, body))
token = `${body}.${sig}`
```

- Compared with a **constant-time** equality, never `===` on the signature.
- Expiry is short — 15 minutes. The link is a doorway, not a credential.
- `jti` exists so a token is identifiable in logs and in the audit trail without carrying the user id
  in plaintext into a URL.
- The token is not single-use. It does not need to be: replaying it re-grants a role the member already
  holds, and the expiry bounds the window. Storing used ids would mean giving the dashboard a Redis it
  does not currently have.
- `VERIFY_LINK_SECRET` (min 32 chars) is required by `apps/worker` and `apps/dashboard`, and must land
  in `.env.example` alongside the existing keys.

**Privacy note.** A per-member verification record is a new category of personal data about non-admins.
`apps/dashboard/src/components/legal/privacy-policy.tsx` is asserted by a test and must be updated in
the same change.

---

## 8. Manifest changes

`actionKinds` grows from `['add_role','remove_role','interaction_reply']` to add `send`,
`edit_message`, `interaction_followup`, `create_dm`, `kick`, `ban` and `timeout`. This is not
bookkeeping: `moduleExecutor` throws `UndeclaredActionError` on any kind absent from the list, and
`invitePermissions()` is derived from it, so a missing kind is a permission the bot is never invited
with.

`requiredPermissions` stays at `ManageRoles`. A failure action's permission is not a module-wide
requirement — the executor's precheck names the missing bit at fire time, which is the established
position (`packages/modules/cases/test/escalation.test.ts`).

Listeners grow from one to four: the existing `member.joined`, plus `interaction.component`,
`interaction.modal`, and `['proton.config_changed', 'verification.web_passed']`.

---

## 9. Edge cases that must be handled

| Case | Required behaviour |
|---|---|
| Panel button pressed while `mode` has changed since the panel was posted | Honour the **current** mode. The press re-reads config. |
| Captcha expired before the modal is submitted | Say so and offer a fresh image. Never count it as a failed attempt. |
| Member presses Verify twice, two challenges | The second render replaces the first; only the newest `challengeId` is accepted. |
| DMs closed and `captchaDelivery: 'dm'` | Fall back to the ephemeral reply and say why. Discord reports this as `50007` on the **send**, not on the DM-channel open. |
| Member already verified | Say so; do not re-run the grant or burn an attempt. |
| Failure action fails (hierarchy, permission) | Log with the executor's own `humanReason` naming the verb and the member. The member still gets a truthful reply. |
| `failureAction: 'quarantine'` with no `quarantineRoleId` | Refuse at fire time with a sentence naming the setting and the page to fix it, the way antiraid's `responseUnconfigured()` does. |
| Web token expired, malformed, or signed with the wrong secret | One generic "this link is no longer valid, press Verify again" for all three. Never leak which. |
| Web session's Discord id ≠ the token's | Refuse. This is the whole point of the mode. |
| Bus absent when the api must publish | Named refusal, surfaced to the admin. Never a silent success. |

---

## 10. Testing

Per CLAUDE.md a new module surface needs a happy path **and** a permission-failure path, minimum.

- Captcha rendering is pure — a plain `.test.ts`, never `*.integration.test.ts`, so it runs on the
  Windows host. Assert PNG magic + IHDR + dimensions the way `packages/cards/test/render.test.ts` does.
- The token helper is pure: round-trip, expiry, tamper, wrong-secret, and constant-time compare.
- `showWhen` / `optionLabels` are pure data-shaping: test `zodToDescriptors` directly against the real
  verification schema, and assert the rendered HTML the way `test/form-chrome.test.tsx` does.
- The interaction handlers get integration coverage alongside the existing gate and quarantine suites.
  **Those suites are dark on this Windows host** (Testcontainers cannot reach Docker) — a skipped suite
  is not a passing suite, and that limitation must be stated, not papered over.
