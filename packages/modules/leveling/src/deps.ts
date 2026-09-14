import type { CardDeps, CardDescriptorInput } from '@proton/cards';
import type { GuildState } from '@proton/core';
import type { PlaceholderEnvironment } from '@proton/core/placeholders';
import type { ActivityStore } from './activity.ts';
import type { MemberXpStore } from './store.ts';
import type { VoiceSessionStore } from './voice-session.ts';
import type { XpEventStore } from './xp-events.ts';

export interface LevelingDeps {
  xp?: MemberXpStore;

  // Unbound means leveling registers no providers at all: a requirement nobody can ever satisfy
  // should not appear in the picker, and listAvailable is what keeps it out.
  activity?: ActivityStore;

  sessions?: VoiceSessionStore;

  guildState?: { get(guildId: string): Promise<GuildState | null> };

  xpEvents?: XpEventStore;

  applicationId?: string;

  now?: () => number;

  random?: () => number;
  cards?: CardDeps;
  renderCard?: (input: CardDescriptorInput, deps: CardDeps) => Promise<Uint8Array>;
  userProfile?: (
    userId: string,
  ) => Promise<{ displayName: string; avatarHash: string | null } | null>;
  placeholders?: PlaceholderEnvironment;
}

const PORT_HINTS: Record<string, string> = {
  xp: 'xp: new DrizzleMemberXpStore(db, { levelForXp, maxXp: MAX_XP })',
  activity: 'activity: new DrizzleActivityStore(db, { levelForXp })',
  sessions: 'sessions: new RedisVoiceSessionStore(redis)',
  guildState: 'guildState: new RedisGuildStateStore(redis)',
  xpEvents: 'xpEvents: new CachedXpEventStore(new DrizzleXpEventStore(db))',
  applicationId: 'applicationId: env.DISCORD_APPLICATION_ID',
};

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `Leveling is enabled in this server but ${what} is NOT running: the module was built ` +
    `without ${unbound.join(', ')}. The process running modules must call ` +
    `createLevelingModule({ ${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

export type XpBinding = { xp: MemberXpStore } | { unbound: string[] };

export function bindXp(deps: LevelingDeps): XpBinding {
  return deps.xp ? { xp: deps.xp } : { unbound: ['xp'] };
}

export type VoiceBinding =
  | { xp: MemberXpStore; sessions: VoiceSessionStore }
  | { unbound: string[] };

export function bindVoice(deps: LevelingDeps): VoiceBinding {
  const unbound: string[] = [];
  if (!deps.xp) unbound.push('xp');
  if (!deps.sessions) unbound.push('sessions');

  if (!deps.xp || !deps.sessions) return { unbound };
  return { xp: deps.xp, sessions: deps.sessions };
}

export type XpEventBinding =
  | { xpEvents: XpEventStore; applicationId: string }
  | { unbound: string[] };

export function bindXpEvents(deps: LevelingDeps): XpEventBinding {
  const unbound: string[] = [];
  if (!deps.xpEvents) unbound.push('xpEvents');
  if (!deps.applicationId) unbound.push('applicationId');

  if (!deps.xpEvents || !deps.applicationId) return { unbound };
  return { xpEvents: deps.xpEvents, applicationId: deps.applicationId };
}

export function clockOf(deps: LevelingDeps): () => number {
  return deps.now ?? Date.now;
}
