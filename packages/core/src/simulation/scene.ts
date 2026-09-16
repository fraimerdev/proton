import type { MemberFacts, UserFacts } from '../placeholders/shared/facts.ts';
import type { SimulationPerson } from './types.ts';

export function displayNameOf(user: UserFacts, member: MemberFacts | 'unavailable'): string {
  const nick = member === 'unavailable' ? null : (member.nick ?? null);
  return nick ?? user.globalName ?? user.username ?? 'Member';
}

export function personFor(user: UserFacts, member: MemberFacts | 'unavailable'): SimulationPerson {
  return { user, member, displayName: displayNameOf(user, member) };
}

/**
 * A leave simulation without the example member leaving: the surface refuses every member-only
 * key exactly as it does on a real departure, because the facts say the member is gone while the
 * account behind them is still readable.
 */
export function unavailableMember(person: SimulationPerson): SimulationPerson {
  return { ...person, member: 'unavailable' };
}
