import type { CardDeps, CardDescriptorInput } from '@proton/cards';
import { discordAvatarUrl, renderCard, toHexColour } from '@proton/cards';
import {
  type Attachment,
  type CustomIdFor,
  type EventListener,
  type EventType,
  type ModuleContext,
  type ProtonEvent,
  toDiscordMessage,
} from '@proton/core';
import {
  type GreetingFacts,
  isSilentGreeting,
  renderGreeting,
  type WelcomeConfig,
} from './config.ts';

export const WELCOME_MODULE_ID = 'welcome';

export const WELCOME_ACTOR = 'proton:welcome';

export const WELCOME_EVENT_TYPES: EventType[] = ['member.joined', 'member.left'];

// Only a link button survives greetingMessageSchema, and link buttons never ask for a custom_id,
// so reaching this means the config was written around the dashboard.
const NO_CUSTOM_IDS: CustomIdFor = () => {
  throw new Error(
    'a welcome or goodbye message carried a component, and the welcome module has no interaction ' +
      'listener to answer a press on it. Remove the component rows from the welcome module config.',
  );
};

export interface WelcomeDeps {
  cards?: CardDeps;

  render?: (input: CardDescriptorInput, deps: CardDeps) => Promise<Uint8Array>;
  guildState?: { get(guildId: string): Promise<GuildSummary | null> };
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export interface GreetingTarget extends GreetingFacts {
  avatarHash: string | null;
}

export interface GuildSummary {
  name?: string | undefined;
  memberCount?: number | undefined;
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

export function createGreetingListener(deps: WelcomeDeps = {}): EventListener<WelcomeConfig> {
  const render = deps.render ?? renderCard;

  return {
    types: WELCOME_EVENT_TYPES,
    async handler(event: ProtonEvent, ctx: ModuleContext<WelcomeConfig>): Promise<void> {
      const joined = event.type === 'member.joined';

      const channelId = joined ? ctx.config.welcomeChannelId : ctx.config.goodbyeChannelId;

      if (!channelId) return;

      const guild = (await deps.guildState?.get(ctx.guildId)) ?? {};
      const target = readGreetingTarget(event.payload, guild);
      if (!target) {
        ctx.logger.warn(`${event.type} carried no user, so nobody could be greeted`, {
          guildId: ctx.guildId,
          moduleId: WELCOME_MODULE_ID,
          eventId: event.id,
        });
        return;
      }

      const message = renderGreeting(
        joined ? ctx.config.welcomeMessage : ctx.config.goodbyeMessage,
        target,
      );

      const files = ctx.config.card
        ? await renderGreetingCard(joined, target, ctx, render, deps.cards ?? {})
        : [];

      if (isSilentGreeting(message) && files.length === 0) return;

      const body = toDiscordMessage(message, { customIdFor: NO_CUSTOM_IDS });

      const result = await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: WELCOME_MODULE_ID,
        kind: 'send',
        actorId: WELCOME_ACTOR,

        idempotencyKey: `${event.id}:greeting`,
        dryRun: false,
        payload: { channelId, ...body, ...(files.length > 0 ? { files } : {}) },
      });

      if (result.status === 'failed_precheck' || result.status === 'failed_api') {
        ctx.logger.error(
          `could not greet ${target.userId} in <#${channelId}>: ${
            result.failure?.humanReason ?? 'unknown reason'
          }`,
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
