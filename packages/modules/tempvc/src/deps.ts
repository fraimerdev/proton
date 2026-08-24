import type { GuildStateStore, PermissionOverwriteSpec } from '@proton/core';
import type { TempVoiceRepository } from './repository.ts';
import type { CooldownGate } from './service.ts';
import { TemporaryVoiceService } from './service.ts';
import type { PresenceStore } from './store.ts';
import { type Presence, presenceOf } from './voice.ts';

export interface TempVcDeps {
  /** Authoritative ownership, access and granted roles. */
  repository?: TempVoiceRepository;

  /** Where members are, cached. Rebuilt by reconcile, so losing it is survivable. */
  presence?: PresenceStore;

  guildState?: GuildStateStore;

  cooldown?: CooldownGate;

  botUserId?: string;

  now?(): Date;
}

const PORT_HINTS: Record<string, string> = {
  repository: 'repository: new DrizzleTempVoiceRepository(db)',
  presence: 'presence: new RedisPresenceStore(redis)',
  botUserId: 'botUserId: env.DISCORD_APPLICATION_ID',
};

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `Temporary voice channels are enabled in this server but ${what} is NOT running: the module ` +
    `was built without ${unbound.join(', ')}. The process running modules must call ` +
    `createTempVcModule({ ${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

export interface BoundService {
  service: TemporaryVoiceService;
  repository: TempVoiceRepository;
  presence: Presence;
  store: PresenceStore;
}

export type ServiceBinding = BoundService | { unbound: string[] };

export function bindService(deps: TempVcDeps): ServiceBinding {
  const unbound: string[] = [];
  if (!deps.repository) unbound.push('repository');
  if (!deps.presence) unbound.push('presence');
  if (!deps.botUserId) unbound.push('botUserId');

  if (unbound.length > 0 || !deps.repository || !deps.presence || !deps.botUserId) {
    return { unbound };
  }

  const repository = deps.repository;
  const presence = deps.presence;
  const guildState = deps.guildState;

  const service = new TemporaryVoiceService(
    {
      repository,
      botUserId: deps.botUserId,
      ...(deps.now ? { now: deps.now } : {}),

      // Read from the cached guild state rather than fetched: permission sync runs on every
      // creation, and a REST round trip per join is the kind of thing that eats a rate limit.
      async overwritesOf(guildId, channelId): Promise<PermissionOverwriteSpec[] | null> {
        const state = await guildState?.get(guildId);
        const channel = state?.channels.get(channelId);
        if (!channel) return null;

        return channel.overwrites.map((entry) => ({
          id: entry.id,
          type: entry.type,
          allow: entry.allow.toString(),
          deny: entry.deny.toString(),
        }));
      },
    },
    deps.cooldown,
  );

  return { service, repository, presence: presenceOf(presence), store: presence };
}
