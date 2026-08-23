import {
  type ComponentAction,
  type EventListener,
  type EventType,
  findComponentAction,
  interactionRef,
  type ModuleContext,
  type ProtonEvent,
  readComponentInteraction,
  rowKeys,
} from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import { readComponentRef } from './component-id.ts';
import { findTemplate, type MessagesConfig, MODULE_ID } from './config.ts';
import { bindFollowUp, describeUnbound, type MessagesDeps } from './deps.ts';
import {
  acknowledge,
  changeRoles,
  describeReport,
  followUp,
  replyEphemeral,
  respondTo,
} from './perform.ts';

export const MESSAGES_COMPONENT_EVENT_TYPES: EventType[] = ['interaction.component'];

const WHERE = 'the Proton dashboard (Modules → Embeds)';

const NOT_WIRED =
  "I can't finish that: this Proton deployment isn't fully set up, so I have no way to tell you " +
  'what happened afterwards. Nothing was changed. A server admin should check the Proton logs — ' +
  'the exact missing piece is named there.';

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
      `This ${what} does nothing right now: the embed builder is switched off in this server. An ` +
        `admin can turn it back on from ${WHERE}.`,
    );
    return { action: 'refused', reason: 'embeds is switched off in this server' };
  }

  const saved = findTemplate(ctx.config.templates, ref.messageName);
  if (!saved) {
    await replyEphemeral(
      ctx,
      to,
      `This ${what} belongs to a saved message called '${ref.messageName}', which no longer ` +
        `exists in this server, so I can't tell what it should do. An admin can re-create it and ` +
        `re-post the message from ${WHERE}.`,
    );
    return { action: 'refused', reason: `no saved message '${ref.messageName}'` };
  }

  if (!saved.components.flatMap(rowKeys).includes(ref.key)) {
    await replyEphemeral(
      ctx,
      to,
      `The saved message '${saved.name}' no longer has a ${what} keyed '${ref.key}', so this ` +
        `message is out of date. An admin can re-post it from ${WHERE}.`,
    );
    return { action: 'refused', reason: `no component '${ref.key}' on '${saved.name}'` };
  }

  if (isSelect && facts.values.length === 0) {
    await replyEphemeral(ctx, to, 'You did not choose anything, so nothing changed.');
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
      isSelect
        ? `The dropdown '${ref.key}' on '${saved.name}' has nothing set up for ` +
            `${listKeys(withoutAction)}, so nothing changed. An admin can fix it in ${WHERE}.`
        : `The button '${ref.key}' on '${saved.name}' carries no action, so nothing happened. An ` +
            `admin can give it one in ${WHERE}.`,
    );
    return { action: 'refused', reason: `no action for ${listKeys(withoutAction)}` };
  }

  const bound = bindFollowUp(deps);
  if ('unbound' in bound) {
    ctx.logger.error(
      describeUnbound(`a press on '${saved.name}' was not carried out`, bound.unbound),
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    await replyEphemeral(ctx, to, NOT_WIRED);
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
        'server rather than in a direct message.',
    );
  }
  if (withoutAction.length > 0) {
    notes.push(
      `${listKeys(withoutAction)} ${withoutAction.length === 1 ? 'is' : 'are'} no longer set up ` +
        `on '${saved.name}', so I skipped ${withoutAction.length === 1 ? 'it' : 'them'}. An admin ` +
        `can fix that in ${WHERE}.`,
    );
  }

  if (notes.length > 0) {
    await followUp(
      ctx,
      respondTo(ctx, to.interaction, facts.userId, `${event.id}:roles`),
      bound.deps.applicationId,
      { content: notes.join(' '), ephemeral: true },
    );
  }

  for (const [index, reply] of replies.entries()) {
    await followUp(
      ctx,
      respondTo(ctx, to.interaction, facts.userId, `${event.id}:reply:${index}`),
      bound.deps.applicationId,
      { content: reply.content, ephemeral: reply.ephemeral, allowedMentions: { parse: [] } },
    );
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
    replies: replies.length,
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
