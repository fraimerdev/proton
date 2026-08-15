import type { ModuleContext, ProtonEvent } from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import { findMenu, type RolemenuConfig } from './config.ts';
import { parseCustomId } from './custom-id.ts';
import { bindComponentDeps, describeUnbound, type RolemenuDeps } from './deps.ts';
import {
  deferEphemeral,
  describeReport,
  followUp,
  MODULE_ID,
  replyEphemeral,
  runRoleChanges,
} from './perform.ts';
import { resolveRoleChanges } from './resolve.ts';

export interface ComponentFacts {
  interactionId: string;
  token: string;
  userId: string;

  roleIds: string[] | null;
  customId: string;
  componentType: number;

  values: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function readComponent(event: ProtonEvent): ComponentFacts | null {
  const d = record(event.payload);
  if (!d) return null;

  const interactionId = str(d.id);
  const token = str(d.token);
  const data = record(d.data);
  const customId = str(data?.custom_id);
  if (!interactionId || !token || !customId) return null;

  const member = record(d.member);
  const userId = str(record(member?.user)?.id) ?? str(record(d.user)?.id);
  if (!userId) return null;

  return {
    interactionId,
    token,
    userId,
    roleIds: Array.isArray(member?.roles) ? strings(member.roles) : null,
    customId,
    componentType: typeof data?.component_type === 'number' ? data.component_type : 0,
    values: strings(data?.values),
  };
}

export type ComponentOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'applied'; menuId: string; added: string[]; removed: string[] }
  | { action: 'refused'; reason: string };

const NOT_WIRED =
  "I can't finish that: this Proton deployment isn't fully set up, so I have no way to tell you " +
  'what happened afterwards. A server admin should check the Proton logs — the exact missing ' +
  'piece is named there.';

export async function handleComponent(
  event: ProtonEvent,
  ctx: ModuleContext<RolemenuConfig>,
  rawDeps: RolemenuDeps,
): Promise<ComponentOutcome> {
  const facts = readComponent(event);
  if (!facts) {
    ctx.logger.error(
      'rolemenu received an interaction.component it could not read, so whoever pressed it was ' +
        'left with a failed interaction. This is a gateway/normaliser mismatch.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
    );
    return { action: 'ignored', reason: 'unreadable interaction payload' };
  }

  const parsed = parseCustomId(facts.customId);
  if (!parsed) {
    return { action: 'ignored', reason: 'the component is not a role menu’s' };
  }

  const interaction = { id: facts.interactionId, token: facts.token };

  const bound = bindComponentDeps(rawDeps);
  if ('unbound' in bound) {
    ctx.logger.error(
      describeUnbound(`a press on menu '${parsed.menuId}' could not be completed`, bound.unbound),
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    await replyEphemeral(ctx, interaction, facts.userId, event.id, NOT_WIRED);
    return { action: 'refused', reason: 'the follow-up port is unbound' };
  }

  if (!ctx.config.enabled) {
    await replyEphemeral(
      ctx,
      interaction,
      facts.userId,
      event.id,
      'Role menus are switched off in this server, so this button does nothing right now. An ' +
        'admin can turn them back on from the Proton dashboard.',
    );
    return { action: 'ignored', reason: 'role menus are off in this server' };
  }

  const menu = findMenu(ctx.config, parsed.menuId);
  if (!menu || menu.kind === 'reaction') {
    await replyEphemeral(
      ctx,
      interaction,
      facts.userId,
      event.id,
      `This menu (${parsed.menuId}) is no longer set up in this server, so I can't give you ` +
        'anything from it. Ask an admin to re-post it or to delete the message.',
    );
    return { action: 'refused', reason: `no button or dropdown menu '${parsed.menuId}'` };
  }

  const keys =
    facts.componentType === ComponentType.StringSelect ? facts.values : [parsed.bindingKey];

  if (keys.length === 0) {
    await replyEphemeral(
      ctx,
      interaction,
      facts.userId,
      event.id,
      'You did not choose anything, so nothing changed.',
    );
    return { action: 'ignored', reason: 'no option was chosen' };
  }

  await deferEphemeral(ctx, interaction, facts.userId, event.id);

  const add = new Set<string>();
  const remove = new Set<string>();
  const unknownKeys: string[] = [];

  for (const key of keys) {
    const changes = resolveRoleChanges({
      menu,
      bindingKey: key,

      intent: 'toggle',
      currentRoleIds: facts.roleIds,
    });

    if (!changes) {
      unknownKeys.push(key);
      continue;
    }

    for (const roleId of changes.add) add.add(roleId);
    for (const roleId of changes.remove) remove.add(roleId);
  }

  for (const roleId of add) remove.delete(roleId);

  const report = await runRoleChanges(ctx, {
    userId: facts.userId,
    menuId: menu.id,
    add: [...add],
    remove: [...remove],
    idempotencyRoot: event.id,
  });

  const lines = [describeReport(report)];
  if (unknownKeys.length > 0) {
    lines.push(
      `${unknownKeys.length === 1 ? 'One option is' : `${unknownKeys.length} options are`} no ` +
        'longer part of this menu, so I skipped it. Ask an admin to re-post the menu.',
    );
  }

  await followUp(
    ctx,
    { applicationId: bound.deps.applicationId, interactionToken: facts.token },
    facts.userId,
    event.id,
    lines.join(' '),
  );

  if (report.failures.length > 0) {
    ctx.logger.warn(`rolemenu refused a press on '${menu.id}': ${report.failures.join(' | ')}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      userId: facts.userId,
      menuId: menu.id,
    });
    return { action: 'refused', reason: report.failures.join(' | ') };
  }

  return { action: 'applied', menuId: menu.id, added: report.added, removed: report.removed };
}
