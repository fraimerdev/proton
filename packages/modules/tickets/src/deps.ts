import type { GuildStateStore } from '@proton/core';
import type { TicketStore } from './store.ts';

export interface TicketsDeps {
  store?: TicketStore;

  applicationId?: string;

  botUserId?: string;

  guildState?: GuildStateStore;

  displayName?: (userId: string) => Promise<string | null>;

  guildName?: (guildId: string) => Promise<string | null>;

  // Injected so a cooldown measured against a stored timestamp and the stored timestamp itself
  // come from the same clock. Production leaves it unbound and gets the wall clock.
  now?: () => Date;
}

export function clockOf(deps: TicketsDeps): Date {
  return deps.now?.() ?? new Date();
}

const PORT_HINTS: Record<string, string> = {
  store: 'store: new DrizzleTicketStore(db)',
  applicationId: 'applicationId: env.DISCORD_APPLICATION_ID',
  botUserId: 'botUserId: env.DISCORD_APPLICATION_ID',
  guildState: 'guildState: new RedisGuildStateStore(redis)',
  displayName: 'displayName: async (id) => (await users.resolve(id))?.username ?? null',
};

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `Tickets is enabled in this server but ${what} is NOT running: the module was built without ` +
    `${unbound.join(', ')}. The process running modules must call createTicketsModule({ ` +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

export type StoreBinding = { store: TicketStore } | { unbound: string[] };

export function bindStore(deps: TicketsDeps): StoreBinding {
  return deps.store ? { store: deps.store } : { unbound: ['store'] };
}

export type ButtonBinding = { store: TicketStore; applicationId: string } | { unbound: string[] };

export function bindButton(deps: TicketsDeps): ButtonBinding {
  const unbound: string[] = [];
  if (!deps.store) unbound.push('store');
  if (!deps.applicationId) unbound.push('applicationId');

  if (!deps.store || !deps.applicationId) return { unbound };
  return { store: deps.store, applicationId: deps.applicationId };
}

// The actor recorded when a timer, not a person, did something. The core resolver already treats a
// 'proton:' prefix as a pseudo actor, so this stays readable everywhere a real user id would go.
export const PROTON_ACTOR = 'proton:tickets';

export function isProtonActor(actorId: string | null | undefined): boolean {
  return typeof actorId === 'string' && actorId.startsWith('proton:');
}

// A pseudo actor is not a snowflake, so <@proton:tickets> renders as literal text in Discord.
export function mentionOf(actorId: string | null | undefined): string {
  if (!actorId) return 'somebody';
  return isProtonActor(actorId) ? 'Proton' : `<@${actorId}>`;
}

export async function nameOf(deps: TicketsDeps, userId: string): Promise<string> {
  if (isProtonActor(userId)) return 'Proton';

  const resolved = await deps.displayName?.(userId).catch(() => null);
  return resolved ?? userId;
}

export async function namesOf(
  deps: TicketsDeps,
  userIds: Iterable<string>,
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];

  const pairs = await Promise.all(unique.map(async (id) => [id, await nameOf(deps, id)] as const));

  return new Map(pairs);
}
