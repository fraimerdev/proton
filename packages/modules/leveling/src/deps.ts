import type { MemberXpStore } from './store.ts';
import type { VoiceSessionStore } from './voice-session.ts';

export interface LevelingDeps {
  xp?: MemberXpStore;

  sessions?: VoiceSessionStore;

  now?: () => number;

  random?: () => number;
}

const PORT_HINTS: Record<string, string> = {
  xp: 'xp: new DrizzleMemberXpStore(db, { levelForXp, maxXp: MAX_XP })',
  sessions: 'sessions: new RedisVoiceSessionStore(redis)',
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

export function clockOf(deps: LevelingDeps): () => number {
  return deps.now ?? Date.now;
}
