import {
  errorStatus,
  interactionRef,
  type ModuleContext,
  type ProtonEvent,
  parseCustomId,
  readComponentInteraction,
  successStatus,
} from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import { findMenu, MODULE_ID, type RolemenuConfig } from './config.ts';
import { bindComponentDeps, describeUnbound, type RolemenuDeps } from './deps.ts';
import {
  deferEphemeral,
  describeReport,
  followUp,
  replyEphemeral,
  runRoleChanges,
} from './perform.ts';
import { resolveRoleChanges } from './resolve.ts';

export interface MenuBinding {
  menuId: string;
  bindingKey: string;
}

export function readMenuBinding(customId: unknown): MenuBinding | null {
  const parsed = parseCustomId(customId);
  const bindingKey = parsed?.args.length === 1 ? parsed.args[0] : undefined;
  if (!parsed || parsed.moduleId !== MODULE_ID || !bindingKey) return null;

  return { menuId: parsed.action, bindingKey };
}

export type ComponentOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'applied'; menuId: string; added: string[]; removed: string[] }
  | { action: 'refused'; reason: string };

const NOT_WIRED =
  'I can’t change your roles right now, so nothing was changed. This is a fault on my side, not ' +
  'a setting in this server.';

export async function handleComponent(
  event: ProtonEvent,
  ctx: ModuleContext<RolemenuConfig>,
  rawDeps: RolemenuDeps,
): Promise<ComponentOutcome> {
  const facts = readComponentInteraction(event);
  if (!facts) {
    ctx.logger.error(
      'rolemenu received an interaction.component it could not read, so whoever pressed it was ' +
        'left with a failed interaction. This is a gateway/normaliser mismatch.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
    );
    return { action: 'ignored', reason: 'unreadable interaction payload' };
  }

  const binding = readMenuBinding(facts.customId);
  if (!binding) {
    return { action: 'ignored', reason: 'the component is not a role menu’s' };
  }

  const { menuId, bindingKey } = binding;
  const interaction = interactionRef(facts);

  const bound = bindComponentDeps(rawDeps);
  if ('unbound' in bound) {
    ctx.logger.error(
      describeUnbound(`a press on menu '${menuId}' could not be completed`, bound.unbound),
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    await replyEphemeral(ctx, interaction, facts.userId, event.id, errorStatus(NOT_WIRED));
    return { action: 'refused', reason: 'the follow-up port is unbound' };
  }

  if (!ctx.config.enabled) {
    await replyEphemeral(
      ctx,
      interaction,
      facts.userId,
      event.id,
      errorStatus(
        'Role Menus is off in this server, so this menu does nothing right now. An admin can ' +
          'turn it on from the Proton dashboard.',
      ),
    );
    return { action: 'ignored', reason: 'role menus are off in this server' };
  }

  const menu = findMenu(ctx.config, menuId);
  if (!menu || menu.kind === 'reaction') {
    await replyEphemeral(
      ctx,
      interaction,
      facts.userId,
      event.id,
      errorStatus(
        menu
          ? `'${menuId}' is now a reaction menu, so this message does nothing. React to the ` +
              "menu's message to get your roles, or ask an admin to post the menu again."
          : `This menu (${menuId}) no longer exists, so I can't give you any roles from it. Ask ` +
              'an admin to post it again or delete this message.',
      ),
    );
    return { action: 'refused', reason: `no button or dropdown menu '${menuId}'` };
  }

  const keys = facts.componentType === ComponentType.StringSelect ? facts.values : [bindingKey];

  if (keys.length === 0) {
    await replyEphemeral(
      ctx,
      interaction,
      facts.userId,
      event.id,
      errorStatus("You didn't choose anything, so your roles didn't change."),
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

  // Only when something actually moved: describeReport's fallback sentence says the member
  // already had what they asked for, which is a lie when the option is simply gone.
  const lines = add.size + remove.size > 0 ? [describeReport(report)] : [];
  if (unknownKeys.length > 0) {
    lines.push(
      `${unknownKeys.length === 1 ? 'One option is' : `${unknownKeys.length} options are`} no ` +
        'longer part of this menu and had no effect. Ask an admin to update the menu.',
    );
  }

  const fellShort = report.failures.length > 0 || unknownKeys.length > 0;

  // describeReport back as the last resort: with nothing else to say its "nothing changed" is
  // true, and an empty description would render as a lone emoji.
  const text = lines.length > 0 ? lines.join(' ') : describeReport(report);

  await followUp(
    ctx,
    { applicationId: bound.deps.applicationId, interaction },
    facts.userId,
    event.id,
    fellShort ? errorStatus(text) : successStatus(text),
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
