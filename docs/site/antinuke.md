# Anti-Nuke

Anti-Nuke watches the audit log for destructive changes. When one member makes too many of one
kind within its window, Proton removes all of that member's roles, then does what **After
stripping roles** says.

## What is counted

- Channel deletions, role deletions, webhook deletions and emoji deletions each have their own
  limit and window. Bans and kicks share one.
- Each member is counted separately.
- Proton's own actions never count, and neither do changes the audit log doesn't attribute to
  anyone.
- The server owner is counted too, but Discord doesn't let bots remove the owner's roles, ban them
  or kick them. When the owner reaches a limit, Proton can only report it.

## When it trips

1. Proton removes the member's roles, highest first. Each removal is recorded as a case with the
   member's full role list, so the roles can be restored exactly.
2. Depending on **After stripping roles**, Proton then does nothing further, kicks the member, or
   bans them.
3. Proton posts a summary in the alert channel: what was detected, which roles were removed, what
   happened next and anything that failed.

If Proton can't read the member's roles, for example because they already left, it does nothing
and says so in the alert channel.

## Maintenance mode

Maintenance mode pauses Anti-Nuke while you make bulk changes, like deleting a batch of channels.
While it's on, destructive changes aren't counted at all, even once it ends. Nothing stops a
compromised account from emptying the server in that time, so keep **Longest maintenance window**
short.

- `/antinuke maintenance` starts it for the duration you give, up to the longest maintenance
  window. Running it again starts a new window from now.
- `/antinuke resume` ends it early. You can also end it from the Anti-Nuke page of the dashboard.
- `/antinuke status` shows whether Anti-Nuke is armed or paused, and its limits.

By default, only members with Manage Server can use `/antinuke`. Anti-Nuke re-arms by itself when
the window ends. Starting maintenance mode, and ending it with `/antinuke resume`, are both
announced in the alert channel.
