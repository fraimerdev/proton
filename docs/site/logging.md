# Logging

## What's archived

Logging is off until you turn it on. While it's on:

- **Log edits** keeps one entry for each edit: the new text, the author, the channel, the message ID and the time. It also keeps the old text if Proton still remembers the message. A link preview loading doesn't count as an edit.
- **Log deletions** keeps one entry for each deleted message, including each message in a bulk deletion: the channel, the message ID and the time. It also keeps the text and author if Proton still remembers the message, because Discord sends neither with a deletion.

## How long it's kept

Entries are kept for 30 days: the current UTC day and the 29 before it. Proton deletes a whole day of entries at a time, just after midnight UTC.

## Remembering recent message text

With **Remember recent message text** on, Proton keeps each new message's text, author and channel, with the file name and link of up to 10 attachments. Proton's own messages are never remembered. Attachment links can stop working after a while, because Discord's links expire.

Each message is remembered for the time you set, from 1 hour to 7 days (24 hours by default). A time outside that range uses the nearest limit. With Server Logs on, an edited message is remembered for a day from its latest edit.

Turning this setting off deletes everything already remembered when you save.

## Ignored channels

Messages in ignored channels are never archived or remembered.
