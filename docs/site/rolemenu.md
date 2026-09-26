# Role Menus

## Keys

Button and dropdown menus give each role a key. Discord limits the ID behind a button to 100 characters, and Proton builds that ID from its own prefix, the menu ID and the key, so a long menu ID leaves less room for keys. The editor counts down the characters left once you get close.

## Dropdowns

Discord only tells Proton what a member picked, not what they unpicked. Picking a role the member already has counts as picking it again: in Toggle mode that removes it.

## Reaction menus and custom emoji

A reaction menu works on a message that already exists, so it needs that message's ID. In Discord, turn on Developer Mode, then right-click the message and choose Copy Message ID.

`/rolemenu` adds the menu's reactions to the message. Proton stores only the ID of a custom emoji, and Discord needs the emoji's name to react, so custom emoji have to be added by hand: react to the message once with each, and members can then use them.
