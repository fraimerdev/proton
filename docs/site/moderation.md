# Moderation

## Immunity and role hierarchy

With **Use role hierarchy** on, moderators can only punish members whose highest role is below
their own. The server owner can punish anyone, and nobody can punish the owner. Report automation
and warn escalation have no rank, so the immune role lists still protect members from them.

## Warn escalation

A step runs when a member reaches its warning count within the escalation window. Steps are ordered
by warning count, so change a step's count to move it. Each step needs a higher count than the one
before it, and a timeout step needs a duration.

## Audit-log reasons

Audit-log reasons use Proton placeholders, written `{like.this}`. If you're coming from Sapphire,
write `{punishment.reason}` for `${reason}`, `{moderator.username}` for `${authortag}`,
`{moderator.id}` for `${authorid}`, `{punishment.duration}` for `${duration}` and `{today}` for
`${currentdate}`.

## Keep recent messages for cases

While on, Proton holds up to 5 recent messages per member in each channel for an hour, and deleted
ones for 30 minutes. Messages attached to a case are kept for 30 days. The message a member is
punished from is kept on the case for 30 days whether or not this is on.

## Member notifications

Punishment DMs for bans and kicks are sent before the punishment lands, while the member can still
receive them. Notifications about punishments someone else gives, in Discord or with another bot,
need Proton to have View Audit Log. After a ban or kick the member has usually left, so those
rarely arrive.
