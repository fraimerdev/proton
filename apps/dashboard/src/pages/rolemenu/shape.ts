import {
  CUSTOM_ID_SEPARATOR,
  encodeCustomId,
  MAX_CUSTOM_ID_LENGTH,
  snowflakeSchema,
} from '@proton/core';
import {
  MENU_ID_MAX,
  MODULE_ID,
  type RolemenuConfig,
  type RolemenuKind,
  type RolemenuMenu,
  type RolemenuMode,
  SELECT_BINDING_KEY,
} from '@proton/module-rolemenu/config';
import { useState } from 'react';
import type { ModuleForm } from '../../components/module/form.ts';
import type { SegmentedOption } from '../../components/ui/controls.tsx';
import type { IconName } from '../../components/ui/icon.tsx';

export type RolemenuForm = ModuleForm<RolemenuConfig>;

export const MENU_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const SNOWFLAKE = /^\d{17,20}$/;

export const KIND_OPTIONS: readonly SegmentedOption<RolemenuKind>[] = [
  { value: 'reaction', label: 'Reactions', icon: 'smiley' },
  { value: 'button', label: 'Buttons', icon: 'list-checks' },
  { value: 'select', label: 'Dropdown', icon: 'caret-down' },
];

export const KIND_LABEL: Record<RolemenuKind, string> = {
  reaction: 'Reactions',
  button: 'Buttons',
  select: 'Dropdown',
};

export const KIND_HELP: Record<RolemenuKind, string> = {
  reaction: 'Members react to an existing message, with one emoji per role.',
  button: 'Proton posts a message with buttons, five to a row.',
  select: 'Proton posts a message with a dropdown of every role.',
};

export const KIND_ICON: Record<RolemenuKind, IconName> = {
  reaction: 'smiley',
  button: 'list-checks',
  select: 'caret-down',
};

export const MODE_OPTIONS: readonly SegmentedOption<RolemenuMode>[] = [
  { value: 'toggle', label: 'Toggle' },
  { value: 'add-only', label: 'Add only' },
  { value: 'unique', label: 'One at a time' },
];

export const MODE_LABEL: Record<RolemenuMode, string> = {
  toggle: 'Toggle',
  'add-only': 'Add only',
  unique: 'One at a time',
};

export function modeHelp(mode: RolemenuMode, kind: RolemenuKind): string {
  if (mode === 'toggle') {
    return kind === 'reaction'
      ? 'Removing the reaction removes the role.'
      : 'Picking a role again removes it.';
  }
  return mode === 'add-only'
    ? 'Proton never removes a role. Picking it again does nothing.'
    : 'Picking a role removes the other roles in this menu.';
}

export const SELECT_UNPICK_NOTE =
  'Discord only tells Proton what was picked, not what was unpicked, so picking a role the ' +
  'member already has counts as picking it again.';

export const RENAME_WARNING =
  'Renaming breaks the posted buttons or dropdown until you update the menu.';

export const MENU_ID_HELP =
  'Letters, digits, hyphens and underscores. /rolemenu and posted buttons find the menu by this ID.';

export const CHANNEL_HELP = 'Where Proton posts the menu, or where the reaction message is.';

export const MESSAGE_ID_HELP =
  'Leave empty to post a new message, or enter the ID of a menu Proton posted to update it.';

export const REACTION_MESSAGE_HELP =
  'The message members react to. In Discord, turn on Developer Mode, then right-click the ' +
  'message and choose Copy Message ID.';

export const REACTION_MESSAGE_REQUIRED =
  'A reaction menu needs the ID of the message members react to.';

export const MENU_ID_SHAPE =
  'must start with a letter or digit and contain only letters, digits, hyphens and underscores';

export const SEPARATOR_IN_KEY = `can’t contain '${CUSTOM_ID_SEPARATOR}', which Proton uses to tell choices apart`;

export const RESERVED_KEY = `can’t be '${SELECT_BINDING_KEY}', which is reserved for the dropdown itself`;

const MENU_ID_EMPTY = 'Role menu needs an ID.';

const NO_CHANNEL = 'Choose a channel.';

const BAD_MESSAGE_ID =
  'A message ID is 17 to 20 digits. Turn on Developer Mode in Discord, then copy the message ID.';

const NO_BINDINGS = 'Add at least one role.';

const NO_ROLE = 'Choose a role.';

const NO_EMOJI = 'Choose an emoji.';

const NO_KEY = 'Enter a key. It tells Proton which button or option was chosen.';

export function encodedLength(menuId: string, key: string): number {
  const encoded = encodeCustomId(MODULE_ID, menuId, key);
  return encoded.ok ? encoded.customId.length : encoded.length;
}

export function keyBudget(menuId: string): number {
  return MAX_CUSTOM_ID_LENGTH - encodedLength(menuId, '');
}

export function tooLongReason(menuId: string, key: string, length: number): string {
  return (
    `The menu ID '${menuId}' and the key '${key}' come to ${length} characters with Proton's ` +
    `prefix, and Discord allows ${MAX_CUSTOM_ID_LENGTH}. Shorten the menu ID or the key.`
  );
}

export type Problems = ReadonlyMap<string, string>;

export function liveProblems(config: RolemenuConfig): Problems {
  const problems = new Map<string, string>();
  const seenIds = new Set<string>();

  config.menus.forEach((menu, index) => {
    const base = `menus.${index}`;

    if (menu.id === '') {
      problems.set(`${base}.id`, MENU_ID_EMPTY);
    } else if (!MENU_ID_PATTERN.test(menu.id) || menu.id.length > MENU_ID_MAX) {
      problems.set(`${base}.id`, MENU_ID_SHAPE);
    } else if (seenIds.has(menu.id)) {
      problems.set(`${base}.id`, `Another role menu already has the ID '${menu.id}'.`);
    }
    seenIds.add(menu.id);

    if (!snowflakeSchema.safeParse(menu.channelId).success) {
      problems.set(`${base}.channelId`, NO_CHANNEL);
    }

    if (menu.kind === 'reaction' && !menu.messageId) {
      problems.set(`${base}.messageId`, REACTION_MESSAGE_REQUIRED);
    } else if (menu.messageId !== undefined && !SNOWFLAKE.test(menu.messageId)) {
      problems.set(`${base}.messageId`, BAD_MESSAGE_ID);
    }

    if (menu.bindings.length === 0) problems.set(`${base}.bindings`, NO_BINDINGS);

    const seenKeys = new Set<string>();

    menu.bindings.forEach((binding, at) => {
      const keyPath = `${base}.bindings.${at}.key`;
      const length = encodedLength(menu.id, binding.key);

      if (binding.key === '') {
        problems.set(keyPath, menu.kind === 'reaction' ? NO_EMOJI : NO_KEY);
      } else if (binding.key.includes(CUSTOM_ID_SEPARATOR)) {
        problems.set(keyPath, SEPARATOR_IN_KEY);
      } else if (binding.key === SELECT_BINDING_KEY) {
        problems.set(keyPath, RESERVED_KEY);
      } else if (seenKeys.has(binding.key)) {
        problems.set(keyPath, `Another role in this menu already uses '${binding.key}'.`);
      } else if (length > MAX_CUSTOM_ID_LENGTH) {
        problems.set(keyPath, tooLongReason(menu.id, binding.key, length));
      }
      seenKeys.add(binding.key);

      if (!snowflakeSchema.safeParse(binding.roleId).success) {
        problems.set(`${base}.bindings.${at}.roleId`, NO_ROLE);
      }
    });
  });

  return problems;
}

export function menuHasProblem(problems: Problems, index: number): boolean {
  const prefix = `menus.${index}.`;
  for (const path of problems.keys()) if (path.startsWith(prefix)) return true;
  return false;
}

export function setMenus(form: RolemenuForm, menus: RolemenuMenu[]): void {
  form.setValue((current) => ({ ...current, menus }));
}

export function setMenu(form: RolemenuForm, index: number, menu: RolemenuMenu): void {
  form.setValue((current) => ({
    ...current,
    menus: current.menus.map((existing, at) => (at === index ? menu : existing)),
  }));
}

export function uniqueMenuId(wanted: string, taken: ReadonlySet<string>): string {
  const stem = wanted.slice(0, MENU_ID_MAX);
  if (!taken.has(stem)) return stem;

  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${stem.slice(0, MENU_ID_MAX - tail.length)}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function menuIds(config: RolemenuConfig): Set<string> {
  return new Set(config.menus.map((menu) => menu.id));
}

// Holds the last matched index: the id is editable, so a plain lookup closes the editor mid-rename.
export function useMenuIndex(menus: readonly RolemenuMenu[], id: string | undefined): number {
  const [held, setHeld] = useState(-1);

  const matched = id === undefined ? -1 : menus.findIndex((menu) => menu.id === id);

  if (matched >= 0 && matched !== held) setHeld(matched);
  if (id === undefined && held !== -1) setHeld(-1);

  if (id === undefined) return -1;
  if (matched >= 0) return matched;
  return held >= 0 && held < menus.length ? held : -1;
}
