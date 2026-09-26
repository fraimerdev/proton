import type { BadgeCard } from '@proton/cards';
import type { AchievementRetryOutcome, BlockedMemberStore, GuildState } from '@proton/core';
import type { PlaceholderEnvironment } from '@proton/core/placeholders';
import type { AchievementStore } from './store.ts';
import type { AchievementVoiceStore } from './voice-store.ts';

export interface FencedLocks {
  acquire(key: string, ttlMs: number): Promise<string | null>;
  release(key: string, token: string): Promise<boolean>;
}

export interface AchievementLimits {
  claim(key: string, value: string, ttlMs: number): Promise<boolean>;
  release(key: string, value: string): Promise<boolean>;
  count(key: string, ttlMs: number): Promise<number>;
}

export interface MemberLookup {
  roleIds: string[];
  bot: boolean;
  joinedAt: number | null;
  premiumSince: number | null;
}

export interface ListedMember {
  userId: string;
  bot: boolean;
  joinedAt: number | null;
}

export interface LevelHolder {
  userId: string;
  level: number;
}

export type ChannelKind = 'ticket' | 'temporary';

export interface AchievementsDeps {
  store?: AchievementStore;
  voice?: AchievementVoiceStore;
  locks?: FencedLocks;
  limits?: AchievementLimits;
  guildState?: { get(guildId: string): Promise<GuildState | null> };
  placeholders?: PlaceholderEnvironment;
  availability?: { isEnabled(guildId: string, moduleId: string): Promise<boolean> };
  memberFacts?: (guildId: string, userId: string) => Promise<MemberLookup | null>;
  listMembers?: (
    guildId: string,
    afterUserId: string | null,
    limit: number,
  ) => Promise<ListedMember[]>;
  levelOf?: (guildId: string, userId: string) => Promise<number | null>;
  levelHolders?: (
    guildId: string,
    minLevel: number,
    afterUserId: string | null,
    limit: number,
  ) => Promise<LevelHolder[]>;
  channelKind?: (guildId: string, channelId: string) => Promise<ChannelKind | null>;
  blocked?: Pick<BlockedMemberStore, 'find'>;
  renderBadge?: (card: BadgeCard) => Promise<Uint8Array | null>;
  mailbox?: { answer(id: string, value: AchievementRetryOutcome): Promise<void> };
  applicationId?: string;
  botUserId?: string;
  now?: () => number;
}

export const PORT_HINTS: Readonly<Record<string, string>> = {
  store: 'store: new DrizzleAchievementStore(db)',
  voice: 'voice: new RedisAchievementVoiceStore(moduleRedis)',
  locks: 'locks: new RedisFencedLocks(moduleRedis)',
  limits: 'limits: new RedisLimits(moduleRedis)',
  guildState: 'guildState: new RedisGuildStateStore(redis)',
  availability: 'availability: { isEnabled: (guildId, moduleId) => ... }',
  memberFacts: 'memberFacts: (guildId, userId) => ... (REST member lookup)',
  listMembers: 'listMembers: (guildId, after, limit) => ... (REST member pages)',
  levelOf: 'levelOf: (guildId, userId) => ... (Leveling store)',
  levelHolders: 'levelHolders: (guildId, minLevel, after, limit) => ... (Leveling store)',
  mailbox:
    'mailbox: new RedisMailbox(busRedis, { prefix: ACHIEVEMENT_RETRY_MAILBOX_PREFIX, ' +
    'schema: achievementRetryOutcomeSchema })',
  applicationId: 'applicationId: env.DISCORD_APPLICATION_ID',
};

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `Achievements is enabled in this server but ${what} is NOT running: the module was built ` +
    `without ${unbound.join(', ')}. The process running modules must call ` +
    `createAchievementsModule({ ${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

export type StoreBinding = { store: AchievementStore } | { unbound: string[] };

export function bindStore(deps: AchievementsDeps): StoreBinding {
  return deps.store ? { store: deps.store } : { unbound: ['store'] };
}

export type VoiceBinding =
  | { store: AchievementStore; voice: AchievementVoiceStore; locks: FencedLocks }
  | { unbound: string[] };

export function bindVoice(deps: AchievementsDeps): VoiceBinding {
  const unbound: string[] = [];
  if (!deps.store) unbound.push('store');
  if (!deps.voice) unbound.push('voice');
  if (!deps.locks) unbound.push('locks');

  if (!deps.store || !deps.voice || !deps.locks) return { unbound };
  return { store: deps.store, voice: deps.voice, locks: deps.locks };
}

export type LimitsBinding = { limits: AchievementLimits } | { unbound: string[] };

export function bindLimits(deps: AchievementsDeps): LimitsBinding {
  return deps.limits ? { limits: deps.limits } : { unbound: ['limits'] };
}

export type RetryBinding =
  | {
      store: AchievementStore;
      mailbox: { answer(id: string, value: AchievementRetryOutcome): Promise<void> };
    }
  | { unbound: string[] };

export function bindRetry(deps: AchievementsDeps): RetryBinding {
  const unbound: string[] = [];
  if (!deps.store) unbound.push('store');
  if (!deps.mailbox) unbound.push('mailbox');

  if (!deps.store || !deps.mailbox) return { unbound };
  return { store: deps.store, mailbox: deps.mailbox };
}

export type CommandBinding =
  | { store: AchievementStore; applicationId: string }
  | { unbound: string[] };

export function bindCommands(deps: AchievementsDeps): CommandBinding {
  const unbound: string[] = [];
  if (!deps.store) unbound.push('store');
  if (!deps.applicationId) unbound.push('applicationId');

  if (!deps.store || !deps.applicationId) return { unbound };
  return { store: deps.store, applicationId: deps.applicationId };
}

export function clockOf(deps: AchievementsDeps): () => number {
  return deps.now ?? Date.now;
}
