# Server Logs

## Where logs are posted

Each log goes to its event's own channel if it has one, then to its category's channel, then to the default log channel. If none of the three is set, the log isn't posted.

An event set to On is posted even when its category is off. An event set to Off is never posted.

## Permissions

Server Logs needs View Channel, Send Messages, Embed Links and View Audit Log. Without them it can't run, and the dashboard says which one is missing. Most logs come from Discord's audit log, so View Audit Log matters as much as the channel permissions.

## Categories

Messages and Voice start off because they're the busiest. Every other category starts on.

- **Server:** server settings, onboarding, the server guide, command permissions and monetization.
- **Channels:** channels, threads and channel permissions created, changed or deleted.
- **Roles:** roles created, changed and deleted. Roles given to or taken from a member are logged under Members.
- **Members:** joins, leaves, members accepting the rules (Membership Screening), nickname changes and roles given or taken.
- **Messages:** edits, deletions, bulk deletions, pins and unpins.
- **Voice:** voice joins and leaves, members moved or disconnected by moderators, and server mutes and deafens.
- **Moderation:** bans, unbans, kicks, timeouts, warnings, purges, slowmode and channel locks, whether done in Discord or through Proton, plus prunes, bots added, expired timeouts and user reports.
- **Invites:** invites created and deleted.
- **Integrations:** webhooks and integrations added, changed or removed.
- **Emoji & stickers:** emoji, stickers and soundboard sounds.
- **Events & stages:** scheduled events and stage channels.
- **AutoMod:** Discord's own AutoMod rules, and the messages and members they act on.
- **Proton:** module and command settings, modules and commands turned on or off, Anti-Nuke, Anti-Raid and Honeypot triggers, giveaways, tickets, applications and other actions Proton took.

When Proton itself bans, kicks, times out or warns someone, the log names the moderator who asked for it, or "Proton" and the module when it acted on its own.

## Message text

Discord doesn't send the old text of an edited message, or the text and author of a deleted one. Edit and delete logs show them only if Logging is on and remembering recent message text.

## What isn't logged

- Activity in log channels, so Server Logs never logs its own posts.
- Activity in ignored channels, and actions by ignored users.
- Actions by bots, when Ignore bots is on.
- Members who accept the rules are logged only if they were still waiting on Membership Screening when Proton saw them.

## Busy servers

If Server Logs reaches 60 logs in a minute, it posts one notice and pauses until activity slows down. Events during the pause aren't logged.
