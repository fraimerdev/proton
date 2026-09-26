import {
  type ComponentAction,
  type ComponentInteraction,
  type EventListener,
  type EventType,
  errorStatus,
  findComponentAction,
  interactionRef,
  labelOf,
  type ModuleContext,
  type ProtonEvent,
  readComponentInteraction,
  rowKeys,
  successStatus,
} from '@proton/core';
import { usedKeys } from '@proton/core/placeholders';
import { ComponentType } from 'discord-api-types/v10';
import { readComponentRef } from './component-id.ts';
import { findTemplate, type MessagesConfig, MODULE_ID } from './config.ts';
import {
  bindFollowUp,
  describeUnbound,
  logReadFailure,
  type MessagesDeps,
  readPlaceholderSources,
} from './deps.ts';
import {
  acknowledge,
  changeRoles,
  describeReport,
  followUp,
  replyEphemeral,
  respondTo,
} from './perform.ts';
import { MESSAGES_REPLY_SURFACE, type MessagesPerson, renderReply } from './placeholders.ts';

export const MESSAGES_COMPONENT_EVENT_TYPES: EventType[] = ['interaction.component'];

const WHERE = 'on the Proton dashboard under Messages';

const NOT_WIRED =
  'I can’t do that right now, so nothing was changed. This is a fault on my side, not a setting ' +
  'in this server.';

export type ComponentOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'refused'; reason: string }
  | {
      action: 'applied';
      messageName: string;
      added: string[];
      removed: string[];
      replies: number;
    };

function listKeys(keys: readonly string[]): string {
  return keys.map((key) => `'${key}'`).join(', ');
}

function payloadRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readField(record: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.hasOwn(record, key)) return undefined;

  const value = record[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function readPresser(payload: unknown, facts: ComponentInteraction): MessagesPerson {
  const interaction = payloadRecord(payload);
  const member = payloadRecord(interaction?.member);
  const user = payloadRecord(member?.user) ?? payloadRecord(interaction?.user);

  return {
    user: {
      id: facts.userId,
      username: textOrNull(user?.username),
      globalName: textOrNull(user?.global_name),
      avatarHash: textOrNull(user?.avatar),
      bot: user?.bot === true,
    },
    member:
      member === null
        ? null
        : {
            nick: readField(member, 'nick'),
            joinedAt: readField(member, 'joined_at'),
            premiumSince: readField(member, 'premium_since'),
            roleIds: facts.roleIds,
          },
  };
}

async function renderReplies(
  event: ProtonEvent,
  ctx: ModuleContext<MessagesConfig>,
  deps: MessagesDeps,
  facts: ComponentInteraction,
  where: { messageName: string; key: string },
  texts: readonly string[],
): Promise<string[]> {
  const meta = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    template: where.messageName,
    key: where.key,
  };
  const subject = `the reply on '${where.messageName}' (${where.key})`;
  const keys = usedKeys(MESSAGES_REPLY_SURFACE, texts, { allowedOnly: true });

  const sources = await readPlaceholderSources(
    deps,
    ctx.guildId,
    facts.channelId,
    keys,
    logReadFailure(ctx.logger, subject, meta),
  );
  const presser = readPresser(event.payload, facts);
  const now = deps.placeholders?.now() ?? Date.now();
  const lookup = MESSAGES_REPLY_SURFACE.build(
    { ...sources, actor: presser, user: presser },
    { now, keys },
  );

  return texts.map((text) =>
    renderReply(text, lookup, now, (code, message) => {
      ctx.logger.warn(`${subject}: ${message}`, { ...meta, code });
    }),
  );
}

export async function handleComponentPress(
  event: ProtonEvent,
  ctx: ModuleContext<MessagesConfig>,
  deps: MessagesDeps,
): Promise<ComponentOutcome> {
  const facts = readComponentInteraction(event);
  if (!facts) {
    ctx.logger.error(
      'embeds received an interaction.component it could not read, so whoever pressed it was left ' +
        'with a failed interaction. This is a gateway/normaliser mismatch.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
    );
    return { action: 'ignored', reason: 'unreadable interaction payload' };
  }

  const ref = readComponentRef(facts.customId);
  if (!ref) return { action: 'ignored', reason: 'another module owns that component' };

  const isSelect = facts.componentType === ComponentType.StringSelect;
  const what = isSelect ? 'dropdown' : 'button';
  const to = respondTo(ctx, interactionRef(facts), facts.userId, event.id);

  if (!ctx.config.enabled) {
    await replyEphemeral(
      ctx,
      to,
      errorStatus(
        `This ${what} doesn’t work right now because Messages is off in this server. An admin ` +
          'can turn it on from the Proton dashboard.',
      ),
    );
    return { action: 'refused', reason: 'embeds is disabled in this server' };
  }

  const saved = findTemplate(ctx.config.templates, ref.messageName);
  if (!saved) {
    await replyEphemeral(
      ctx,
      to,
      errorStatus(
        `This ${what} belongs to a template called '${ref.messageName}' that no longer exists, ` +
          `so it does nothing. An admin can recreate the template ${WHERE}, then post it again.`,
      ),
    );
    return { action: 'refused', reason: `no saved message '${ref.messageName}'` };
  }

  if (!saved.components.flatMap(rowKeys).includes(ref.key)) {
    await replyEphemeral(
      ctx,
      to,
      errorStatus(
        `The template '${saved.name}' no longer has a ${what} with the key '${ref.key}', so this ` +
          'message is out of date. An admin can post the template again with ' +
          `\`${labelOf(ctx, 'message', 'post')}\`.`,
      ),
    );
    return { action: 'refused', reason: `no component '${ref.key}' on '${saved.name}'` };
  }

  if (isSelect && facts.values.length === 0) {
    await replyEphemeral(ctx, to, errorStatus('You didn’t choose anything, so nothing changed.'));
    return { action: 'ignored', reason: 'no option was chosen' };
  }

  const actions: ComponentAction[] = [];
  const withoutAction: string[] = [];

  for (const optionKey of isSelect ? facts.values : [undefined]) {
    const action = findComponentAction(saved.components, ref.key, optionKey);
    if (action) actions.push(action);
    else withoutAction.push(optionKey ?? ref.key);
  }

  if (actions.length === 0) {
    await replyEphemeral(
      ctx,
      to,
      errorStatus(
        isSelect
          ? `The dropdown '${ref.key}' on '${saved.name}' has no action for ` +
              `${listKeys(withoutAction)}, so nothing changed. An admin can fix it ${WHERE}.`
          : `The button '${ref.key}' on '${saved.name}' has no action, so nothing happened. An ` +
              `admin can add one ${WHERE}.`,
      ),
    );
    return { action: 'refused', reason: `no action for ${listKeys(withoutAction)}` };
  }

  const bound = bindFollowUp(deps);
  if ('unbound' in bound) {
    ctx.logger.error(
      describeUnbound(`a press on '${saved.name}' was not carried out`, bound.unbound),
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    await replyEphemeral(ctx, to, errorStatus(NOT_WIRED));
    return { action: 'refused', reason: 'the follow-up port is unbound' };
  }

  const add = new Set<string>();
  const remove = new Set<string>();
  const replies: Array<{ content: string; ephemeral: boolean }> = [];
  const unknownHeldRoles: string[] = [];

  for (const action of actions) {
    if (action.kind === 'reply') {
      replies.push({ content: action.content, ephemeral: action.ephemeral });
      continue;
    }

    if (action.mode === 'add') add.add(action.roleId);
    else if (action.mode === 'remove') remove.add(action.roleId);
    else if (facts.roleIds === null) unknownHeldRoles.push(action.roleId);
    else (facts.roleIds.includes(action.roleId) ? remove : add).add(action.roleId);
  }

  for (const roleId of add) remove.delete(roleId);

  await acknowledge(ctx, to);

  const report =
    add.size + remove.size > 0
      ? await changeRoles(ctx, {
          userId: facts.userId,
          messageName: saved.name,
          add: [...add],
          remove: [...remove],
          idempotencyRoot: event.id,
        })
      : { added: [], removed: [], failures: [] };

  const notes: string[] = add.size + remove.size > 0 ? [describeReport(report)] : [];
  if (unknownHeldRoles.length > 0) {
    notes.push(
      `I can't tell which roles you already have, so I left ` +
        `${unknownHeldRoles.map((id) => `<@&${id}>`).join(', ')} alone. Press this ${what} in the ` +
        'server, not in a DM.',
    );
  }
  if (withoutAction.length > 0) {
    notes.push(
      `${listKeys(withoutAction)} ${withoutAction.length === 1 ? 'is' : 'are'} no longer set up ` +
        `on '${saved.name}', so I skipped ${withoutAction.length === 1 ? 'it' : 'them'}. An admin ` +
        `can fix that ${WHERE}.`,
    );
  }

  if (notes.length > 0) {
    const fellShort =
      report.failures.length > 0 || unknownHeldRoles.length > 0 || withoutAction.length > 0;
    const text = notes.join(' ');

    await followUp(
      ctx,
      respondTo(ctx, to.interaction, facts.userId, `${event.id}:roles`),
      bound.deps.applicationId,
      { ...(fellShort ? errorStatus(text) : successStatus(text)), ephemeral: true },
    );
  }

  const contents =
    saved.placeholders === true && replies.length > 0
      ? await renderReplies(
          event,
          ctx,
          deps,
          facts,
          { messageName: saved.name, key: ref.key },
          replies.map(({ content }) => content),
        )
      : replies.map(({ content }) => content);

  let sent = 0;

  for (const [index, reply] of replies.entries()) {
    const content = contents[index] ?? '';

    if (content.trim() === '') {
      ctx.logger.warn(
        `the reply on '${saved.name}' (${ref.key}) came out empty once its placeholders were ` +
          'filled in, so it was not sent.',
        { guildId: ctx.guildId, moduleId: MODULE_ID, template: saved.name, key: ref.key },
      );
      continue;
    }

    await followUp(
      ctx,
      respondTo(ctx, to.interaction, facts.userId, `${event.id}:reply:${index}`),
      bound.deps.applicationId,
      { content, ephemeral: reply.ephemeral, allowedMentions: { parse: [] } },
    );
    sent += 1;
  }

  if (report.failures.length > 0) {
    ctx.logger.warn(`embeds refused a press on '${saved.name}': ${report.failures.join(' | ')}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      userId: facts.userId,
      messageName: saved.name,
    });
    return { action: 'refused', reason: report.failures.join(' | ') };
  }

  return {
    action: 'applied',
    messageName: saved.name,
    added: report.added,
    removed: report.removed,
    replies: sent,
  };
}

export function createMessagesComponentListener(deps: MessagesDeps): EventListener<MessagesConfig> {
  return {
    types: MESSAGES_COMPONENT_EVENT_TYPES,
    handler: async (event, ctx) => {
      await handleComponentPress(event, ctx, deps);
    },
  };
}
