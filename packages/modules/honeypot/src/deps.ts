import type { BlockedMemberStore, GuildStateStore } from '@proton/core';
import type {
  DmChannelStore,
  HoneypotLock,
  HoneypotPendingStore,
  HoneypotStatsStore,
  NoticeStore,
} from './store.ts';

export interface HoneypotDeps {
  lock?: HoneypotLock;

  botUserId?: string;

  guildState?: GuildStateStore;

  notices?: NoticeStore;

  stats?: HoneypotStatsStore;

  blocked?: BlockedMemberStore;

  pending?: HoneypotPendingStore;

  dms?: DmChannelStore;

  guildName?(guildId: string): Promise<string>;

  linkSecret?: string;

  linkBaseUrl?: string;

  now?(): number;
}

export interface BoundHoneypotDeps {
  lock: HoneypotLock;
  botUserId: string;
  now(): number;
}

export type BindResult<T> = { deps: T } | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  lock: 'lock: new RedisHoneypotLock(redis)',
  botUserId: "botUserId: the application's own id, from READY",
  guildState: 'guildState: new RedisGuildStateStore(redis)',
  notices: 'notices: new RedisNoticeStore(redis)',
  stats: 'stats: new RedisHoneypotStatsStore(redis)',
  blocked: 'blocked: new DrizzleBlockedMemberStore(handle)',
  pending: 'pending: new RedisHoneypotPendingStore(redis)',
  dms: 'dms: new RedisDmChannelStore(redis)',
  linkSecret: 'linkSecret: env.VERIFY_LINK_SECRET',
  linkBaseUrl: 'linkBaseUrl: env.DASHBOARD_URL',
};

export function bindHoneypotDeps(deps: HoneypotDeps): BindResult<BoundHoneypotDeps> {
  const { lock, botUserId } = deps;

  const unbound: string[] = [];
  if (!lock) unbound.push('lock');
  if (!botUserId) unbound.push('botUserId');

  if (!lock || !botUserId) return { unbound };

  return { deps: { lock, botUserId, now: deps.now ?? (() => Date.now()) } };
}

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `${what} — the honeypot module was built without ${unbound.join(', ')}. ` +
    'The process running modules must call createHoneypotModule({ ' +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
