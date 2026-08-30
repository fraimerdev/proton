import {
  type ActionKind,
  protonActionExecutedSchema,
  protonConfigChangedSchema,
  protonSecurityTrippedSchema,
} from '@proton/core';
import { ServerLogColors } from '../colours.ts';
import { type LogField, type LogLine, logEmbed, userMention } from '../embed.ts';
import type { RenderInput, RenderResult } from './types.ts';

const REMOVES: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'ban',
  'kick',
  'purge',
  'lockdown',
  'remove_role',
  'delete_message',
]);

const ADDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'unban',
  'untimeout',
  'unlock',
  'add_role',
]);

export function colourForKind(kind: ActionKind): number {
  if (REMOVES.has(kind)) return ServerLogColors.Remove;
  if (ADDS.has(kind)) return ServerLogColors.Add;
  return ServerLogColors.Modify;
}

function actorLine(actorId: string): LogLine {
  if (actorId.startsWith('proton:')) {
    return { label: 'By', value: actorId.slice('proton:'.length) };
  }

  return { label: 'By', mention: userMention(actorId), value: actorId };
}

export function renderConfigChanged(input: RenderInput): RenderResult | null {
  const parsed = protonConfigChangedSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;
  if (payload.changedKeys.length === 0) return null;

  const fields: LogField[] = [{ name: 'Settings changed', value: payload.changedKeys.join('\n') }];

  return {
    embed: logEmbed({
      subject: payload.moduleName ?? payload.moduleId,
      action: 'settings changed',
      colour: ServerLogColors.Modify,
      lines: [
        { label: 'Module', value: payload.moduleId },
        actorLine(payload.actorId),
        { label: 'Where', value: payload.source },
      ],
      fields,
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderModuleToggled(input: RenderInput): RenderResult | null {
  const parsed = protonConfigChangedSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;
  if (payload.enabledBefore === payload.enabledAfter) return null;

  return {
    embed: logEmbed({
      subject: payload.moduleName ?? payload.moduleId,
      action: payload.enabledAfter ? 'switched on' : 'switched off',
      colour: payload.enabledAfter ? ServerLogColors.Add : ServerLogColors.Remove,
      lines: [
        { label: 'Module', value: payload.moduleId },
        actorLine(payload.actorId),
        { label: 'Where', value: payload.source },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderActionExecuted(input: RenderInput): RenderResult | null {
  const parsed = protonActionExecutedSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: 'Proton',
      action: payload.kind.replaceAll('_', ' '),
      colour: colourForKind(payload.kind),
      lines: [
        { label: 'Module', value: payload.moduleId },
        ...(payload.targetId
          ? [
              {
                label: 'Target',
                mention: userMention(payload.targetId),
                value: payload.targetId,
              },
            ]
          : []),
        actorLine(payload.actorId),
        { label: 'Case', value: payload.caseId },
        { label: 'Reason', value: payload.reason ?? 'No reason given' },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderSecurityTripped(input: RenderInput): RenderResult | null {
  const parsed = protonSecurityTrippedSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: payload.moduleId === 'antinuke' ? 'Anti-nuke' : 'Anti-raid',
      action: 'tripped',
      colour: ServerLogColors.Remove,
      lines: [
        { label: 'Trigger', value: payload.trigger },
        ...(payload.actorId ? [actorLine(payload.actorId)] : []),
        ...(payload.ownerExempt ? [{ label: 'Note', value: 'The server owner was exempt' }] : []),
        { label: 'What happened', value: payload.summary },
      ],
      ...(payload.actionsTaken.length > 0
        ? { fields: [{ name: 'Actions taken', value: payload.actionsTaken.join('\n') }] }
        : {}),
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}
