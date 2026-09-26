import {
  type ActionKind,
  COMMAND_CHANGES,
  type CommandChange,
  type CommandKind,
  commandLabel,
  isModerationActionKind,
  protonActionExecutedSchema,
  protonCommandsChangedSchema,
  protonConfigChangedSchema,
  protonSecurityTrippedSchema,
} from '@proton/core';
import { ServerLogColors } from '../colours.ts';
import { type LogField, type LogLine, logEmbed, userMention } from '../embed.ts';
import { moduleLabel } from './actions.ts';
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
  'unwarn',
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
      action: payload.enabledAfter ? 'turned on' : 'turned off',
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

const COMMAND_CHANGE_LABELS: Record<CommandChange, string> = {
  name: 'Name',
  description: 'Description',
  options: 'Option descriptions',
  privateReply: 'Respond privately',
  enabled: 'On or off',
};

function commandKindOf(key: string): CommandKind {
  if (key.startsWith('user:')) return 'user';
  if (key.startsWith('message:')) return 'message';
  return 'chat';
}

export function renderCommandsChanged(input: RenderInput): RenderResult | null {
  const parsed = protonCommandsChangedSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;
  const changed = COMMAND_CHANGES.filter((change) => payload.changed.includes(change));
  if (changed.length === 0) return null;

  const kind = commandKindOf(payload.key);
  const defaultName = kind === 'chat' ? payload.key : payload.key.slice(kind.length + 1);
  const renamedTo =
    payload.newName !== null && payload.newName !== payload.displayName ? payload.newName : null;

  const toggled = payload.enabledBefore !== payload.enabledAfter;
  const switchedOnly = toggled && changed.length === 1 && changed[0] === 'enabled';
  const switched = payload.enabledAfter ? 'Turned on' : 'Turned off';

  const lines: LogLine[] = [
    ...(renamedTo === null ? [] : [{ label: 'Renamed to', value: commandLabel(kind, renamedTo) }]),
    ...(defaultName === payload.displayName || defaultName === renamedTo
      ? []
      : [{ label: 'Default name', value: commandLabel(kind, defaultName) }]),
    actorLine(payload.actorId),
    { label: 'Where', value: payload.source },
  ];

  const labels = changed.map((change) =>
    change === 'enabled' && toggled ? switched : COMMAND_CHANGE_LABELS[change],
  );

  return {
    embed: logEmbed({
      subject: commandLabel(kind, payload.displayName),
      action: switchedOnly ? switched.toLowerCase() : 'settings changed',
      colour: switchedOnly
        ? payload.enabledAfter
          ? ServerLogColors.Add
          : ServerLogColors.Remove
        : ServerLogColors.Modify,
      lines,
      ...(switchedOnly ? {} : { fields: [{ name: 'Settings changed', value: labels.join('\n') }] }),
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

const ACTION_TITLES: Partial<Record<ActionKind, string>> = {
  send: 'sent a message',
  edit_message: 'edited a message',
  delete_message: 'deleted a message',
  add_reaction: 'added a reaction',
  remove_reaction: 'removed a reaction',
  interaction_reply: 'replied to a command',
  interaction_followup: 'followed up on a command',
  add_role: 'added a role',
  remove_role: 'removed a role',
  create_channel: 'created a channel',
  create_role: 'created a role',
  delete_role: 'deleted a role',
  delete_channel: 'deleted a channel',
  edit_channel: 'edited a channel',
  set_channel_overwrite: 'set channel permissions',
  delete_channel_overwrite: 'removed channel permissions',
  create_thread: 'created a thread',
  move_member: 'moved a member',
  set_member_nickname: 'changed a nickname',
  end_poll: 'ended a poll',
  pin_message: 'pinned a message',
  automod_rule_create: 'created an AutoMod rule',
  automod_rule_update: 'updated an AutoMod rule',
  automod_rule_delete: 'deleted an AutoMod rule',
  giveaway_draw: 'drew a giveaway',
  create_dm: 'opened a DM',
  set_bot_nickname: 'changed its nickname',
  set_bot_profile: 'changed its profile',
  set_bot_name_style: 'changed its name style',
};

export function renderActionExecuted(input: RenderInput): RenderResult | null {
  const parsed = protonActionExecutedSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;
  if (isModerationActionKind(payload.kind)) return null;

  return {
    embed: logEmbed({
      subject: 'Proton',
      action: ACTION_TITLES[payload.kind] ?? payload.kind.replaceAll('_', ' '),
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
      subject: moduleLabel(payload.moduleId),
      action: 'triggered',
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
