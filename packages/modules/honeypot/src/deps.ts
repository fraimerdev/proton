import type { BlockedMemberStore, GuildState, GuildStateStore, ModuleContext } from '@proton/core';
import {
  type BotFacts,
  type PlaceholderEnvironment,
  PROTON_SUPPORT_URL,
} from '@proton/core/placeholders';
import { type HoneypotConfig, MODULE_ID } from './config.ts';
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

  placeholders?: PlaceholderEnvironment;

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

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function placeholderClock(deps: HoneypotDeps): number {
  return deps.placeholders?.now() ?? deps.now?.() ?? Date.now();
}

export async function readGuildState(
  ctx: ModuleContext<HoneypotConfig>,
  deps: HoneypotDeps,
): Promise<GuildState | null> {
  if (!deps.guildState) return null;

  try {
    return await deps.guildState.get(ctx.guildId);
  } catch (error) {
    ctx.logger.warn(
      "honeypot could not read this server's cached details, so its server and channel " +
        `placeholders have no value: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return null;
  }
}

export async function readBotFacts(
  ctx: ModuleContext<HoneypotConfig>,
  deps: HoneypotDeps,
): Promise<BotFacts | null> {
  if (!deps.placeholders) return null;

  try {
    return await deps.placeholders.bot();
  } catch (error) {
    ctx.logger.warn(
      'Proton could not read its own profile, so its name and avatar render as nothing in this ' +
        `honeypot message: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return { id: deps.placeholders.applicationId, name: null, supportUrl: PROTON_SUPPORT_URL };
  }
}
