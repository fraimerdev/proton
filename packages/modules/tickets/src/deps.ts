import type { GuildStateStore, Logger, ModuleContext } from '@proton/core';
import {
  type BotFacts,
  type PlaceholderEnvironment,
  type ServerFacts,
  serverFactsFrom,
  type UserFacts,
} from '@proton/core/placeholders';
import { MODULE_ID } from './config.ts';
import {
  type TicketCloseFacts,
  type TicketMessageSurface,
  type TicketPlaceholderFacts,
  type TicketSources,
  ticketSourcesFor,
} from './placeholders.ts';
import type { Ticket, TicketFormAnswer, TicketParticipant, TicketStore } from './store.ts';

export interface TicketsDeps {
  store?: TicketStore;

  applicationId?: string;

  botUserId?: string;

  guildState?: GuildStateStore;

  displayName?: (userId: string) => Promise<string | null>;

  guildName?: (guildId: string) => Promise<string | null>;

  placeholders?: PlaceholderEnvironment;

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

export interface PlaceholderReads {
  deps: TicketsDeps;
  guildId: string;
  logger: Logger;
  sources: TicketSources;
}

export function placeholderReads(
  ctx: Pick<ModuleContext<unknown>, 'guildId' | 'logger'>,
  deps: TicketsDeps,
  sources: TicketSources,
): PlaceholderReads {
  return { deps, guildId: ctx.guildId, logger: ctx.logger, sources };
}

function unread(reads: PlaceholderReads, what: string, error: unknown): void {
  reads.logger.warn(
    `a ticket placeholder was filled in without ${what}, because reading it threw: ` +
      (error instanceof Error ? error.message : String(error)),
    { guildId: reads.guildId, moduleId: MODULE_ID },
  );
}

export async function readProfile(
  reads: PlaceholderReads,
  userId: string,
  wanted: boolean,
  known?: UserFacts,
): Promise<UserFacts | null | undefined> {
  if (!wanted) return undefined;

  if (isProtonActor(userId)) {
    return { id: userId, username: null, globalName: 'Proton', avatarHash: null, bot: true };
  }

  const { deps } = reads;

  try {
    if (deps.placeholders) return await deps.placeholders.user(userId);
    if (known !== undefined) return known;
    if (!deps.displayName) return undefined;

    const name = await deps.displayName(userId);
    return name === null
      ? null
      : { id: userId, username: null, globalName: name, avatarHash: null };
  } catch (error) {
    unread(reads, `the profile of ${userId}`, error);
    return known ?? null;
  }
}

export async function readServer(reads: PlaceholderReads): Promise<ServerFacts | null> {
  if (!reads.sources.server) return null;

  const { deps, guildId } = reads;

  try {
    if (deps.placeholders) return await deps.placeholders.server(guildId);
    return deps.guildState ? serverFactsFrom(await deps.guildState.get(guildId), guildId) : null;
  } catch (error) {
    unread(reads, "the server's details", error);
    return { id: guildId };
  }
}

export async function readBot(reads: PlaceholderReads): Promise<BotFacts | null> {
  if (!reads.sources.bot || !reads.deps.placeholders) return null;

  try {
    return await reads.deps.placeholders.bot();
  } catch (error) {
    unread(reads, "Proton's own profile", error);
    return null;
  }
}

async function fromStore<T>(
  reads: PlaceholderReads,
  what: string,
  read: () => Promise<T> | undefined,
): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    unread(reads, what, error);
    return undefined;
  }
}

export interface TicketFactsInput {
  ctx: Pick<ModuleContext<unknown>, 'guildId' | 'logger'>;
  deps: TicketsDeps;
  store?: TicketStore | undefined;
  surface: TicketMessageSurface;
  template: string;
  ticket: Ticket;
  typeName: string;
  answers?: readonly TicketFormAnswer[] | undefined;
  participants?: readonly TicketParticipant[] | undefined;
  close?: TicketCloseFacts | undefined;
  actor?: { id: string; name?: string | undefined; nick?: string | null | undefined } | undefined;
}

export async function ticketFacts(input: TicketFactsInput): Promise<TicketPlaceholderFacts> {
  const { ctx, deps, store, ticket, actor } = input;
  const reads = placeholderReads(ctx, deps, ticketSourcesFor(input.surface, [input.template]));
  const { sources } = reads;

  const answers = sources.answers
    ? (input.answers ??
      (await fromStore(reads, 'the form answers', () => store?.listAnswers(ticket.id))))
    : undefined;

  const participants = sources.participants
    ? (input.participants ??
      (await fromStore(reads, 'who is in the ticket', () => store?.listParticipants(ticket.id))))
    : undefined;

  const known: UserFacts | undefined =
    actor === undefined || actor.name === undefined
      ? undefined
      : { id: actor.id, username: null, globalName: actor.name, avatarHash: null };

  return {
    ticket,
    typeName: input.typeName,
    ownerId: ticket.ownerId,
    owner: await readProfile(reads, ticket.ownerId, sources.owner),
    answers,
    participantCount: participants?.length,
    close: input.close,
    actorId: actor?.id,
    actor:
      actor === undefined ? undefined : await readProfile(reads, actor.id, sources.actor, known),
    actorMember: actor === undefined || actor.nick === undefined ? undefined : { nick: actor.nick },
    server: await readServer(reads),
    bot: await readBot(reads),
  };
}
