import { ServerLogColors } from '../colours.ts';
import { type LogField, logEmbed, roleMention } from '../embed.ts';
import { changeOf, num, type RenderInput, type RenderResult, record, str } from './types.ts';

function roleOf(
  input: RenderInput,
): { id: string; name: string; colour?: number | undefined } | null {
  const payload = record(input.entity);
  const role = record(payload?.role);

  const id = str(role?.id) ?? str(payload?.role_id);
  if (!id) return null;

  return {
    id,
    name: str(role?.name) ?? 'unknown',
    ...(num(role?.color) === undefined ? {} : { colour: num(role?.color) }),
  };
}

function roleEmbed(
  input: RenderInput,
  action: 'created' | 'deleted',
  colour: number,
): RenderResult | null {
  const role = roleOf(input);
  if (!role) return null;

  return {
    embed: logEmbed({
      subject: 'Role',
      action,
      colour,
      lines: [
        { label: 'Name', mention: roleMention(role.id), value: role.name },
        { label: 'Id', value: role.id },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderRoleCreated(input: RenderInput): RenderResult | null {
  return roleEmbed(input, 'created', ServerLogColors.Add);
}

export function renderRoleDeleted(input: RenderInput): RenderResult | null {
  return roleEmbed(input, 'deleted', ServerLogColors.Remove);
}

const ROLE_UPDATE_KEYS: Array<[string, string]> = [
  ['name', 'Name'],
  ['color', 'Colour'],
  ['permissions', 'Permissions'],
  ['hoist', 'Displayed separately'],
  ['mentionable', 'Mentionable'],
];

export function renderRoleUpdated(input: RenderInput): RenderResult | null {
  const role = roleOf(input);
  if (!role) return null;

  const fields: LogField[] = [];
  for (const [key, label] of ROLE_UPDATE_KEYS) {
    const { before, after } = changeOf(input.audit, key);
    if (before === undefined && after === undefined) continue;

    fields.push({ name: label, value: `${before ?? 'none'} → ${after ?? 'none'}` });
  }

  return {
    embed: logEmbed({
      subject: 'Role',
      action: 'updated',
      colour: ServerLogColors.Modify,
      lines: [
        { label: 'Name', mention: roleMention(role.id), value: role.name },
        { label: 'Id', value: role.id },
      ],
      ...(fields.length > 0 ? { fields } : {}),
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}
