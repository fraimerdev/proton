# Message retention

Proton keeps message content only for features you turn on. The
[privacy policy](https://prtn.xyz/privacy) lists what every feature keeps.

## What is kept, and for how long

- **Incoming events**, message text included, clear out of Proton's queue within about a day, or
  about a week for the few that fail to process.
- **Message logs** and **ticket message capture** are off by default. Message logs keep text for 30
  days, and captured ticket messages are deleted 30 days after capture.
- **User reports** are off until you set them up. They keep a copy of the reported message until 30
  days after the report is resolved, and never more than 90 days.
- **Keep recent messages for cases** holds members' recent messages for an hour, and keeps the ones
  attached to a case for 30 days.
- **The message a member is punished from**, with Punish author or an accepted message report,
  stays on the case for 30 days, whether or not Keep recent messages for cases is on.
- **Starboard** keeps a copy of each message it reposts.
- **Achievements**, when on, keeps when and where members posted as hourly counts for 365 days. It
  never keeps what they wrote.
