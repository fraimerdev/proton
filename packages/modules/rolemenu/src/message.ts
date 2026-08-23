import { encodeCustomId, MAX_BUTTONS_PER_ROW } from '@proton/core';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import {
  MODULE_ID,
  type RolemenuBinding,
  type RolemenuMenu,
  SELECT_BINDING_KEY,
} from './config.ts';

export type MessageComponent = Record<string, unknown>;

export type ComponentsResult =
  | { ok: true; components: MessageComponent[] }
  | { ok: false; humanReason: string };

function label(binding: RolemenuBinding): string {
  return binding.label ?? binding.key;
}

export function buildButtonRows(menu: RolemenuMenu): ComponentsResult {
  const rows: MessageComponent[] = [];

  for (let start = 0; start < menu.bindings.length; start += MAX_BUTTONS_PER_ROW) {
    const buttons: MessageComponent[] = [];

    for (const binding of menu.bindings.slice(start, start + MAX_BUTTONS_PER_ROW)) {
      const encoded = encodeCustomId(MODULE_ID, menu.id, binding.key);
      if (!encoded.ok) return { ok: false, humanReason: encoded.humanReason };

      buttons.push({
        type: ComponentType.Button,

        style: ButtonStyle.Secondary,
        custom_id: encoded.customId,
        label: label(binding),
      });
    }

    rows.push({ type: ComponentType.ActionRow, components: buttons });
  }

  return { ok: true, components: rows };
}

export function buildSelectRow(menu: RolemenuMenu): ComponentsResult {
  const encoded = encodeCustomId(MODULE_ID, menu.id, SELECT_BINDING_KEY);
  if (!encoded.ok) return { ok: false, humanReason: encoded.humanReason };

  return {
    ok: true,
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: encoded.customId,
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
    ],
  };
}

export function buildComponents(menu: RolemenuMenu): ComponentsResult {
  switch (menu.kind) {
    case 'button':
      return buildButtonRows(menu);
    case 'select':
      return buildSelectRow(menu);
    case 'reaction':
      return { ok: true, components: [] };
  }
}
