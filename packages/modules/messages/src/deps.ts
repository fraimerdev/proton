import type { GuildState, GuildStateStore, Logger } from '@proton/core';
import {
  type BotFacts,
  type ChannelFacts,
  type PlaceholderEnvironment,
  type ServerFacts,
  serverFactsFrom,
} from '@proton/core/placeholders';

export interface MessagesDeps {
  applicationId?: string;
  placeholders?: PlaceholderEnvironment;
  guildState?: Pick<GuildStateStore, 'get'>;
}

export interface BoundFollowUpDeps {
  applicationId: string;
}

export type BindResult<T> = { deps: T } | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  applicationId: "applicationId: the application's own id, from READY",
};

export function bindFollowUp(deps: MessagesDeps): BindResult<BoundFollowUpDeps> {
  return deps.applicationId
    ? { deps: { applicationId: deps.applicationId } }
    : { unbound: ['applicationId'] };
}

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `${what} — the messages module was built without ${unbound.join(', ')}. The process running ` +
    `modules must call createMessagesModule({ ${unbound
      .map((port) => PORT_HINTS[port] ?? port)
      .join(', ')} }).`
  );
}

export interface PlaceholderSources {
  server: ServerFacts;
  bot: BotFacts | null;
  destinationChannel: ChannelFacts | null;
}

export type ReadFailure = (what: string, error: unknown) => void;

export function logReadFailure(
  logger: Logger,
  subject: string,
  meta: Record<string, unknown>,
): ReadFailure {
  return (what, error) => {
    logger.warn(
      `${what} could not be read for ${subject}, so the placeholders that need it are empty: ` +
        (error instanceof Error ? error.message : String(error)),
      meta,
    );
  };
}

const CHANNEL_KEYS = ['destination_channel.name', 'destination_channel.category_mention'];

function usesNamespace(keys: ReadonlySet<string>, namespace: string): boolean {
  for (const key of keys) if (key.startsWith(`${namespace}.`)) return true;
  return false;
}

async function attempt<T>(
  read: () => Promise<T>,
  fallback: T,
  what: string,
  failed: ReadFailure | undefined,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (failed === undefined) throw error;
    failed(what, error);
    return fallback;
  }
}

function channelFacts(state: GuildState | null, channelId: string): ChannelFacts {
  const known = state?.channels.get(channelId);
  if (known === undefined) return { id: channelId };

  return { id: channelId, name: known.name, type: known.type, parentId: known.parentId };
}

export async function readPlaceholderSources(
  deps: MessagesDeps,
  guildId: string,
  channelId: string | null,
  keys: ReadonlySet<string>,
  failed?: ReadFailure,
): Promise<PlaceholderSources> {
  const { placeholders, guildState } = deps;
  const bare: ServerFacts = { id: guildId };
  const channel: ChannelFacts | null = channelId === null ? null : { id: channelId };
  const wantsServer = usesNamespace(keys, 'server');
  const wantsChannel = CHANNEL_KEYS.some((key) => keys.has(key));
  const bot =
    placeholders !== undefined && usesNamespace(keys, 'bot')
      ? attempt(() => placeholders.bot(), null, "Proton's own profile", failed)
      : null;

  if (
    placeholders !== undefined &&
    wantsServer &&
    guildState !== undefined &&
    channel !== null &&
    wantsChannel
  ) {
    const [state, botFacts] = await Promise.all([
      attempt(() => guildState.get(guildId), null, "this server's details", failed),
      bot,
    ]);

    return {
      server: serverFactsFrom(state, guildId),
      bot: botFacts,
      destinationChannel: channelFacts(state, channel.id),
    };
  }

  const [server, botFacts, destinationChannel] = await Promise.all([
    placeholders !== undefined && wantsServer
      ? attempt(() => placeholders.server(guildId), bare, "this server's details", failed)
      : bare,
    bot,
    guildState !== undefined && channel !== null && wantsChannel
      ? attempt(
          async () => channelFacts(await guildState.get(guildId), channel.id),
          channel,
          'the channel it posts in',
          failed,
        )
      : channel,
  ]);

  return { server, bot: botFacts, destinationChannel };
}
