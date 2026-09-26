# Anti-Raid

Anti-Raid scores every member who joins. When a member's score reaches **Score to act**, Proton
gives them the verification role, gives them the quarantine role, or kicks them, depending on the
action you choose. Bots are never scored.

## How a join is scored

Each join can pick up these signals:

| Signal | Points |
| --- | --- |
| Joined during a raid | 2 |
| Brand-new account (younger than the brand-new account age) | 2 |
| New account (younger than the new account age) | 1 |
| No avatar | 1 |

- Only the youngest matching age band counts, so a brand-new account scores 2, not 3.
- The highest possible score is 5.
- The lowest **Score to act** you can set is 3, so one signal on its own is never enough.
- Account age comes from when the Discord account was created. If Proton can't read the account's
  age, or the join carries no profile details, that signal isn't scored.

## Why the brand-new age can't be longer than the new age

Brand-new accounts are the youngest of the new ones, and they score more. If the brand-new age were
longer than the new age, older accounts would score more than younger ones, so Proton won't save
that setting. Setting both to the same age is allowed: every account younger than it scores as
brand new.

## What counts as a raid

A raid starts when the number of joins within the join window reaches **Joins per window**. While
that count stays at or above the limit, every join also scores the 2 raid points. Depending on
your Score to act, members may be acted on outside a raid too; the Response section on the
Anti-Raid page says whether they are.

## Alerts

When a raid starts, Proton posts one alert in the alert channel, and no more until the join window
has passed. The alert says how many accounts joined and what happens to members who reach the
score. If Server Logs is on, it can log raids too, as the Security module tripped event.

## What each action does

- **Add verification role** and **Add quarantine role** give the member that role. A role restricts
  nothing on its own: set your channel permissions so it can't see what it shouldn't. The quarantine
  role stays until a moderator removes it.
- **Kick** removes the member from the server.

Each action is recorded as a case. The case reason lists the member's score and every signal that
counted.
