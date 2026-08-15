import { MAX_BUTTONS_PER_ROW } from '@proton/core';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import type { RolemenuBinding, RolemenuMenu } from './config.ts';
import { encodeCustomId, SELECT_BINDING_KEY } from './custom-id.ts';

export type MessageComponent = Record<string, unknown>;

function label(binding: RolemenuBinding): string {
  return binding.label ?? binding.key;
}

export function buildButtonRows(menu: RolemenuMenu): MessageComponent[] {
  const rows: MessageComponent[] = [];

  for (let start = 0; start < menu.bindings.length; start += MAX_BUTTONS_PER_ROW) {
    rows.push({
      type: ComponentType.ActionRow,
      components: menu.bindings.slice(start, start + MAX_BUTTONS_PER_ROW).map((binding) => ({
        type: ComponentType.Button,

        style: ButtonStyle.Secondary,
        custom_id: encodeCustomId(menu.id, binding.key),
        label: label(binding),
      })),
    });
  }

  return rows;
}

export function buildSelectRow(menu: RolemenuMenu): MessageComponent[] {
  return [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          custom_id: encodeCustomId(menu.id, SELECT_BINDING_KEY),
          placeholder: menu.mode === 'unique' ? 'Choose one' : 'Choose your roles',
          min_values: 1,
          max_values: menu.mode === 'unique' ? 1 : menu.bindings.length,
          options: menu.bindings.map((binding) => ({
            label: label(binding),
            value: binding.key,
          })),
        },
      ],
    },
  ];
}

export function buildComponents(menu: RolemenuMenu): MessageComponent[] {
  switch (menu.kind) {
    case 'button':
      return buildButtonRows(menu);
    case 'select':
      return buildSelectRow(menu);
    case 'reaction':
      return [];
  }
}
