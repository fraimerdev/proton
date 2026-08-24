import type { EventListener, EventType, ModuleContext, ProtonEvent } from '@proton/core';
import { armPatrol } from './cleanup.ts';
import { hubFor, MODULE_ID, type TempVcConfig, type TempVcHub } from './config.ts';
import { planReconcile, planTransition, type TempSide, type TempVcStep } from './decide.ts';
import { bindService, describeUnbound, type TempVcDeps } from './deps.ts';
import type { TempVoiceRepository } from './repository.ts';
import type { TemporaryVoiceService } from './service.ts';
import type { PresenceStore } from './store.ts';
import type { TempVoiceChannelRow } from './table.ts';

/** The slice of the presence cache a transition needs, so tests can hand in a plain object. */
export interface Presence {
  locate(guildId: string, userId: string): Promise<string | null>;
  place(guildId: string, userId: string, channelId: string | null): Promise<void>;
  enter(guildId: string, channelId: string, userId: string): Promise<number>;
  leaveAndList(guildId: string, channelId: string, userId: string): Promise<string[]>;
}

export function presenceOf(store: PresenceStore): Presence {
  return {
    locate: (guildId, userId) => store.locate(guildId, userId),
    place: (guildId, userId, channelId) => store.place(guildId, userId, channelId),
    enter: (guildId, channelId, userId) => store.enter(guildId, channelId, userId),

    async leaveAndList(guildId, channelId, userId) {
      await store.leave(guildId, channelId, userId);
      return store.occupants(guildId, channelId);
    },
  };
}

export const TEMPVC_EVENT_TYPES: EventType[] = [
  'voice.state_updated',
  'guild.available',
  'entity.channel_deleted',
];

/** Reservations older than this never became a channel and never will. */
export const STALE_RESERVATION_MS = 60_000;

export interface VoiceMember {
  userId: string;
  channelId: string | null;
  displayName: string;
  username: string;
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
  const username = str(user?.username) ?? `member ${userId}`;

  return {
    userId,
    channelId: str(raw.channel_id),
    displayName: str(member?.nick) ?? str(user?.global_name) ?? username,
    username,
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

function sideOf(row: TempVoiceChannelRow | null): TempSide | null {
  return row === null ? null : { id: row.id, ownerId: row.ownerId, hubChannelId: row.hubChannelId };
}

async function applyStep(
  ctx: ModuleContext<TempVcConfig>,
  service: TemporaryVoiceService,
  repo: TempVoiceRepository,
  step: TempVcStep,
  member: VoiceMember,
  deps: TempVcDeps,
): Promise<void> {
  switch (step.kind) {
    case 'create': {
      const outcome = await service.create(ctx, step.hub, member);

      // The guild now has something worth patrolling, and the patrol stops itself once it does not.
      if ('created' in outcome) await armPatrol(ctx, deps);

      if ('refused' in outcome && outcome.refused !== 'moved_existing') {
        ctx.logger.warn(
          `no temporary voice channel was made for ${member.displayName}: ${outcome.detail}`,
          { guildId: ctx.guildId, moduleId: MODULE_ID, userId: member.userId },
        );
      }
      return;
    }

    case 'move':
      await service.move(ctx, member.userId, step.channelId);
      return;

    case 'schedule-delete': {
      const row = await repo.byId(step.rowId);
      if (!row) return;

      const hub = hubOf(ctx.config, row.hubChannelId);
      if (hub) await service.scheduleDelete(ctx, hub, row);
      return;
    }

    case 'cancel-delete':
      await repo.cancelDelete(step.rowId);
      return;

    case 'revoke-roles':
      await service.revokeRoles(ctx, step.rowId, member.userId);
      return;

    case 'grant-role': {
      const hub = hubOf(ctx.config, step.hubChannelId);
      if (hub) await service.grantRole(ctx, hub, step.rowId, member.userId, step.isOwner);
      return;
    }

    case 'ownerless': {
      const row = await repo.byId(step.rowId);
      if (!row) return;

      // 'keep' leaves the owner in place so nobody else inherits their controls; 'claim' clears
      // the owner so the Claim button becomes available; 'transfer' hands it straight over.
      if (step.mode === 'keep') return;

      if (step.mode === 'claim') {
        await repo.setOwner(step.rowId, null);
        return;
      }

      if (step.heir !== null) {
        const hub = hubOf(ctx.config, row.hubChannelId);
        await service.transfer(ctx, row, step.heir, hub?.privacy ?? 'public');
      }
      return;
    }
  }
}

function hubOf(config: TempVcConfig, hubChannelId: string): TempVcHub | undefined {
  return config.hubs.find((entry) => entry.channelId === hubChannelId);
}

export async function handleVoiceState(
  event: ProtonEvent,
  ctx: ModuleContext<TempVcConfig>,
  service: TemporaryVoiceService,
  repo: TempVoiceRepository,
  presence: Presence,
  deps: TempVcDeps,
): Promise<void> {
  const member = readVoiceMember(event.payload);
  if (member === null || member.isBot) return;

  // The payload says where they are now and nothing about where they were, so the channel they
  // left comes from the presence cache. Read before it is rewritten, or every leave looks like a
  // member who came from nowhere and their old channel is never emptied.
  const to = member.channelId;
  const from = await presence.locate(ctx.guildId, member.userId);

  if (from === to) return;

  const fromRow = from === null ? null : await repo.byChannel(ctx.guildId, from);
  const toRow = to === null ? null : await repo.byChannel(ctx.guildId, to);

  // Occupancy is moved before the plan is made, so `fromOccupantsAfter` means what it says.
  const remaining =
    from === null ? [] : await presence.leaveAndList(ctx.guildId, from, member.userId);
  if (to !== null) await presence.enter(ctx.guildId, to, member.userId);
  await presence.place(ctx.guildId, member.userId, to);

  const owned = await repo.ownedBy(ctx.guildId, member.userId);

  const plan = planTransition(ctx.config, {
    transition: { userId: member.userId, from, to },
    fromTemp: sideOf(fromRow),
    fromOccupantsAfter: remaining.length,
    fromOccupants: remaining,
    toTemp: sideOf(toRow),
    ownedChannelId: owned[0]?.channelId ?? null,
  });

  for (const step of plan.steps) {
    await applyStep(ctx, service, repo, step, member, deps);
  }
}

/**
 * A channel somebody deleted by hand in Discord. Without this the row survives, its owner's slot
 * stays occupied, and they can never get another temporary channel.
 */
export async function handleChannelDeleted(
  event: ProtonEvent,
  ctx: ModuleContext<TempVcConfig>,
  repo: TempVoiceRepository,
): Promise<void> {
  const channelId = str(record(event.payload)?.id);
  if (!channelId) return;

  const row = await repo.byChannel(ctx.guildId, channelId);
  if (!row) return;

  await repo.forget(row.id);

  ctx.logger.info('a temporary voice channel was deleted in Discord, so Proton forgot it', {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    channelId,
  });
}

export async function handleGuildAvailable(
  event: ProtonEvent,
  ctx: ModuleContext<TempVcConfig>,
  service: TemporaryVoiceService,
  repo: TempVoiceRepository,
  deps: TempVcDeps,
  now: () => Date = () => new Date(),
): Promise<void> {
  const known = await repo.liveIn(ctx.guildId);
  if (known.length === 0) return;

  // A reconnect is also where the rolling patrol is started, so a guild whose worker restarted
  // begins reconciling again without waiting for somebody to join a creator channel.
  await armPatrol(ctx, deps, now());

  const byId = new Map(known.map((row) => [row.id, row]));

  const plan = planReconcile({
    known: known.map((row) => ({ id: row.id, channelId: row.channelId, status: row.status })),
    occupantsByChannel: readVoiceStates(event.payload),
    liveChannelIds: readChannelIds(event.payload),
    staleBefore: new Date(now().getTime() - STALE_RESERVATION_MS),
    rowCreatedAt: (row) => byId.get(row.id)?.createdAt ?? new Date(0),
  });

  for (const rowId of plan.keep) await repo.cancelDelete(rowId);
  for (const rowId of plan.forget) await repo.forget(rowId);

  for (const rowId of plan.delete) {
    const row = byId.get(rowId);
    if (row) await service.destroy(ctx, row, 'empty when Proton reconnected');
  }

  if (plan.delete.length > 0 || plan.forget.length > 0) {
    ctx.logger.info(
      `reconciled temporary voice channels: removed ${plan.delete.length}, forgot ` +
        `${plan.forget.length} that no longer exist`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

export function createTempVcListener(deps: TempVcDeps): EventListener<TempVcConfig> {
  return {
    types: TEMPVC_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      const bound = bindService(deps);
      if ('unbound' in bound) {
        ctx.logger.error(describeUnbound('temporary voice channels', bound.unbound), {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
        return;
      }

      const { service, repository, presence } = bound;

      if (event.type === 'guild.available') {
        await handleGuildAvailable(event, ctx, service, repository, deps);
        return;
      }

      if (event.type === 'entity.channel_deleted') {
        await handleChannelDeleted(event, ctx, repository);
        return;
      }

      await handleVoiceState(event, ctx, service, repository, presence, deps);
    },
  };
}

export { hubFor };
