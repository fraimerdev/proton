import {
  type EventListener,
  type EventType,
  type InteractionBase,
  interactionRef,
  type ModuleContext,
  openModal,
  type ProtonEvent,
  parseCustomId,
  readComponentInteraction,
  readModalInteraction,
  replyEphemeral,
} from '@proton/core';
import {
  MODULE_ID,
  OWNER_CONTROLS,
  type OwnerControl,
  PRIVACY_MODES,
  type PrivacyMode,
  type TempVcConfig,
  type TempVcHub,
} from './config.ts';
import { bindService, describeUnbound, type TempVcDeps } from './deps.ts';
import {
  LIMIT_FIELD,
  limitModal,
  MODAL_ACTION,
  memberSelect,
  needsTarget,
  PANEL_ACTION,
  PRIVACY_SELECT_ACTION,
  privacySelect,
  RENAME_FIELD,
  renameModal,
  USER_SELECT_ACTION,
} from './interface.ts';
import type { TemporaryVoiceService } from './service.ts';
import type { TempVoiceChannelRow } from './table.ts';

export const TEMPVC_INTERACTION_EVENT_TYPES: EventType[] = [
  'interaction.component',
  'interaction.modal',
];

const REGION_ACTION = 'region';

/** The region ids Discord publishes. 'auto' is Proton's own word for clearing the override. */
export const REGIONS = [
  'auto',
  'brazil',
  'hongkong',
  'india',
  'japan',
  'rotterdam',
  'singapore',
  'south-korea',
  'southafrica',
  'sydney',
  'us-central',
  'us-east',
  'us-south',
  'us-west',
] as const;

export interface Press {
  action: string;
  args: string[];
}

export function readPress(customId: unknown): Press | null {
  const parsed = parseCustomId(customId);
  if (!parsed || parsed.moduleId !== MODULE_ID) return null;

  return { action: parsed.action, args: parsed.args };
}

function isControl(value: string | undefined): value is OwnerControl {
  return (OWNER_CONTROLS as readonly string[]).includes(value ?? '');
}

export type Outcome =
  | { action: 'ignored'; reason: string }
  | { action: 'refused'; reason: string }
  | { action: 'done'; what: string };

interface Held {
  service: TemporaryVoiceService;
  row: TempVoiceChannelRow;
  hub: TempVcHub;
}

/**
 * Everything a press is allowed to do, re-derived from the config and the database. A panel message
 * outlives the settings that produced it and can be pressed by anybody who can see the channel, so
 * the buttons are never the authorisation — only the shortcut.
 */
async function authorise(
  ctx: ModuleContext<TempVcConfig>,
  deps: TempVcDeps,
  facts: InteractionBase,
  tempChannelId: string | undefined,
  control: OwnerControl | null,
  requireOwner: boolean,
): Promise<Held | { refused: string }> {
  if (!tempChannelId) return { refused: 'That button is missing the channel it belongs to.' };

  const bound = bindService(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('the temporary voice control panel', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { refused: 'Proton is not fully wired up in this deployment, so nothing was changed.' };
  }

  if (!ctx.config.ownerCommands) {
    return { refused: 'This server has turned off member control of temporary channels.' };
  }

  const row = await bound.repository.byId(tempChannelId);
  if (!row || row.guildId !== ctx.guildId || row.channelId === null) {
    return { refused: 'That channel is gone. This panel is left over from one Proton removed.' };
  }

  const hub = ctx.config.hubs.find((entry) => entry.channelId === row.hubChannelId);
  if (!hub) {
    return {
      refused:
        'The creator channel this was made from has been removed from the settings, so Proton no ' +
        'longer knows what it is allowed to do here.',
    };
  }

  if (control !== null && !hub.allow[control]) {
    return { refused: `This server has switched **${control}** off for these channels.` };
  }

  if (requireOwner && row.ownerId !== facts.userId) {
    return {
      refused:
        row.ownerId === null
          ? 'Nobody owns this channel. Press **Claim** to take it.'
          : 'Only the owner of this channel can use that.',
    };
  }

  return { service: bound.service, row, hub };
}

export async function handleComponent(
  event: ProtonEvent,
  ctx: ModuleContext<TempVcConfig>,
  deps: TempVcDeps,
): Promise<Outcome> {
  const facts = readComponentInteraction(event);
  if (!facts) return { action: 'ignored', reason: 'unreadable interaction payload' };

  const press = readPress(facts.customId);
  if (!press) return { action: 'ignored', reason: 'not a temporary voice component' };

  const to = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: facts.userId,
    interaction: interactionRef(facts),
    idempotencyKey: `${MODULE_ID}:${event.id}`,
  };

  const say = async (content: string): Promise<void> => {
    await ctx.executor.execute(replyEphemeral(to, { content }));
  };

  if (press.action === PANEL_ACTION) {
    const [rawControl, tempChannelId] = press.args;
    if (!isControl(rawControl)) return { action: 'ignored', reason: 'unknown control' };

    return panelPress(ctx, deps, facts, to, say, rawControl, tempChannelId);
  }

  if (press.action === PRIVACY_SELECT_ACTION) {
    const [tempChannelId] = press.args;
    const mode = facts.values[0];
    if (!PRIVACY_MODES.includes(mode as PrivacyMode)) {
      return { action: 'ignored', reason: 'unknown privacy mode' };
    }

    const held = await authorise(ctx, deps, facts, tempChannelId, 'privacy', true);
    if ('refused' in held) return refuse(say, held.refused);

    const ok = await held.service.applyAccess(ctx, held.row, mode as PrivacyMode);
    await say(ok ? `Your channel is now **${mode}**.` : couldNot('change who may join'));

    return { action: 'done', what: `privacy:${mode}` };
  }

  if (press.action === REGION_ACTION) {
    const [tempChannelId] = press.args;
    const region = facts.values[0] ?? 'auto';

    const held = await authorise(ctx, deps, facts, tempChannelId, 'region', true);
    if ('refused' in held) return refuse(say, held.refused);

    const ok = await held.service.setRegion(ctx, held.row, region === 'auto' ? null : region);
    await say(
      ok
        ? region === 'auto'
          ? 'Voice region back to automatic.'
          : `Voice region pinned to **${region}**.`
        : couldNot('set that region'),
    );

    return { action: 'done', what: `region:${region}` };
  }

  if (press.action === USER_SELECT_ACTION) {
    const [rawControl, tempChannelId] = press.args;
    if (!isControl(rawControl)) return { action: 'ignored', reason: 'unknown control' };

    const target = facts.values[0];
    if (!target) return { action: 'ignored', reason: 'no member chosen' };

    const held = await authorise(ctx, deps, facts, tempChannelId, rawControl, true);
    if ('refused' in held) return refuse(say, held.refused);

    return applyToMember(ctx, held, rawControl, target, facts.userId, say);
  }

  return { action: 'ignored', reason: `unknown action '${press.action}'` };
}

async function panelPress(
  ctx: ModuleContext<TempVcConfig>,
  deps: TempVcDeps,
  facts: InteractionBase,
  to: Parameters<typeof replyEphemeral>[0],
  say: (content: string) => Promise<void>,
  control: OwnerControl,
  tempChannelId: string | undefined,
): Promise<Outcome> {
  // Claim is the one control a non-owner is meant to press.
  const held = await authorise(ctx, deps, facts, tempChannelId, control, control !== 'claim');
  if ('refused' in held) return refuse(say, held.refused);

  // A modal has to be the first response to the interaction — it cannot follow a defer.
  if (control === 'rename') {
    const modal = renameModal(held.row.id, '');
    if (modal) await ctx.executor.execute(openModal(to, modal));

    return { action: 'done', what: 'rename:modal' };
  }

  if (control === 'limit') {
    const modal = limitModal(held.row.id, 0);
    if (modal) await ctx.executor.execute(openModal(to, modal));

    return { action: 'done', what: 'limit:modal' };
  }

  if (control === 'privacy') {
    await ctx.executor.execute(
      replyEphemeral(to, {
        content: 'Who may join your channel?',
        components: privacySelect(held.row.id, held.hub.privacy),
      }),
    );

    return { action: 'done', what: 'privacy:prompt' };
  }

  if (control === 'region') {
    await ctx.executor.execute(
      replyEphemeral(to, {
        content: 'Pick a voice region, or Automatic to let Discord choose.',
        components: regionSelect(held.row.id),
      }),
    );

    return { action: 'done', what: 'region:prompt' };
  }

  if (needsTarget(control)) {
    await ctx.executor.execute(
      replyEphemeral(to, {
        content: `Who would you like to ${control}?`,
        components: memberSelect(control, held.row.id, 'Pick a member'),
      }),
    );

    return { action: 'done', what: `${control}:prompt` };
  }

  if (control === 'claim') {
    if (held.row.ownerId !== null) {
      await say(
        held.row.ownerId === facts.userId
          ? 'You already own this channel.'
          : `<@${held.row.ownerId}> still owns this channel.`,
      );
      return { action: 'refused', reason: 'still owned' };
    }

    const won = await held.service.claim(ctx, held.row, facts.userId, held.hub.privacy);
    await say(won ? 'You own this channel now.' : 'Somebody claimed it a moment before you did.');

    return { action: 'done', what: 'claim' };
  }

  if (control === 'delete') {
    const ok = await held.service.destroy(ctx, held.row, 'deleted by its owner');
    await say(ok ? 'Channel deleted.' : couldNot('delete your channel'));

    return { action: 'done', what: 'delete' };
  }

  return { action: 'ignored', reason: `control '${control}' has no press behaviour` };
}

async function applyToMember(
  ctx: ModuleContext<TempVcConfig>,
  held: Held,
  control: OwnerControl,
  target: string,
  actorId: string,
  say: (content: string) => Promise<void>,
): Promise<Outcome> {
  if (target === actorId) {
    await say('That one only makes sense for somebody else.');
    return { action: 'refused', reason: 'self' };
  }

  if (control === 'kick') {
    const ok = await held.service.disconnect(ctx, held.row, target);
    await say(ok ? `Disconnected <@${target}>.` : `<@${target}> may have already left.`);

    return { action: 'done', what: 'kick' };
  }

  if (control === 'transfer') {
    const ok = await held.service.transfer(ctx, held.row, target, held.hub.privacy);
    await say(ok ? `<@${target}> owns this channel now.` : couldNot('hand over your channel'));

    return { action: 'done', what: 'transfer' };
  }

  const kind = control === 'block' ? 'block' : 'trust';
  const ok = await held.service.setAccess(ctx, held.row, target, kind, held.hub.privacy);

  await say(
    ok
      ? control === 'block'
        ? `<@${target}> is blocked from this channel.`
        : control === 'invite'
          ? `<@${target}> can now join <#${held.row.channelId}>.`
          : `<@${target}> can now join even when the channel is locked.`
      : couldNot('change who may join'),
  );

  return { action: 'done', what: control };
}

export async function handleModal(
  event: ProtonEvent,
  ctx: ModuleContext<TempVcConfig>,
  deps: TempVcDeps,
): Promise<Outcome> {
  const facts = readModalInteraction(event);
  if (!facts) return { action: 'ignored', reason: 'unreadable modal payload' };

  const press = readPress(facts.customId);
  if (!press || press.action !== MODAL_ACTION) {
    return { action: 'ignored', reason: 'not a temporary voice modal' };
  }

  const [what, tempChannelId] = press.args;

  const to = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: facts.userId,
    interaction: interactionRef(facts),
    idempotencyKey: `${MODULE_ID}:${event.id}`,
  };

  const say = async (content: string): Promise<void> => {
    await ctx.executor.execute(replyEphemeral(to, { content }));
  };

  const control: OwnerControl = what === 'limit' ? 'limit' : 'rename';
  const held = await authorise(ctx, deps, facts, tempChannelId, control, true);
  if ('refused' in held) return refuse(say, held.refused);

  if (what === 'limit') {
    const raw = (facts.fields[LIMIT_FIELD] ?? '').trim();
    const limit = Number.parseInt(raw, 10);

    if (!Number.isInteger(limit) || limit < 0 || limit > 99) {
      await say(`“${raw}” is not a number between 0 and 99. 0 means no limit.`);
      return { action: 'refused', reason: 'bad limit' };
    }

    const ok = await held.service.setLimit(ctx, held.row, limit);
    await say(
      ok
        ? limit === 0
          ? 'Removed the member limit.'
          : `Your channel now holds ${limit} member${limit === 1 ? '' : 's'}.`
        : couldNot('change the limit'),
    );

    return { action: 'done', what: 'limit' };
  }

  const name = (facts.fields[RENAME_FIELD] ?? '').trim();
  if (name.length === 0) {
    await say('A channel needs a name — that one was empty.');
    return { action: 'refused', reason: 'empty name' };
  }

  const ok = await held.service.rename(ctx, held.row, name);
  await say(ok ? `Renamed your channel to **${name}**.` : couldNot('rename your channel'));

  return { action: 'done', what: 'rename' };
}

function regionSelect(tempChannelId: string): Record<string, unknown>[] {
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `proton:${MODULE_ID}:${REGION_ACTION}:${tempChannelId}`,
          placeholder: 'Voice region',
          options: REGIONS.slice(0, 25).map((region) => ({
            label: region === 'auto' ? 'Automatic' : region,
            value: region,
          })),
        },
      ],
    },
  ];
}

async function refuse(say: (content: string) => Promise<void>, reason: string): Promise<Outcome> {
  await say(reason);
  return { action: 'refused', reason };
}

function couldNot(what: string): string {
  return `I could not ${what}. Proton may be missing a permission on this channel.`;
}

export function createTempVcInteractionListener(deps: TempVcDeps): EventListener<TempVcConfig> {
  return {
    types: TEMPVC_INTERACTION_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      const outcome =
        event.type === 'interaction.modal'
          ? await handleModal(event, ctx, deps)
          : await handleComponent(event, ctx, deps);

      if (outcome.action === 'refused') {
        ctx.logger.info(`a temporary voice control was refused: ${outcome.reason}`, {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
      }
    },
  };
}
