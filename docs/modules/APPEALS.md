# Module Spec — `appeals`

Status: new module, built alongside the honeypot upgrade. Parent spec: `docs/PLAN.md`; all
invariants in PLAN.md §3 apply. Where this file and PLAN.md conflict, PLAN.md wins.

A member who has just been banned cannot open a ticket, cannot press a button in a guild they are
no longer in, and — as of today — cannot press a button in a DM either. The one surface left is a
link they can open in a browser. That is what this module is built around.

---

## 1. The one behaviour

```
a module bans somebody and puts a signed link in the DM it sends
        │
        ▼
   they open it, sign in with Discord, and the link proves it is theirs
        │
        ▼
   they answer the form the admin wrote
        │
        ▼
   a card lands in the review channel with Accept and Turn down
        │
        ▼
   a decision: the ban is lifted or it stands, and they are told either way
```

---

## 2. Why a link and not a button

`apps/worker/src/listener-runtime.ts` returns early on `event.guildId === null`, and the gateway
normaliser passes Discord's `guild_id` straight through for `INTERACTION_CREATE`. A component press
inside a DM therefore reaches **no module at all**.

That is not a limitation this module chose to work around; it is the reason the boundary is a
signed link. It also means two surfaces already shipped are dead in `main` — tickets' DM rating
buttons and verification's DM captcha buttons — which is worth its own change and is deliberately
not folded into this one.

The link is HMAC-signed with `VERIFY_LINK_SECRET` through `packages/core/src/signed-link.ts`. Both
claim schemas carry a `purpose` literal and **both readers check it**: without that, an appeal token
would parse as a verification claims body — `z.object` strips unknown keys — and redeem at
`/verify/<token>` as a verification pass.

---

## 3. Locked decisions

| Area | Decision |
|---|---|
| Who mints the link | Whichever module punished somebody. Honeypot does; it stores only an opaque `appealPanelId` and never imports this package. |
| The link's identity | `(guildId, origin, jti)`. `jti` is the punishing module's own idempotency root, so a redelivered catch mints a byte-identical link and opening it twice finds the same appeal rather than filing a second. |
| Who may open it | The account the link was minted for, proved by comparing the OAuth session's Discord id against the claim. A forwarded link buys the sight of a form and nothing else. |
| Who may decide | Manage Server, or a role the server named. A named reviewer role is a **grant**, not a filter. |
| One open appeal | A partial unique index on `(guild_id, user_id) WHERE status = 'open'`. |
| Two reviewers at once | The conditional `UPDATE … WHERE status = 'open' RETURNING *` **is** the lock. Two presses are two event ids, so the executor's dedupe cannot arbitrate; the loser is told who got there first. |
| A crash mid-decision | A press on an already-decided appeal whose stored status matches the button **re-runs** every effect. All of them are keyed off the appeal id and safe to repeat, and the card is stamped **last**, so a half-finished decision keeps its live buttons and a moderator can see it did not complete. |
| Storage | `appeals` and `appeal_answers` live in this module's own `table.ts`. `packages/db/src/schema/` holds cross-module tables only. |
| Where it is written | Its own Drizzle store in both the API and the worker, following `DrizzleTicketStore`. Routing writes through the API would add an outage that does not exist today. |
| Schedules | None. An appeal waits on a person, not a clock. |

---

## 4. Config

Schema version **1**.

```
enabled            boolean          default false
reviewChannelId    channel-id       where an appeal lands when its form names none
reviewerRoleIds    role-id[]        who may decide, besides Manage Server
panels             AppealPanel[]    bespoke editor, tier-capped 1/5/15

AppealPanel {
  id                      string 1..32     what a honeypot points at — renaming is safe, re-iding is not
  name                    string
  enabled                 boolean          default true
  blurb                   string           shown above the form
  questions               AppealQuestion[] 1..5
  reviewChannelId         channel-id       overrides the server default
  windowDays              number 1..30     how long after the punishment it may be filed
  cooldownDays            number 0..365    how long before another may be
  allowResubmit           boolean          default false
  onApprove               enum             'unban' | 'untimeout' | 'nothing'
  liftBlocklistOnApprove  boolean          default true
  rejoinUrl               string           sent with an acceptance
  approvedMessage         string
  deniedMessage           string
}
```

---

## 5. `appealView`, and why it is one function

`web.ts` exports one pure function answering "is this link still good?", and **both** the page that
renders the form and the route that accepts a submission call it. A form that renders and then
refuses on submit has wasted somebody's only appeal.

Its one non-obvious rule: **an appeal already filed under this link outranks every closed reason.**
The same link is how a banned member is told what came of it, so a form switched off afterwards, or
a window that has since elapsed, must not take that answer away from somebody who used the link in
time.

---

## 6. What an appellant may put on a moderator's screen

An appeal is free text written by an unaffiliated stranger and rendered where moderators read it.

- Question labels are rebuilt from the panel, and answers under ids the panel does not carry are
  dropped. What a moderator reads is what the server asked, never what the browser sent.
- Every answer is length-capped at the schema, again in `checkAnswers`, and again at render.
- Answers are rendered inside a fence with backticks stripped, so a message cannot break out and
  choose the markdown on somebody else's screen.
- `allowedMentions: { parse: [] }` on the card and on every DM.

**This route deserves its own security review before it ships.** It is the only surface in Proton
that accepts prose from somebody who is not in the server.

---

## 7. Testing

Per CLAUDE.md a new module needs a happy path **and** a permission-failure path, minimum.

- `web.test.ts` is the highest-value file: one named case per `appealView` branch, plus a property
  that exactly one state is returned and every closed branch carries a non-empty sentence.
- `authorize.test.ts`: Manage Server, a named reviewer role as a grant, and a refusal naming which.
- `manifest.test.ts`: every action kind declared, both listeners, no schedules, the form-list cap.
- `appeals.integration.test.ts` needs Docker via Testcontainers and **does not run on the Windows
  host**. A skipped suite is not a passing suite.
