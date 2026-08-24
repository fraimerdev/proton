import { encodeCustomId } from '@proton/core';
import {
  MODULE_ID,
  OWNER_CONTROL_LABELS,
  type OwnerControl,
  PRIVACY_MODES,
  type PrivacyMode,
  type TempVcHub,
} from './config.ts';

const BUTTON = 2;
const ACTION_ROW = 1;
const STRING_SELECT = 3;
const USER_SELECT = 5;
const TEXT_INPUT = 4;

const SECONDARY = 2;
const DANGER = 4;

export const PANEL_ACTION = 'panel';
export const MODAL_ACTION = 'modal';

/** Buttons that open a picker or a modal rather than acting straight away. */
const NEEDS_TARGET: ReadonlySet<OwnerControl> = new Set([
  'trust',
  'block',
  'invite',
  'kick',
  'transfer',
]);

const GLYPHS: Record<OwnerControl, string> = {
  rename: '✏️',
  limit: '👥',
  privacy: '🔒',
  trust: '✅',
  block: '⛔',
  invite: '📨',
  kick: '👢',
  region: '🌍',
  claim: '👑',
  transfer: '🤝',
  delete: '🗑️',
};

/**
 * The order the buttons appear in, grouped so the destructive ones are never next to the ones an
 * owner presses constantly. Discord allows five buttons per row and five rows per message.
 */
export const PANEL_LAYOUT: readonly (readonly OwnerControl[])[] = [
  ['rename', 'limit', 'privacy', 'region'],
  ['trust', 'block', 'invite', 'kick'],
  ['claim', 'transfer', 'delete'],
];

export interface PanelInput {
  hub: TempVcHub;
  tempChannelId: string;

  /** Off when the server has switched member control off entirely. */
  ownerCommands: boolean;
}

function button(control: OwnerControl, tempChannelId: string): Record<string, unknown> | null {
  const encoded = encodeCustomId(MODULE_ID, PANEL_ACTION, control, tempChannelId);
  if (!encoded.ok) return null;

  return {
    type: BUTTON,
    style: control === 'delete' ? DANGER : SECONDARY,
    custom_id: encoded.customId,
    label: OWNER_CONTROL_LABELS[control],
    emoji: { name: GLYPHS[control] },
  };
}

/**
 * Only the controls this creator channel allows. The buttons are a convenience, never the
 * authorisation — every press is re-checked against the config and the database, because a panel
 * message outlives the settings that produced it.
 */
export function panelComponents(input: PanelInput): Record<string, unknown>[] {
  if (!input.ownerCommands || !input.hub.interfaceEnabled) return [];

  const rows: Record<string, unknown>[] = [];

  for (const group of PANEL_LAYOUT) {
    const buttons = group
      .filter((control) => input.hub.allow[control])
      .map((control) => button(control, input.tempChannelId))
      .filter((component): component is Record<string, unknown> => component !== null);

    if (buttons.length > 0) rows.push({ type: ACTION_ROW, components: buttons });
  }

  return rows;
}

export interface PanelMessage {
  content: string;
  components: Record<string, unknown>[];
}

export function panelMessage(input: PanelInput & { ownerId: string | null }): PanelMessage {
  const components = panelComponents(input);

  const who =
    input.ownerId === null
      ? 'This channel has no owner. Anyone inside can claim it.'
      : `<@${input.ownerId}> owns this channel.`;

  return {
    content:
      `### Temporary voice channel\n${who}\n` +
      (components.length === 0
        ? 'Its owner manages it with `/voice`.'
        : 'Only its owner can use these.'),
    components,
  };
}

export const PRIVACY_SELECT_ACTION = 'privacy';

export function privacySelect(
  tempChannelId: string,
  current: PrivacyMode,
): Record<string, unknown>[] {
  const encoded = encodeCustomId(MODULE_ID, PRIVACY_SELECT_ACTION, tempChannelId);
  if (!encoded.ok) return [];

  return [
    {
      type: ACTION_ROW,
      components: [
        {
          type: STRING_SELECT,
          custom_id: encoded.customId,
          placeholder: 'Who may join?',
          options: PRIVACY_MODES.map((mode) => ({
            label: mode[0]?.toUpperCase() + mode.slice(1),
            value: mode,
            default: mode === current,
            description:
              mode === 'public'
                ? 'Anyone who can see the channel'
                : mode === 'locked'
                  ? 'Visible, but only trusted members may join'
                  : 'Hidden from everyone but trusted members',
          })),
        },
      ],
    },
  ];
}

export const USER_SELECT_ACTION = 'member';

/** One picker reused by trust, block, invite, kick and transfer — the action rides the custom id. */
export function memberSelect(
  control: OwnerControl,
  tempChannelId: string,
  placeholder: string,
): Record<string, unknown>[] {
  const encoded = encodeCustomId(MODULE_ID, USER_SELECT_ACTION, control, tempChannelId);
  if (!encoded.ok) return [];

  return [
    {
      type: ACTION_ROW,
      components: [
        {
          type: USER_SELECT,
          custom_id: encoded.customId,
          placeholder,
          min_values: 1,
          max_values: 1,
        },
      ],
    },
  ];
}

export function needsTarget(control: OwnerControl): boolean {
  return NEEDS_TARGET.has(control);
}

export const RENAME_FIELD = 'name';
export const LIMIT_FIELD = 'limit';

export function renameModal(tempChannelId: string, current: string) {
  const encoded = encodeCustomId(MODULE_ID, MODAL_ACTION, 'rename', tempChannelId);
  if (!encoded.ok) return null;

  return {
    customId: encoded.customId,
    title: 'Rename your channel',
    components: [
      {
        type: ACTION_ROW,
        components: [
          {
            type: TEXT_INPUT,
            custom_id: RENAME_FIELD,
            style: 1,
            label: 'New name',
            value: current.slice(0, 100),
            min_length: 1,
            max_length: 100,
            required: true,
          },
        ],
      },
    ],
  };
}

export function limitModal(tempChannelId: string, current: number) {
  const encoded = encodeCustomId(MODULE_ID, MODAL_ACTION, 'limit', tempChannelId);
  if (!encoded.ok) return null;

  return {
    customId: encoded.customId,
    title: 'Set a member limit',
    components: [
      {
        type: ACTION_ROW,
        components: [
          {
            type: TEXT_INPUT,
            custom_id: LIMIT_FIELD,
            style: 1,
            label: 'How many may join? 0 for no limit',
            value: String(current),
            min_length: 1,
            max_length: 2,
            required: true,
          },
        ],
      },
    ],
  };
}
