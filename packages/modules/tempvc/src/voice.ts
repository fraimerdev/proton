import type { EventListener, EventType, ModuleContext, ProtonEvent } from '@proton/core';
import {
  hubFor,
  MODULE_ID,
  renderChannelName,
  type TempVcConfig,
  VOICE_CHANNEL_TYPE,
} from './config.ts';
import { planReconcile, planTransition, type TempVcStep } from './decide.ts';
import { bindStore, describeUnbound, type TempVcDeps } from './deps.ts';
import type { TempVcStore } from './store.ts';

export const TEMPVC_EVENT_TYPES: EventType[] = ['voice.state_updated', 'guild.available'];

export interface VoiceMember {
  userId: string;
  channelId: string | null;
  displayName: string;
  isBot: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readVoiceMember(payload: unknown): VoiceMember | null {
  const raw = record(payload);
  const userId = str(raw?.user_id);
  if (!raw || !userId) return null;

  const member = record(raw.member);
  const user = record(member?.user);

  return {
    userId,
    channelId: str(raw.channel_id),
    displayName:
      str(member?.nick) ?? str(user?.global_name) ?? str(user?.username) ?? `member ${userId}`,
    isBot: user?.bot === true,
  };
}

export function readVoiceStates(payload: unknown): Map<string, string[]> {
  const raw = record(payload);
  const states = Array.isArray(raw?.voice_states) ? raw.voice_states : [];

  const byChannel = new Map<string, string[]>();
  for (const entry of states) {
    const state = record(entry);
    const channelId = str(state?.channel_id);
    const userId = str(state?.user_id);
    if (!channelId || !userId) continue;

    byChannel.set(channelId, [...(byChannel.get(channelId) ?? []), userId]);
  }

  return byChannel;
}

export function readChannelIds(payload: unknown): Set<string> | null {
  const raw = record(payload);
  if (!Array.isArray(raw?.channels)) return null;

  const ids = new Set<string>();
  for (const entry of raw.channels) {
    const id = str(record(entry)?.id);
    if (id) ids.add(id);
  }

  return ids;
}

async function remove(
  ctx: ModuleContext<TempVcConfig>,
  store: TempVcStore,
  channelId: string,
  idempotencyKey: string,
): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_channel',
    actorId: MODULE_ID,
    reason: 'temporary voice channel is empty',
    idempotencyKey,
    dryRun: false,
    payload: { channelId },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.error(
      `an empty temporary voice channel could not be removed, so it will stay in the channel ` +
        `list: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, channelId, code: result.failure?.code },
    );
    return;
  }

  await store.release(ctx.guildId, channelId);
}

async function applyStep(
  ctx: ModuleContext<TempVcConfig>,
  store: TempVcStore,
  step: TempVcStep,
  member: VoiceMember,
  eventId: string,
): Promise<void> {
  if (step.kind === 'delete') {
    await remove(ctx, store, step.channelId, `${MODULE_ID}:${eventId}:delete:${step.channelId}`);
    return;
  }

  if (step.kind === 'move') {
    await move(ctx, step.channelId, member.userId, `${MODULE_ID}:${eventId}:move`);
    return;
  }

  const hub = step.hub;
  const created = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'create_channel',
    actorId: member.userId,
    reason: `temporary voice channel for ${member.displayName}`,
    idempotencyKey: `${MODULE_ID}:${eventId}:create`,
    dryRun: false,
    payload: {
      name: renderChannelName(hub.nameTemplate, member.displayName),
      type: VOICE_CHANNEL_TYPE,
      ...(hub.categoryId ? { parentId: hub.categoryId } : {}),
      ...(hub.userLimit > 0 ? { userLimit: hub.userLimit } : {}),
      ...(hub.bitrate === undefined ? {} : { bitrate: hub.bitrate }),
    },
  });

  if (created.status !== 'executed') {
    ctx.logger.error(
      `${member.displayName} joined the temporary-voice hub ${hub.channelId} but no channel ` +
        `could be made for them, so they were left in the hub: ${
          created.failure?.humanReason ?? `the action ended as ${created.status}`
        }`,
      {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        userId: member.userId,
        code: created.failure?.code,
      },
    );
    return;
  }

  const channelId = str(record(created.body)?.id);
  if (!channelId) {
    ctx.logger.error(
      'Discord accepted the temporary voice channel but did not say which channel it made, so ' +
        'the member could not be moved into it and Proton will not be able to clean it up.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: member.userId },
    );
    return;
  }

  await store.claim({
    guildId: ctx.guildId,
    channelId,
    ownerId: member.userId,
    hubChannelId: hub.channelId,
  });

  await move(ctx, channelId, member.userId, `${MODULE_ID}:${eventId}:move`);
}

async function move(
  ctx: ModuleContext<TempVcConfig>,
  channelId: string,
  userId: string,
  idempotencyKey: string,
): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'move_member',
    actorId: MODULE_ID,
    targetId: userId,
    reason: 'moving a member into their temporary voice channel',
    idempotencyKey,
    dryRun: false,
    payload: { userId, channelId },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.error(
      `the temporary voice channel was made but the member could not be moved into it, so they ` +
        `are still sitting in the hub: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId, channelId, code: result.failure?.code },
    );
  }
}

async function alreadyServed(
  ctx: ModuleContext<TempVcConfig>,
  store: TempVcStore,
  userId: string,
  from: string | null,
  to: string | null,
): Promise<boolean> {
  if (from === null || to === null || hubFor(ctx.config, to) === undefined) return false;

  const channel = await store.get(ctx.guildId, from);
  return channel !== null && channel.ownerId === userId && channel.hubChannelId === to;
}

export async function handleVoiceState(
  event: ProtonEvent,
  ctx: ModuleContext<TempVcConfig>,
  store: TempVcStore,
): Promise<void> {
  const member = readVoiceMember(event.payload);
  if (member === null || member.isBot) return;

  const from = await store.locate(ctx.guildId, member.userId);
  const to = member.channelId;

  if (from === to) return;

  // A redelivered hub join: the member is recorded in the channel this very join made for them, so
  // `from === to` cannot catch it and acting again would empty and delete the channel they sit in.
  if (await alreadyServed(ctx, store, member.userId, from, to)) return;

  await store.place(ctx.guildId, member.userId, to);

  let fromIsTemp = false;
  let fromOccupantsAfter = 0;

  if (from !== null) {
    fromOccupantsAfter = await store.leave(ctx.guildId, from, member.userId);
    fromIsTemp = (await store.get(ctx.guildId, from)) !== null;
  }

  if (to !== null) await store.enter(ctx.guildId, to, member.userId);

  const plan = planTransition(ctx.config, {
    transition: { userId: member.userId, from, to },
    fromIsTemp,
    fromOccupantsAfter,
    ownedChannelId: await store.ownedBy(ctx.guildId, member.userId),
  });

  for (const step of plan.steps) {
    await applyStep(ctx, store, step, member, event.id);
  }
}

export async function handleGuildAvailable(
  event: ProtonEvent,
  ctx: ModuleContext<TempVcConfig>,
  store: TempVcStore,
): Promise<void> {
  const known = await store.all(ctx.guildId);
  if (known.length === 0) return;

  const occupantsByChannel = readVoiceStates(event.payload);

  const plan = planReconcile({
    known,
    occupantsByChannel,
    liveChannelIds: readChannelIds(event.payload),
  });

  for (const entry of plan.reset) {
    await store.reset(ctx.guildId, entry.channelId, entry.userIds);
  }

  for (const entry of plan.place) {
    await store.place(ctx.guildId, entry.userId, entry.channelId);
  }

  for (const channelId of plan.forget) {
    await store.release(ctx.guildId, channelId);
  }

  for (const channelId of plan.delete) {
    await remove(ctx, store, channelId, `${MODULE_ID}:${event.id}:reconcile:${channelId}`);
  }

  if (plan.delete.length > 0 || plan.forget.length > 0) {
    ctx.logger.info(
      `reconciled temporary voice channels after reconnecting: removed ${plan.delete.length}, ` +
        `forgot ${plan.forget.length} that no longer exist`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

export function createTempVcListener(deps: TempVcDeps): EventListener<TempVcConfig> {
  return {
    types: TEMPVC_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      const bound = bindStore(deps);
      if ('unbound' in bound) {
        ctx.logger.error(describeUnbound('temporary voice channels', bound.unbound), {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
        return;
      }

      if (event.type === 'guild.available') {
        await handleGuildAvailable(event, ctx, bound.store);
        return;
      }

      await handleVoiceState(event, ctx, bound.store);
    },
  };
}
