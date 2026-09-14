import { type ActionRow, MAX_BUTTONS_PER_ROW } from '@proton/core';
import { type RolemenuMenu, SELECT_BINDING_KEY } from '@proton/module-rolemenu/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { EmojiGlyph } from '../../components/discord/emoji-picker.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { emojisQuery } from '../../lib/queries.ts';
import { SNOWFLAKE } from './shape.ts';

export const PREVIEW_CAPTION =
  'Menus posted from the dashboard have no text above them. To add text, post the menu with ' +
  '/rolemenu and its message option.';

const NOTHING_YET = 'Add a role to see the menu here.';

const REACTION_EMPTY =
  'Proton posts no message for a reaction menu. It adds these reactions to the message in Message ' +
  'ID above.';

function labelOf(key: string, label: string | undefined): string {
  return label ?? key;
}

export function previewRows(menu: RolemenuMenu): ActionRow[] {
  if (menu.kind === 'reaction' || menu.bindings.length === 0) return [];

  if (menu.kind === 'select') {
    return [
      {
        kind: 'select',
        select: {
          key: SELECT_BINDING_KEY,
          placeholder: menu.mode === 'unique' ? 'Choose one' : 'Choose your roles',
          minValues: 1,
          maxValues: menu.mode === 'unique' ? 1 : menu.bindings.length,
          options: menu.bindings.map((binding) => ({
            key: binding.key,
            label: labelOf(binding.key, binding.label),
            action: {
              kind: 'role',
              mode: menu.mode === 'add-only' ? 'add' : 'toggle',
              roleId: binding.roleId,
            },
          })),
        },
      },
    ];
  }

  const rows: ActionRow[] = [];

  for (let start = 0; start < menu.bindings.length; start += MAX_BUTTONS_PER_ROW) {
    rows.push({
      kind: 'buttons',
      buttons: menu.bindings.slice(start, start + MAX_BUTTONS_PER_ROW).map((binding) => ({
        key: binding.key,
        style: 'secondary',
        label: labelOf(binding.key, binding.label),
      })),
    });
  }

  return rows;
}

function ReactionStrip({ menu, guildId }: { menu: RolemenuMenu; guildId: string }): ReactElement {
  const { data } = useQuery(emojisQuery(guildId));
  const byId = new Map((data ?? []).map((emoji) => [emoji.id, emoji]));

  if (menu.bindings.length === 0) {
    return <p className="rolemenu-preview-note">{NOTHING_YET}</p>;
  }

  return (
    <div className="rolemenu-reactions">
      {menu.bindings.map((binding, index) => {
        const custom = SNOWFLAKE.test(binding.key) ? byId.get(binding.key) : undefined;

        return (
          <span
            className="rolemenu-reaction"
            // biome-ignore lint/suspicious/noArrayIndexKey: two drafts may briefly share a key
            key={index}
          >
            {binding.key === '' ? (
              <span className="text-disabled">?</span>
            ) : custom ? (
              <EmojiGlyph
                emoji={{ id: custom.id, name: custom.name, animated: custom.animated }}
                size={16}
              />
            ) : SNOWFLAKE.test(binding.key) ? (
              <EmojiGlyph emoji={{ id: binding.key }} size={16} />
            ) : (
              <span style={{ fontSize: 16, lineHeight: 1 }}>{binding.key}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

export function MenuPreview({
  menu,
  guildId,
  channelName,
}: {
  menu: RolemenuMenu;
  guildId: string;
  channelName: string | undefined;
}): ReactElement {
  if (menu.kind === 'reaction') {
    return (
      <>
        <DiscordPreview message={undefined} channelName={channelName} empty={REACTION_EMPTY} />
        <ReactionStrip menu={menu} guildId={guildId} />
      </>
    );
  }

  return (
    <>
      <DiscordPreview
        message={{ components: previewRows(menu) }}
        channelName={channelName}
        empty={NOTHING_YET}
      />
      <p className="rolemenu-preview-note">{PREVIEW_CAPTION}</p>
    </>
  );
}
