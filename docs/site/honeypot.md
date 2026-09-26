# Honeypot

## What happens when someone posts in a bait channel

Proton ignores bots, webhooks, its own messages and Discord's system messages (such as join and
boost notices). A burst of messages from one member counts as one catch.

For everyone else, in this order:

1. Exempt members are logged in the incident log and left alone. Nothing below happens to them.
2. If Wait before acting is set, Proton waits. More messages from the same member don't extend the
   wait, and the action is cancelled if they leave or are banned first.
3. The DM is sent while the member is still in the server. It ends with account recovery advice,
   an Appeal button (only when the action is Ban and an appeal form is chosen) and a Rejoin button
   (when Offer a way back in is on).
4. If Timeout first is on, the member is timed out (skipped when the action is Timeout or Log
   only).
5. The action runs. A softban bans the member, deleting their recent messages, and lifts the ban
   straight away.
6. The message that triggered Honeypot is deleted, unless the ban already deleted it.
7. The incident is posted in the incident log, with the message quoted if Quote the message is on.
   Quotes are shown in a code block and cut off after 900 characters.
8. The bait channel's counter goes up.
9. If Block caught members is on, the member is blocked until a moderator lifts it.

## The counter button

Anyone can press the counter on a warning message to see how many members that channel has
caught. Only members with Ban Members or Manage Server also see which accounts were caught, and
that list covers the last 30 days.

## Camouflage

Once a day, Proton can post a short automated line in each armed bait channel, rename each one
with a new ending (archive, notes, scratch, staging, drafts, overflow or misc), or both. Renaming
needs the Manage Channels permission.
