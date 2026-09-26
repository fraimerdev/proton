# Achievements

## What counts

Each requirement counts one kind of activity. The dashboard shows a short version of these rules
behind the `?` next to a requirement; this is the full list.

### Send messages

- Messages and replies in text channels and threads count.
- Messages from bots and webhooks, system messages and ticket channels never count.
- A member’s messages count at most once per message cooldown (Settings). At 0 seconds every
  message counts.
- Excluded channels and roles (Settings) apply.
- Deleting a message later doesn’t remove it from the count.

### Be active on different days

- A day counts once when the member sends a message or spends a minute in voice that counts.
- Days are calendar days in the module’s time zone (Settings). Changing the time zone affects days
  after the change.

### Spend time in voice

- Whole minutes in voice and stage channels count while the member isn’t deafened. Muted or alone
  still counts, as it does for Leveling.
- The server’s AFK channel, bots, excluded channels and excluded roles never count.
- A stay under a minute adds nothing, and one stay counts for at most 24 hours.
- Progress is saved every 10 minutes and when the member leaves the channel.

### Stay in voice in one go

- The longest single stay in one voice channel while not deafened, up to 24 hours.
- Moving to another channel starts a new stay.
- Only the part of a stay inside the achievement’s dates counts.

### Spend time in temporary voice channels

- Voice minutes, but only in channels the Temporary Voice Channels module created.
- The channel members join to create one doesn’t count, and creating, renaming or deleting a
  channel adds nothing.

### React to messages

- One per message: several emoji on one message, or removing and re-adding a reaction, adds
  nothing more.
- Only reactions on messages under 7 days old count, at most 50 a day (in the module’s time zone).
- Reactions from bots, on the member’s own messages or on Proton’s messages don’t count.

### Receive reactions

- One per member per message, at most 5 a day from the same member, and only on messages under
  7 days old.
- Bots’ reactions and the member’s own reactions don’t count.
- Removing a reaction doesn’t take it back.

### Get messages onto the starboard

- Each of the member’s messages that Starboard posts counts once, even if it drops off the
  starboard and comes back.
- Messages from bots and webhooks never count.

### Boost the server

- Counts each time a member starts boosting (a new “boosting since” date) while Achievements is on.
- Adding more boosts while already boosting doesn’t count again, because Discord doesn’t say how
  many boosts a member has.

### Stay a member

- Days since the member last joined the server. Rejoining starts the count again, because Discord
  resets the join date.

### Reach a level

- The member’s Leveling level. Losing levels never removes an earned tier.

### Earn XP from activity

- XP that Leveling gives for messages and voice. Leveling’s own cooldown and exclusions apply.
- XP from achievement rewards and XP given by staff only count if you add them as XP sources.

### Enter giveaways

- Each giveaway the member entered counts once, when the giveaway ends.
- Leaving afterwards, or being disqualified at the draw, doesn’t take the entry back.
- Cancelled giveaways don’t count.

### Win giveaways

- Each giveaway the member won counts once: draws, rerolls that picked them and drops.
- A reroll never takes a win back.

### Get applications accepted

- Each of the member’s applications counts once, when staff accept it. Needs Applications on.
- Reopening and accepting it again doesn’t count twice, and reopening or rejecting it later doesn’t
  take it back.

### Earn other achievements

- How many other achievements the member holds, at any tier.
- Achievements that count other achievements are left out.

### Earn a specific achievement

- The member holds at least the chosen tier of another achievement.
- Only single achievements can use this requirement. An achievement can’t require itself, and
  achievements can’t require each other in a loop.

## Members who already qualify

Some requirements read the member’s current state instead of counting activity: Stay a member,
Reach a level, Earn other achievements and Earn a specific achievement. Members who already meet
them earn the achievement within a few minutes of it going active. For Stay a member, everyone else
earns it on the day they pass the milestone.

## Recorded progress

- Proton records activity only while Achievements is on, and keeps hourly counts for 365 days.
- An achievement counts activity from when it goes active. Turn on **Include recorded progress**
  (Schedule tab) to also count activity recorded before that, up to 365 days back, in the channels
  the achievement counts. Activity from before recording started is never counted.
- The Settings tab shows when recording started and any pauses.

## Rewards

- A tier can give up to 5 rewards: give a role, remove a role, or give XP. A tier gives XP once.
- Role rewards need Manage Roles, and Proton’s highest role must be above every reward role.
  Proton can’t change the roles of the server owner or members ranked at or above it.
- XP rewards are given through Leveling, so Leveling must be on. XP that failed because Leveling
  was off can be retried from Members after turning Leveling on.
- A reward that fails for a temporary reason is tried again automatically. Failed rewards show in
  Members with the reason, and can be retried from there.

## Announcements

- The server default is set on the Announcements tab. Each achievement can use it, have its own
  announcement, or not announce at all.
- **Current channel** posts where the member earned it. When it was earned outside a channel, such
  as in voice, or Proton can’t post in that channel, the fallback is used.
- **Attach the badge** adds the achievement’s badge image to unlock announcements. If the
  announcement has an embed, the badge becomes the first embed’s thumbnail unless it already has
  one. Layout messages can’t carry the badge.
- DMs never ping anyone. Members who don’t accept DMs from the server don’t get them.

## Almost there reminders

- Each achievement turns reminders on, and sets how close counts, in its Schedule tab. The message
  and where it goes are set on the Announcements tab.
- A member gets at most one reminder per achievement within the reminder cooldown, and only one
  per tier.

## Badges

- Each badge has a shape, an icon or an uploaded image, and either tier colours or one colour.
- Uploaded images can be PNG, JPEG or GIF, up to 256 KB and 1024×1024 pixels.
- Images no achievement uses are removed a day after they were uploaded.

## Recount tools

These are on each achievement’s Progress tab and use the saved version.

- **Re-check members** checks members with progress against the saved targets. Earned tiers stay
  earned, and tiers earned this way aren’t announced.
- **Rebuild from recorded activity** counts progress again from recorded activity, up to 365 days
  back. It shows what would change before anything does, and you choose whether new unlocks are
  announced.
- **Reset for everyone** clears every member’s progress and earned tiers for the achievement. You
  confirm by typing its name. Roles and XP already given stay given, and aren’t given again unless
  you allow it.

## Commands

- `/achievements` shows a member’s achievements and progress.
- `/achievement view` shows what an achievement takes, its tiers and rewards, and a member’s
  progress.
- `/achievement reset` resets a member’s progress and badges, for one achievement or all of them.
  It needs Manage Server, and the confirmation expires after 15 minutes.
