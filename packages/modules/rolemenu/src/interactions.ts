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

/** What one button press or dropdown choice told us. */
export interface ComponentFacts {
  interactionId: string;
  token: string;
  userId: string;
  /** From the interaction's member object. Discord always resolves it for a guild interaction. */
  roleIds: string[] | null;
  customId: string;
  componentType: number;
  /** A dropdown's chosen option values — binding keys. Empty for a button. */
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

/**
 * Read an `interaction.component` event.
 *
 * The one place in this module that knows Discord's INTERACTION_CREATE type-3
 * shape, for the same containment reason `readReaction` exists.
 */
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

/**
 * Handle a button press or a dropdown choice.
 *
 * The three-second rule (I9) shapes the whole function. A component interaction
 * must be acknowledged within three seconds or Discord shows the member "This
 * interaction failed" and the token is gone; after the acknowledgement the token
 * is good for fifteen minutes. So the order is fixed:
 *
 *  1. decide whether this is even ours, from the `custom_id` alone;
 *  2. acknowledge — a deferred ephemeral message, which carries no body and so is
 *     the fastest thing Discord accepts;
 *  3. only then move roles, which is one REST call per role;
 *  4. follow up with what changed, or with the executor's own words for why it
 *     did not.
 *
 * Everything before the acknowledgement is in-memory: the config was read by the
 * listener runtime before this handler was called, so the only I/O on the path to
 * step 2 is step 2 itself. The cases that have nothing to go and *do* skip the
 * deferral and answer immediately, which is one call rather than two.
 */
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

  /**
   * The gate that keeps this module out of everyone else's interactions.
   *
   * `interaction.component` carries every component press in the guild, so most
   * of what arrives here belongs to some other module. Returning before
   * acknowledging is essential rather than merely tidy: an interaction may be
   * acknowledged exactly once, and answering someone else's button would take
   * the acknowledgement their handler needs.
   */
  const parsed = parseCustomId(facts.customId);
  if (!parsed) {
    return { action: 'ignored', reason: 'the component is not a role menu’s' };
  }

  const interaction = { id: facts.interactionId, token: facts.token };

  const bound = bindComponentDeps(rawDeps);
  if ('unbound' in bound) {
    // Answered rather than deferred: without the application id there is nothing
    // to follow up *with*, so the whole answer has to fit in the acknowledgement.
    ctx.logger.error(
      describeUnbound(`a press on menu '${parsed.menuId}' could not be completed`, bound.unbound),
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    await replyEphemeral(ctx, interaction, facts.userId, event.id, NOT_WIRED);
    return { action: 'refused', reason: 'the follow-up port is unbound' };
  }

  if (!ctx.config.enabled) {
    // The message outlives the setting. Somebody is looking at a live-looking
    // button, and "This interaction failed" would read as an outage.
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

  /**
   * A dropdown names its choices in `data.values`, a button in its own id.
   *
   * The dropdown's `custom_id` carries the reserved key in the binding position
   * — a select has one id for the whole component, so there is no single choice
   * for it to name.
   */
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
      // A press flips. Which way it flips is the mode's business, not the
      // event's — unlike a reaction, Discord tells us nothing about direction.
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

  // Two bindings in one menu may name the same role. When one choice grants it
  // and another would strip it, the grant wins: the member asked for that one by
  // name, and the strip is only ever a side effect of `unique`.
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
    // The menu was edited after its message was posted. Say so — the member
    // pressed a real button and is owed better than a shrug.
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
