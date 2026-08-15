import { MAX_BUTTONS_PER_ROW } from '@proton/core';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import type { RolemenuBinding, RolemenuMenu } from './config.ts';
import { encodeCustomId, SELECT_BINDING_KEY } from './custom-id.ts';

/**
 * Discord components, as loose JSON.
 *
 * `sendPayloadSchema` takes components as opaque records for a stated reason —
 * modelling Discord's component grammar in Zod would be a second source of truth
 * for a shape Discord already validates and changes on its own schedule. This
 * module builds them with `discord-api-types`' enums rather than bare numbers, so
 * the type numbers are pinned to the published constants even though the object
 * itself is untyped by the time it reaches the executor.
 */
export type MessageComponent = Record<string, unknown>;

function label(binding: RolemenuBinding): string {
  // The key is the fallback because for a reaction menu it *is* the emoji, and
  // for the other kinds a slug is at least something the admin chose and can
  // recognise. An empty label is a component Discord refuses outright.
  return binding.label ?? binding.key;
}

/**
 * Legacy action rows, buttons and string selects — no `IS_COMPONENTS_V2` flag.
 *
 * Verified August 2026: the legacy shapes still work without the flag, and the
 * flag would cost more than it gives here — it disables `content` and `embeds`,
 * so a guild could no longer put a sentence above its own role menu explaining
 * what the buttons do.
 */
export function buildButtonRows(menu: RolemenuMenu): MessageComponent[] {
  const rows: MessageComponent[] = [];

  for (let start = 0; start < menu.bindings.length; start += MAX_BUTTONS_PER_ROW) {
    rows.push({
      type: ComponentType.ActionRow,
      components: menu.bindings.slice(start, start + MAX_BUTTONS_PER_ROW).map((binding) => ({
        type: ComponentType.Button,
        // Secondary, deliberately. Primary reads as "the thing to press" and a
        // role menu has no such option; Danger would make picking a colour look
        // like deleting something.
        style: ButtonStyle.Secondary,
        custom_id: encodeCustomId(menu.id, binding.key),
        label: label(binding),
      })),
    });
  }

  return rows;
}

/**
 * One dropdown in one row.
 *
 * `max_values` is where the mode becomes visible to the member: `unique` allows
 * a single choice, so Discord's own client stops them picking two colours rather
 * than Proton accepting both and silently discarding one. The other modes allow
 * as many as there are options, because toggling three roles in one interaction
 * is the reason to prefer a dropdown over buttons in the first place.
 */
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

/**
 * The components for a menu, or none.
 *
 * A `reaction` menu has no components at all: it hangs off a message somebody
 * else wrote, and its "buttons" are reactions on that message. `/rolemenu`
 * handles it by seeding those reactions instead of posting anything.
 */
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
