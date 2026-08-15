import type { CardDeps, CardDescriptorInput } from '@proton/cards';
import { discordAvatarUrl, renderCard } from '@proton/cards';
import type {
  Attachment,
  EventListener,
  EventType,
  ModuleContext,
  ProtonEvent,
} from '@proton/core';
import { type GreetingFacts, renderGreeting, type WelcomeConfig } from './config.ts';

export const WELCOME_MODULE_ID = 'welcome';

export const WELCOME_ACTOR = 'proton:welcome';

export const WELCOME_EVENT_TYPES: EventType[] = ['member.joined', 'member.left'];

export interface WelcomeDeps {
  cards?: CardDeps;

  render?: (input: CardDescriptorInput, deps: CardDeps) => Promise<Uint8Array>;
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

export function readGreetingTarget(payload: unknown): GreetingTarget | null {
  const user = nested(payload, 'user');
  const userId = str(nested(user, 'id'));
  if (!userId) return null;

  const username = str(nested(user, 'global_name')) ?? str(nested(user, 'username')) ?? 'someone';

  return {
    userId,
    username,
    guildName: str(nested(payload, 'guild_name')) ?? 'this server',
    memberCount:
      typeof nested(payload, 'member_count') === 'number'
        ? (nested(payload, 'member_count') as number)
        : 0,
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

      const target = readGreetingTarget(event.payload);
      if (!target) {
        ctx.logger.warn(`${event.type} carried no user, so nobody could be greeted`, {
          guildId: ctx.guildId,
          moduleId: WELCOME_MODULE_ID,
          eventId: event.id,
        });
        return;
      }

      const content = renderGreeting(
        joined ? ctx.config.welcomeMessage : ctx.config.goodbyeMessage,
        target,
      );

      const files = ctx.config.card
        ? await renderGreetingCard(joined, target, ctx, render, deps.cards ?? {})
        : [];

      const result = await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: WELCOME_MODULE_ID,
        kind: 'send',
        actorId: WELCOME_ACTOR,

        idempotencyKey: `${event.id}:greeting`,
        dryRun: false,
        payload: { channelId, content, ...(files.length > 0 ? { files } : {}) },
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
        displayName: target.username,
        guildName: target.guildName,
        memberCount: target.memberCount,
        ...(target.avatarHash
          ? { avatarUrl: discordAvatarUrl(target.userId, target.avatarHash) }
          : {}),
      },
      cards,
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
