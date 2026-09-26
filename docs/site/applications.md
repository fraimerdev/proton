# Applications

Applications collects staff, team, partnership and event applications through forms members fill
in on Discord or on the web, and gives staff one place to review them. It stays off until you turn
it on.

## Forms and templates

Start a form from a template (Moderator Application, Team Application, Partnership Request or Event
Application) or from scratch. Templates are ordinary forms you can change: they start closed, with
every requirement off.

- A form has up to 10 sections and 50 questions in total.
- Free servers can have 3 forms and 2 panels, Plus servers 10 and 5, and Pro servers 25 and 15.
- Archiving a form stops new applications, and members can't finish drafts on it, but it and its
  applications stay for review. An archived form can stay on a panel, and members who pick it are
  told it's no longer taking applications.

## Drafts and published versions

Saving a form saves your draft. Members only ever see a published version, so what they fill in
changes only when you publish: the questions, sections, branching, intro, confirmation text and
requirements. Everything else takes effect as soon as you save: whether the form is open, its
schedule and limits, review settings, messages, DMs, outcome actions and the interview ticket type.

A form needs at least one question, and no problems, before it can be published. Publishing a form
that hasn't changed since its last version does nothing.

When you publish, you choose what happens to members who have already started:

- **Keep** (the default): they finish on the version they started, and anyone who starts after you
  publish gets the new one.
- **Start again**: their saved answers are cleared, and they start again on the new version. Nothing
  is carried over.

## Questions

A question's label can be up to 45 characters, which is Discord's limit for a label in a form
window. Help text and placeholder text can be up to 100 characters each. Questions are required
unless you say otherwise.

| Type | What members give | Limits |
|------|-------------------|--------|
| Short answer | One line of text | Up to 4,000 characters, with an optional minimum and maximum |
| Paragraph | Longer text | Up to 4,000 characters, with an optional minimum and maximum |
| Single choice | One option | 2 to 25 options. In Discord, up to 10 show as a list to pick from and more as a dropdown |
| Multiple choice | Several options | 2 to 25 options, with an optional fewest and most. Up to 10 show as checkboxes in Discord, more as a dropdown |
| Number | A number | Optional smallest and largest values, and whole numbers only if you like |
| Link | A web address | `https://` only unless you also allow `http://`, and optionally only certain sites, such as `github.com` (subdomains count) |
| Confirmation | A single Yes box | Useful for "I have read the rules" |

Answers are checked, never cut: an answer that's too long, out of range or the wrong kind is sent
back to the member to fix. Proton never opens the links members give.

**Branching.** A question can be shown only when an earlier single choice, multiple choice or
confirmation question has one of the answers you pick. It can only depend on a question that comes
before it, so branches never loop. A hidden question is never required and its answer isn't kept,
and a question that depends on a hidden question is hidden too.

**Steps in Discord.** Discord shows a form as a series of windows of up to 5 questions, one after
another. Each section starts a new step, and a question that depends on another question in the same
step starts a new one, because Discord can't show or hide a question inside an open window.

**Not available:**

- File uploads. Proton has nowhere private to keep files and never downloads attachments, so ask
  for a link instead.
- Member, role and channel pickers.

## How members apply in Discord

Members start from a panel or with `/apply start`.

- **Panels** are posted from the Panels tab. A panel lists up to 10 forms as buttons, or up to 25 in
  a dropdown, and can include a **My applications** button. Posting a panel posts a new message
  each time.
- **Picking a form** shows its overview privately: the description and intro, each requirement with
  whether the member meets it, whether the form is open, who can read the answers and for how long,
  and a **Start** button. Discord limits how much text one message holds, so a very long intro may
  be shortened there.
- **Steps** open one window at a time. After each step Proton saves the answers and says what needs
  fixing, if anything. Closing a window before sending it loses what was typed in that window;
  earlier steps stay saved.
- **Save for later** keeps the answers. Members continue from the panel or with `/apply resume`, in
  Discord or on the web.
- **Review answers** shows everything before sending, with a way to change any step. **Submit**
  checks the requirements and the answers again, sends the application and gives the member a
  reference such as #12.
- **Cancel** deletes the saved answers after asking.

Everything happens in private replies in the server, so members with closed DMs can still apply.
They just don't get the DM updates, and can check with `/apply status`, **My applications** or the
status page instead.

If the same answers were changed somewhere else, such as on the web, while a step was open, Proton
keeps the newer answers and says so instead of overwriting them.

## How members apply on the web

Members sign in with Discord. To see a server's forms and apply, they must be in that server.

- `/apply` lists their applications in every server.
- `/apply/<server ID>` lists the server's open forms and their applications there.
- A form's page is where they fill it in. Answers save as they go, and a draft started in Discord
  continues on the web and the other way round. If the answers changed on another device or in
  Discord, the page says so instead of overwriting them.
- Each application has a status page, linked from the DMs, where the member sees its status, their
  answers and the reason staff gave, answers questions from staff, and can withdraw. It never shows
  who reviewed it, internal notes or votes.

## Who can apply

Requirements are part of the published version. They're checked when a member opens a form and again
when they send it.

- **Roles:** the member needs any one, or all, of the roles you pick.
- **Blocked roles:** members with any of these roles can't apply. A role can't be both required and
  blocked.
- **Account age:** the member's Discord account is older than a number of days.
- **Time in this server:** the member joined more than a number of days ago. Rejoining starts the
  count again, because Discord resets the join date.
- **Minimum level:** the member's Leveling level. This needs Leveling.
- **Moderation history:** no active moderation action, or no moderation actions (bans, kicks,
  timeouts and warnings) in a number of days. These need Cases. A member who fails them is only
  told their moderation history doesn't meet the form's requirements.

A check Proton can't run, because the module it needs is off or its data can't be read right now,
never counts as passed. Members can't start the form until it can be checked, and the dashboard
shows it as a setup problem, such as "Minimum level needs Leveling, which is off in this server."

## Intake

- **Open:** forms start closed. Members can't start or send an application until you open it, and a
  form also needs a published version.
- **Schedule:** an optional opening and closing time.
- **Cap:** the most applications the form takes. Applications that were sent and not withdrawn count
  towards it.
- **Reapply after:** how many days a member waits before applying to the form again (default 30),
  counted from their latest application, decision or withdrawal on that form.
- **Active applications per member:** 1 to 5 (default 1). Submitted, in review, waiting for
  information and waitlisted applications count. If you allow more than one, set Reapply after to 0,
  or the wait still applies between applications.

While a form is closed, before its opening time, after its closing time or once the cap is reached,
nobody can start or send an application. Members who already started keep their answers and can
still edit them, and can send them once the form opens again. Review of applications already sent
carries on. While the form is switched off, members see its closed message.

Turning the Applications module off is different: see [When Applications is off](#when-applications-is-off).

## Statuses

| Status | Meaning |
|--------|---------|
| Draft | Started, not sent |
| Submitted | Sent and waiting for review |
| In review | Claimed by a reviewer |
| Needs information | Staff asked the applicant a question |
| Waitlisted | Kept for later, and can still be accepted or rejected |
| Accepted, Rejected | Decided |
| Withdrawn | The applicant withdrew it |
| Expired | The applicant didn't answer staff in time, or their draft was cleared by a form change |

Submitted, In review, Needs information and Waitlisted are waiting for a decision. Accepted,
Rejected, Withdrawn and Expired are final.

| Action | From | To |
|--------|------|----|
| Submit (applicant) | Draft | Submitted |
| Claim | Submitted, In review, Needs information, Waitlisted | In review. Needs information stays Needs information |
| Assign | Submitted, In review, Needs information, Waitlisted | In review when assigned to someone. Unassigning sends In review back to Submitted. Needs information stays Needs information |
| Unclaim | In review | Submitted |
| Request information | Submitted, In review, Waitlisted | Needs information |
| Answer (applicant) | Needs information | In review if it's claimed, otherwise Submitted |
| Waitlist | Submitted, In review, Needs information | Waitlisted |
| Accept, Reject | Submitted, In review, Needs information, Waitlisted | Accepted, Rejected |
| Withdraw (applicant) | Submitted, In review, Needs information, Waitlisted | Withdrawn |
| Reopen | Accepted, Rejected | In review if it's claimed, otherwise Submitted |
| Deadline passes (Proton) | Needs information | Expired |
| Start again on publish (Proton) | Draft | Expired |
| Archive, Unarchive | Accepted, Rejected, Withdrawn, Expired | No change. Archiving only moves it out of the lists |

Drafts left unchanged for too long are deleted, not expired. Only accepted and rejected applications
can be reopened.

## Reviewing

### In Discord

New applications are posted as a card in the form's review channel, or in the default review channel
from Settings. Without a review channel there's no card, and staff review in the dashboard.

How much of the answers the card shows is set per form:

- **None:** only how many answers there are.
- **Summary** (the default): the first 3 answers, each cut at 300 characters.
- **Full:** as many answers as fit, each cut at 1,000 characters on the card.

Summary and Full both need a channel only the review team can read. If @everyone, any role outside
the team, or any member added to the channel can see it, Proton shows no answers on the card and says
why. Administrator roles and Proton's own role don't count, and a thread is judged by its parent
channel. If Proton can't check who can see the channel, it also leaves the answers off. **Read all
answers** always shows everything, privately, to anyone on the team.

The card's buttons are **Claim** or **Unclaim**, **Accept**, **Reject**, **Open in dashboard** and
**More actions**: request information, waitlist, add a note, vote (when scoring or two reviewers is
on), open an interview ticket and read all answers. Once an application is final, its card keeps
only Read all answers and Open in dashboard.

- **Ping roles:** up to 10 roles are pinged in the review channel when an application arrives.
- **Reminders:** once an application has waited the time set in **Remind reviewers after (hours)**
  (48 by default, 0 turns it off) while still submitted or in review, Proton posts one reminder in
  the review channel, without pings. Without a review channel, the application's history notes that
  the review is overdue instead.
- `/applications queue` shows what's waiting, and `/applications view` opens one application by its
  number.

### In the dashboard

Admins review from the Submissions tab. Reviewers without Manage Server sign in and use the review
pages at `/review/<server ID>`, linked from the card and from `/applications queue`. Proton checks
their roles in the server on every request, so taking a role away takes effect straight away.

Assigning, reopening, archiving, retrying or cancelling a failed action, posting the card again,
exporting and deleting are only in the dashboard. Admins, and staff with Timeout Members, Kick
Members or Ban Members, also see the applicant's recent moderation cases.

### Who can do what

Each form uses the default review team from Settings, or its own reviewer, decider and viewer roles.
The reopen, export and delete roles are set once, in Settings, for every form. The server owner and
members with Administrator or Manage Server can do everything.

| Capability | What it allows | Who has it |
|------------|----------------|------------|
| View | Read applications and their answers | Viewer, reviewer and decider roles |
| Review | Claim, assign, add notes, vote, request information, waitlist, open interview tickets, retry or cancel failed actions, post the card again | Reviewer and decider roles |
| Decide | Accept, reject, archive | Decider roles, or reviewer roles when no decider roles are set |
| Override | Reopen accepted or rejected applications, and decide without a second reviewer | Reopen roles |
| Export | Download the applications they can view | Export roles, on forms they can view |
| Delete | Permanently delete applications | Delete roles |

Only the reviewer who claimed an application, or a decider, can unclaim it.

**No self-review.** Nobody can claim, vote on, add notes to or decide their own application, the
server owner included. Your own applications never appear in your queue or your exports.

**Two reviewers.** When a form needs two reviewers, the reviewer who decides counts as one, and
another reviewer must already have voted the same way. A vote only counts while its voter still has a
reviewer or decider role for the form. Members with a reopen role can decide anyway; that's recorded
in the application's history.

**Scoring.** With scoring on, each vote carries a score from 1 to 5. Scores and votes are for staff
only.

### Reasons, notes and questions

- **Reason for the applicant** (up to 1,000 characters, optional): written when accepting,
  rejecting or waitlisting. It goes in the decision DM as `{application.reason}` and on the status
  page, and the card shows it too.
- **Internal note** (up to 2,000 characters): only the review team sees it. Add one while deciding,
  or at any time.
- **Request information** (up to 2,000 characters): the applicant gets the question by DM and on the
  status page, and answers with **Answer** in Discord or on the web (up to 4,000 characters). If they
  don't answer within **Time to answer a question from staff (days)** (14 by default, 0 for no
  deadline), the application expires, and they're told by DM if the form sends DMs.
- **Reopen:** needs a reason, which is saved as an internal note and never shown to the applicant.
  What the earlier decision did stays done: roles it gave aren't taken back, and its actions don't
  run again. Its actions that hadn't run yet are skipped, and the earlier votes are cleared. An
  application whose answers were already deleted can't be reopened.

## Outcome actions and other modules

Each form can add and remove up to 10 roles each when an application is sent, accepted, rejected,
waitlisted or withdrawn.

- By default, roles Proton gave when the application was sent are taken back once it's accepted,
  rejected, withdrawn or expires. You can turn this off per form. Proton only takes back roles it
  gave for that application, never a role the member already had. It keeps a role the closing
  outcome adds again, and a role another of the member's applications still gives them.
- Role actions need Manage Roles, and Proton's highest role must be above the roles. Proton can't
  change the roles of the server owner or members ranked at or above it.
- You can only add a role to these lists if you could give it out yourself: you need Manage Roles,
  and the role must be below your own highest role. The server owner can add any role. The
  dashboard refuses the save otherwise.
- **XP** (up to 10,000) is given on acceptance through Leveling, which must be on. An application
  gives XP once, even if it's reopened and accepted again. If the XP never arrived, accepting again
  tries once more.
- **Interview tickets:** choose a Tickets ticket type for the form, then open one from the card or
  the dashboard. Tickets must be on. The ticket belongs to the applicant, adds the staff member who
  asked, and shows the form, the reference and when it was sent, never the answers. It ignores the
  applicant's own ticket limits, cooldown and blacklist, but not the server-wide limit. If the
  application already has an open ticket, that one is used; a closed one is reopened if its type
  allows reopening, otherwise a new one opens.
- **Achievements:** the **Get applications accepted** requirement counts each accepted application
  once.
- **Server Logs:** four entries in the Proton category: **Application submitted**, **Application
  accepted, rejected or waitlisted**, **Application reopened** and **Application action failed**.
  They never include answers, notes or reasons.
- **Economy:** Proton has no Economy module, so there's no currency reward.

## When something fails

After each change Proton works through the follow-up actions in the background: the card, DMs,
roles, XP, tickets and updates for other modules. A failed action never undoes the decision. An
accepted application stays accepted, and the card and the dashboard show what went wrong, such as
"Needs attention: Role update failed".

- Temporary problems, such as Discord being unavailable, are tried again with growing waits, up to
  30 minutes apart and 5 tries in all. Problems that won't fix themselves, such as a missing
  permission or a role above Proton's, fail straight away.
- **Retry** in the dashboard runs only that action again. **Cancel** stops it for good.
- If the applicant's DMs are closed, the DM fails with "Couldn't DM the applicant: their DMs are
  closed to Proton." Staff can retry once they open them.
- When a role from an acceptance hasn't been given yet, the acceptance DM says so.
- Before running a queued action, Proton checks it still applies. It's skipped if the application
  changed since (for example, it was reopened), the form was removed, DMs were turned off, the role
  was taken out of the outcome, or the XP reward was set to 0.

## When Applications is off

- `/apply` and `/applications` stop working, and buttons on panels and cards say Applications is
  off.
- The web pages say it's off, and members can't save or send answers.
- Reviewers can still read and export applications in the dashboard, but can't change anything
  except deleting.
- Queued actions and reminders wait, and carry on when it's turned back on.
- Questions from staff don't expire while it's off. When it's turned back on, any whose deadline
  passed get one more day.
- Answers are still deleted on schedule, and cards are still updated to leave them out. Removing a
  deleted application's card still happens.

## Keeping and deleting answers

- **Delete unsent drafts after (days):** 1 to 90, 30 by default. Counted from the last change.
- **Keep answers after a decision (days):** 7 to 365, 30 by default. Counted from when the
  application is accepted, rejected, withdrawn or expires; waitlisted applications keep their
  answers. Changing it reschedules every decided application that still has its answers. Reopening
  cancels the deletion.
- Deleting the answers removes them, the member's name as sent, the decision reason, the questions
  and replies between staff and the applicant, and internal notes. The card is updated to say so.
- What stays is a minimal record: IDs, the form, the status, dates, who decided and a history of who
  did what, without any text.
- **Delete** (on one application) removes its answers and text straight away, removes its card and
  cancels anything queued. If it was still open, Proton takes back the roles it gave when it was
  sent, unless the form keeps them. The minimal record stays.
- **Delete everything for one member** does the same for all their applications in the server, and
  deletes their drafts outright.
- Copies someone already downloaded can't be recalled.

**Exports** are CSV or JSON, up to 5,000 applications per file. A CSV has a column per question when
you export one form; JSON always includes the answers. A cell that starts with `=`, `+`, `-`, `@`, a
tab or a carriage return gets a leading `'`, so spreadsheets don't run it as a formula. Each export
is recorded in the audit log with how many rows it held.

## Permissions

Proton needs:

- **View Channel** and **Send Messages** in panel channels and review channels.
- **Manage Roles**, for outcome roles.
- **Mention Everyone**, only if a role to ping isn't mentionable.

## Commands

- `/apply start` shows a form's overview, where members start or continue.
- `/apply status` lists the member's applications in this server.
- `/apply resume` lists the ones they saved for later.
- `/apply withdraw` withdraws one that hasn't been decided yet.
- `/applications queue` shows what's waiting for review.
- `/applications view` opens an application by its number, with the actions the member may use.

`/applications` needs no Discord permission: only admins and members on a review team see
anything. Both commands are registered in the server only while Applications is on. They can be
renamed on the dashboard's Commands page, and Proton's replies use the new names.

## Placeholders

The DMs to applicants and the closed message fill in placeholders. The full list is in
`docs/PLACEHOLDERS.md`.

- Every applicant DM: `{application.id}` (the reference, like #12), `{application.number}`,
  `{application.name}`, `{application.status}`, `{application.submitted_at}`,
  `{application.url}` (the status page), `{user.*}` (the applicant), `{server.*}` and the time.
- Accepted, rejected and waitlisted messages also have `{application.reviewed_at}`,
  `{application.reason}` and `{moderator.*}` (who decided).
- The information request message also has `{application.request}`, the question from staff.
- The closed message has only `{application.name}`, `{server.*}` and the time.
- `{application.internal_note}`, `{application.votes}` and `{application.score}` are for staff
  only, so they're refused in every applicant message.
