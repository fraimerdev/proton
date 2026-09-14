import type { CardDeps, CardDescriptorInput } from '@proton/cards';
import { discordAvatarUrl, renderCard, toHexColour } from '@proton/cards';
import {
  type ActionResult,
  type Attachment,
  type CustomIdFor,
  type EventListener,
  type EventType,
  type Logger,
  type ModuleContext,
  type ProtonEvent,
  toDiscordMessage,
} from '@proton/core';
import {
  type BotFacts,
  type ChannelFacts,
  type MemberFacts,
  type MessageRender,
  type PlaceholderEnvironment,
  type PlaceholderSurface,
  PROTON_SUPPORT_URL,
  type ServerFacts,
  serverFactsFrom,
  type UserFacts,
  usedKeys,
} from '@proton/core/placeholders';
import { MessageType } from 'discord-api-types/v10';
import {
  type GreetingFacts,
  type GreetingMessage,
  isSilentGreeting,
  type WelcomeConfig,
} from './config.ts';
import {
  type GreetingOccasion,
  type GreetingPlaceholderFacts,
  greetingTemplates,
  renderGreetingMessage,
  WELCOME_BOOST_SURFACE,
  WELCOME_JOIN_SURFACE,
  WELCOME_LEAVE_SURFACE,
} from './placeholders.ts';

export const WELCOME_MODULE_ID = 'welcome';

export const WELCOME_ACTOR = 'proton:welcome';

export const WELCOME_EVENT_TYPES: EventType[] = ['member.joined', 'member.left'];

export const BOOST_EVENT_TYPES: EventType[] = ['message.created'];

export const BOOST_MESSAGE_TYPES: ReadonlySet<number> = new Set([
  MessageType.GuildBoost,
  MessageType.GuildBoostTier1,
  MessageType.GuildBoostTier2,
  MessageType.GuildBoostTier3,
]);

// Only a link button survives greetingMessageSchema, and link buttons never ask for a custom_id,
// so reaching this means the config was written around the dashboard.
const NO_CUSTOM_IDS: CustomIdFor = () => {
  throw new Error(
    'a welcome, goodbye or boost message carried a component, and the welcome module has no ' +
      'interaction listener to answer a press on it. Remove the component rows from the welcome ' +
      'module config.',
  );
};

export interface WelcomeDeps {
  cards?: CardDeps;

  render?: (input: CardDescriptorInput, deps: CardDeps) => Promise<Uint8Array>;
  guildState?: { get(guildId: string): Promise<GuildSummary | null> };
  placeholders?: PlaceholderEnvironment;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function nullableText(value: unknown, key: string): string | null | undefined {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined;

  const held: unknown = Reflect.get(value, key);
  if (typeof held === 'string') return held;
  return held === null ? null : undefined;
}

export interface GreetingTarget extends GreetingFacts {
  avatarHash: string | null;
}

export interface GuildChannelSummary {
  type?: number | undefined;
  name?: string | undefined;
  parentId?: string | null | undefined;
}

export interface GuildSummary {
  name?: string | undefined;
  memberCount?: number | undefined;
  ownerId?: string | undefined;
  everyoneRoleId?: string | undefined;
  roles?: ReadonlyMap<string, unknown> | undefined;
  channels?: ReadonlyMap<string, GuildChannelSummary> | undefined;
  iconHash?: string | null | undefined;
  bannerHash?: string | null | undefined;
  description?: string | null | undefined;
  boostCount?: number | null | undefined;
  boostTier?: number | undefined;
}

// Both stay optional on purpose: the member events do not carry them, and a required field would
// render the string "undefined" into a greeting whenever the guild-state cache misses.
export function readGreetingTarget(
  payload: unknown,
  guild: GuildSummary = {},
): GreetingTarget | null {
  const user = nested(payload, 'user');
  const userId = str(nested(user, 'id'));
  if (!userId) return null;

  const username = str(nested(user, 'global_name')) ?? str(nested(user, 'username')) ?? 'someone';

  return {
    userId,
    username,
    guildName: guild.name ?? 'this server',
    memberCount: guild.memberCount ?? 0,
    avatarHash: str(nested(user, 'avatar')),
  };
}

export function isBoostNotice(payload: unknown): boolean {
  const type = nested(payload, 'type');
  return typeof type === 'number' && BOOST_MESSAGE_TYPES.has(type);
}

export function readBoosterTarget(
  payload: unknown,
  guild: GuildSummary = {},
): GreetingTarget | null {
  const target = readGreetingTarget({ user: nested(payload, 'author') }, guild);
  const nick = str(nested(nested(payload, 'member'), 'nick'));

  return target && nick ? { ...target, username: nick } : target;
}

export interface GreetingPayloadFacts {
  user: UserFacts;
  member: MemberFacts | 'unavailable';
  channelId: string | null;
}

function readUserFacts(user: unknown): UserFacts | null {
  const id = str(nested(user, 'id'));
  if (!id) return null;

  return {
    id,
    username: str(nested(user, 'username')),
    globalName: str(nested(user, 'global_name')),
    avatarHash: str(nested(user, 'avatar')),
    bot: nested(user, 'bot') === true,
  };
}

function readMemberFacts(member: unknown): MemberFacts {
  const roles = nested(member, 'roles');

  return {
    nick: nullableText(member, 'nick'),
    joinedAt: nullableText(member, 'joined_at'),
    premiumSince: nullableText(member, 'premium_since'),
    roleIds: Array.isArray(roles)
      ? roles.filter((role): role is string => typeof role === 'string')
      : undefined,
  };
}

export function readGreetingFacts(
  event: Pick<ProtonEvent, 'payload'>,
  occasion: GreetingOccasion,
): GreetingPayloadFacts | null {
  const { payload } = event;
  const user = readUserFacts(nested(payload, occasion === 'boost' ? 'author' : 'user'));
  if (user === null) return null;

  return {
    user,
    member:
      occasion === 'leave'
        ? 'unavailable'
        : readMemberFacts(occasion === 'boost' ? nested(payload, 'member') : payload),
    channelId: occasion === 'boost' ? str(nested(payload, 'channel_id')) : null,
  };
}

function serverFactsOf(guildId: string, guild: GuildSummary | null): ServerFacts {
  if (guild === null) return serverFactsFrom(null, guildId);

  const { roles, channels } = guild;
  if (roles !== undefined && channels !== undefined) {
    return serverFactsFrom({ ...guild, roles, channels }, guildId);
  }

  return {
    id: guildId,
    name: guild.name,
    memberCount: guild.memberCount,
    ownerId: guild.ownerId,
    iconHash: guild.iconHash,
    bannerHash: guild.bannerHash,
    description: guild.description,
    boostCount: guild.boostCount,
    boostTier: guild.boostTier,
  };
}

function channelFactsOf(guild: GuildSummary | null, channelId: string): ChannelFacts {
  const known = guild?.channels?.get(channelId);
  if (known === undefined) return { id: channelId };

  return { id: channelId, name: known.name, type: known.type, parentId: known.parentId };
}

async function botFactsFor(
  placeholders: PlaceholderEnvironment | undefined,
  logger: Logger,
  guildId: string,
): Promise<BotFacts | null> {
  if (placeholders === undefined) return null;

  try {
    return await placeholders.bot();
  } catch (error) {
    logger.warn(
      `Proton could not read its own profile, so its name and avatar render as nothing in this ` +
        `greeting: ${error instanceof Error ? error.message : String(error)}`,
      { guildId, moduleId: WELCOME_MODULE_ID },
    );
    return { id: placeholders.applicationId, name: null, supportUrl: PROTON_SUPPORT_URL };
  }
}

interface GreetingRender {
  surface: PlaceholderSurface<GreetingPlaceholderFacts>;
  message: GreetingMessage;
  event: ProtonEvent;
  read: GreetingPayloadFacts;
  guild: GuildSummary | null;
  destinationId: string;
}

async function renderFor(
  input: GreetingRender,
  ctx: ModuleContext<WelcomeConfig>,
  deps: WelcomeDeps,
): Promise<MessageRender<GreetingMessage>> {
  const { surface, message, event, read, guild, destinationId } = input;
  const now = deps.placeholders?.now() ?? Date.now();
  const keys = usedKeys(surface, greetingTemplates(message), { allowedOnly: true });
  const wantsBot = [...keys].some((key) => key.startsWith('bot.'));

  const facts: GreetingPlaceholderFacts = {
    user: read.user,
    member: read.member,
    server: serverFactsOf(ctx.guildId, guild),
    ...(read.channelId === null ? {} : { channel: channelFactsOf(guild, read.channelId) }),
    destinationChannel: channelFactsOf(guild, destinationId),
    bot: wantsBot ? await botFactsFor(deps.placeholders, ctx.logger, ctx.guildId) : null,
    eventId: event.id,
    occurredAt: event.occurredAt,
  };

  return renderGreetingMessage(message, surface, facts, now);
}

function sendGreeting(
  ctx: ModuleContext<WelcomeConfig>,
  channelId: string,
  message: GreetingMessage,
  idempotencyKey: string,
  files: Attachment[] = [],
): Promise<ActionResult> {
  const body = toDiscordMessage(message, { customIdFor: NO_CUSTOM_IDS });

  return ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: WELCOME_MODULE_ID,
    kind: 'send',
    actorId: WELCOME_ACTOR,

    idempotencyKey,
    dryRun: false,
    payload: { channelId, ...body, ...(files.length > 0 ? { files } : {}) },
  });
}

function failureReason(result: ActionResult): string | null {
  if (result.status !== 'failed_precheck' && result.status !== 'failed_api') return null;
  return result.failure?.humanReason ?? 'unknown reason';
}

export function createGreetingListener(deps: WelcomeDeps = {}): EventListener<WelcomeConfig> {
  const render = deps.render ?? renderCard;

  return {
    types: WELCOME_EVENT_TYPES,
    async handler(event: ProtonEvent, ctx: ModuleContext<WelcomeConfig>): Promise<void> {
      const joined = event.type === 'member.joined';

      const channelId = joined ? ctx.config.welcomeChannelId : ctx.config.goodbyeChannelId;

      if (!channelId) return;

      const guild = (await deps.guildState?.get(ctx.guildId)) ?? null;
      const target = readGreetingTarget(event.payload, guild ?? {});
      const read = readGreetingFacts(event, joined ? 'join' : 'leave');
      if (!target || !read) {
        ctx.logger.warn(`${event.type} carried no user, so nobody could be greeted`, {
          guildId: ctx.guildId,
          moduleId: WELCOME_MODULE_ID,
          eventId: event.id,
        });
        return;
      }

      const rendered = await renderFor(
        {
          surface: joined ? WELCOME_JOIN_SURFACE : WELCOME_LEAVE_SURFACE,
          message: joined ? ctx.config.welcomeMessage : ctx.config.goodbyeMessage,
          event,
          read,
          guild,
          destinationId: channelId,
        },
        ctx,
        deps,
      );

      if (!rendered.ok) {
        ctx.logger.error(
          `could not greet ${target.userId} in <#${channelId}>: ${rendered.humanReason}`,
          { guildId: ctx.guildId, moduleId: WELCOME_MODULE_ID, channelId },
        );
        return;
      }

      const message = rendered.message;

      const files = ctx.config.card
        ? await renderGreetingCard(joined, target, ctx, render, deps.cards ?? {})
        : [];

      if (isSilentGreeting(message) && files.length === 0) return;

      const result = await sendGreeting(ctx, channelId, message, `${event.id}:greeting`, files);

      const reason = failureReason(result);
      if (reason !== null) {
        ctx.logger.error(`could not greet ${target.userId} in <#${channelId}>: ${reason}`, {
          guildId: ctx.guildId,
          moduleId: WELCOME_MODULE_ID,
          channelId,
        });
      }
    },
  };
}

export function createBoostListener(deps: WelcomeDeps = {}): EventListener<WelcomeConfig> {
  return {
    types: BOOST_EVENT_TYPES,
    async handler(event: ProtonEvent, ctx: ModuleContext<WelcomeConfig>): Promise<void> {
      if (!ctx.config.boostEnabled || event.guildId === null) return;
      if (!isBoostNotice(event.payload)) return;

      const author = nested(event.payload, 'author');
      if (nested(author, 'bot') === true) return;

      const channelId = ctx.config.boostChannelId ?? str(nested(event.payload, 'channel_id'));
      if (!channelId) return;

      const guild = (await deps.guildState?.get(ctx.guildId)) ?? null;
      const target = readBoosterTarget(event.payload, guild ?? {});
      const read = readGreetingFacts(event, 'boost');
      if (!target || !read) {
        ctx.logger.warn('a boost notice carried no author, so nobody could be thanked', {
          guildId: ctx.guildId,
          moduleId: WELCOME_MODULE_ID,
          eventId: event.id,
        });
        return;
      }

      const rendered = await renderFor(
        {
          surface: WELCOME_BOOST_SURFACE,
          message: ctx.config.boostMessage,
          event,
          read,
          guild,
          destinationId: channelId,
        },
        ctx,
        deps,
      );

      if (!rendered.ok) {
        ctx.logger.error(
          `could not thank ${target.userId} for boosting in <#${channelId}>: ${rendered.humanReason}`,
          { guildId: ctx.guildId, moduleId: WELCOME_MODULE_ID, channelId },
        );
        return;
      }

      const message = rendered.message;
      if (isSilentGreeting(message)) return;

      const result = await sendGreeting(ctx, channelId, message, `${event.id}:boost`);

      const reason = failureReason(result);
      if (reason !== null) {
        ctx.logger.error(
          `could not thank ${target.userId} for boosting in <#${channelId}>: ${reason}`,
          { guildId: ctx.guildId, moduleId: WELCOME_MODULE_ID, channelId },
        );
      }
    },
  };
}

async function renderGreetingCard(
  joined: boolean,
  target: GreetingTarget,
  ctx: ModuleContext<WelcomeConfig>,
  render: (input: CardDescriptorInput, deps: CardDeps) => Promise<Uint8Array>,
  cards: CardDeps,
): Promise<Attachment[]> {
  try {
    const data = await render(
      {
        kind: joined ? 'welcome' : 'goodbye',
        preset: ctx.config.preset,
        accent: toHexColour(ctx.config.cardAccent),
        displayName: target.username,
        guildName: target.guildName,
        memberCount: target.memberCount,
        showMemberCount: ctx.config.cardShowMemberCount,
        ...(target.avatarHash
          ? { avatarUrl: discordAvatarUrl(target.userId, target.avatarHash) }
          : {}),
        ...(ctx.config.cardBackgroundUrl ? { backgroundUrl: ctx.config.cardBackgroundUrl } : {}),
      },
      {
        ...cards,
        onImageSkipped: (reason) =>
          ctx.logger.warn(`the greeting card dropped an image: ${reason}`, {
            guildId: ctx.guildId,
            moduleId: WELCOME_MODULE_ID,
          }),
      },
    );

    return [
      {
        filename: joined ? 'welcome.png' : 'goodbye.png',
        contentType: 'image/png',

        data: new Uint8Array(data),
      },
    ];
  } catch (error) {
    ctx.logger.error(
      `the ${joined ? 'welcome' : 'goodbye'} card could not be rendered, so the message was ` +
        `sent without it: ${error instanceof Error ? error.message : String(error)}`,
      { guildId: ctx.guildId, moduleId: WELCOME_MODULE_ID },
    );
    return [];
  }
}
