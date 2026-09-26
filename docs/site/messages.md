# Messages

## Scheduling a template

A scheduled template posts at its start time, then, if it repeats, once per interval (at least 1 minute, such as 24h or 7d). The start time needs a timezone, for example `2026-01-31T09:00:00Z`.

If Proton was offline when a post was due, the post can still go out once Proton is back. A one-off schedule whose start time has already passed when you save it doesn't post.

Turning Messages off cancels every scheduled post. Turning a single schedule off pauses it without removing it.

## Ping roles

A scheduled template can ping one role at the start of each post. While a ping role is set, it's the only mention in scheduled posts that notifies anyone: the template's own mention settings are ignored there. A template that uses a layout has no message text, so the role is only pinged if the layout already mentions it.

## Button and dropdown keys

Every button, dropdown and dropdown option that does something has a key. Keys must be unique within a template, because the key is how Proton tells which one was pressed. Link buttons open their link directly and don't use a key.

Discord limits the ID behind a button to 100 characters. Proton builds that ID from its own prefix, the template name and the key, so a long template name leaves less room for keys.

Buttons already posted remember the template's name. Renaming a template stops its posted buttons working until you post it again.

## Saved rows

A saved row is a row of buttons or a dropdown you can insert into any template. Inserting makes a copy: later changes to the saved row don't reach templates that already use it. If a key in the inserted row is already used in the template, Proton renames it in the copy.
