# User reports

User reports are part of the Moderation module. They stay off until you set them up.

## Setting up user reports

1. In the dashboard, open **Moderation → User reports** and choose **Set up user reports**.
2. Work through the five steps:
   1. How members report.
   2. The report channel, and the roles to notify.
   3. Reasons and evidence.
   4. Who can report, and who reviews reports.
   5. A summary of your choices. **Turn user reports on** saves everything.

## How members report

Members report with `/report`, **Apps → Report user** or **Apps → Report message**, or by reacting
to a message if you turn reactions on.

Discord still lists the Apps entries when a method is off, and members who use one are told it's
off. To hide them, turn them off on the dashboard's Commands page.

## Permissions

Proton needs these for user reports and punish settings:

- **View Channel**, **Send Messages** and **Embed Links** in the report channel and any archive
  channel.
- **Manage Messages** in the report and archive channels, if closed reports are moved or deleted.
- **Manage Messages** in the channels members react in, to remove the report reaction.
- **Manage Messages** wherever a reported message should be deleted.
- **View Channel** and **Read Message History** in the channels messages are reported from, to read
  linked messages and forward copies.
- **Timeout Members**, **Kick Members** and **Ban Members**, for timeouts, kicks and bans.
- **Move Members**, to disconnect members from voice.
- **Manage Roles**, for roles given or taken on punishment or by report automation.
- **View Audit Log**, for the member notifications about punishments someone else gives.
- **Mention Everyone**, only if a role to notify isn't mentionable.

The Server Members and Message Content intents Proton already uses cover the rest.

## Who sees what

- **Staff** see each report in the report channel, including who filed it.
- **Reporters** get a private confirmation, and a DM when staff accept or dismiss their report. You
  can turn both DMs off under **Messages**. Reaction reports are always confirmed by DM, because
  there is no command to reply to.
- **The reported member** is never told who reported them or what the reports say. They only hear
  about a report if an automation rule messages them or staff punish them.
- **Reactions are public.** Until Proton removes a report reaction, anyone who can see the message
  can see it and who added it.

## Reviewing reports in Discord

Each report card in the report channel has buttons. Only reviewers (members with Manage Server or
a reviewer role) can use them, and anyone else is told why not.

- **Claim** and **Unclaim** show who is looking at a report, so two people don't act on it at once.
- **Accept** opens a choice of warn, time out, kick, ban or no punishment, limited to what the
  reviewer's own Discord permissions allow.
- **Dismiss** closes the report with an internal note, and an optional note for the reporter.
- **View member** and **View evidence** show the reviewer the member's history and everything
  captured with the report. Only the reviewer sees them.

Being a reviewer doesn't grant ban, kick or timeout. Each punishment still needs its own
permission. A member who filed a report can't accept or dismiss it, unless they own the server.

## Evidence

When **Copy reported messages** is on, Proton forwards a reported message into the report channel,
so staff still have it if it's deleted. Forwarded copies stay in the report channel until staff or
the closing setting delete them. For files, Proton stores their names and links, never the files.
How long Proton keeps its own copy of a reported message is covered in Message retention.
