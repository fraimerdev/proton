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

/** Nobody pressed a button — see `RULE_ENGINE_ACTOR` for the same reasoning. */
export const WELCOME_ACTOR = 'proton:welcome';

export const WELCOME_EVENT_TYPES: EventType[] = ['member.joined', 'member.left'];

export interface WelcomeDeps {
  /**
   * How a card is rendered. Injected so a test never rasterises a real PNG and
   * never reaches the CDN (I11), and so the avatar fetcher is opt-in — see
   * `@proton/cards`' note on why fetching an avatar is not an I2 violation.
   */
  cards?: CardDeps;
  /** Overridable so a test can assert on the descriptor without rendering. */
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

/**
 * Read the member out of a `member.joined` or `member.left` dispatch.
 *
 * Both carry a `user`, which is all this module needs — it never touches roles,
 * so it never has to care that `GUILD_MEMBER_REMOVE` omits them.
 *
 * `guildName` and `memberCount` are **not** on either dispatch. They are on
 * GUILD_CREATE, which this module does not consume, so they are optional here
 * and the templates degrade rather than rendering the word "undefined": a
 * `{server}` with nothing behind it becomes "this server", and a
 * `{memberCount}` becomes an empty string. Naming that here rather than letting
 * `String(undefined)` reach a guild's welcome channel.
 */
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

/**
 * Welcome and goodbye greetings (PLAN.md §8, Phase 3).
 *
 * A factory rather than a constant so rendering can be injected: the module
 * would otherwise rasterise a real PNG in every test and reach
 * `cdn.discordapp.com` for an avatar, which I11 forbids outright.
 */
export function createGreetingListener(deps: WelcomeDeps = {}): EventListener<WelcomeConfig> {
  const render = deps.render ?? renderCard;

  return {
    types: WELCOME_EVENT_TYPES,
    async handler(event: ProtonEvent, ctx: ModuleContext<WelcomeConfig>): Promise<void> {
      const joined = event.type === 'member.joined';

      const channelId = joined ? ctx.config.welcomeChannelId : ctx.config.goodbyeChannelId;
      // An unset channel is a configuration, not a fault: a guild may want joins
      // announced and leaves kept quiet. No log line — this fires per join.
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
        // Derived from the event id, so a redelivered join greets once (I4).
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

/**
 * Render the card, or give up on the card alone.
 *
 * A failed render must never swallow the greeting: the message is the feature
 * and the image is decoration, so this returns an empty attachment list and says
 * why rather than propagating. Propagating would leave the entry unacked, the
 * bus would redeliver it, and a font or rasteriser fault — which no retry fixes
 * — would silence every welcome in every guild until someone read the logs.
 */
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
        // Copied into a fresh, exactly-sized buffer. The renderer's output may be
        // a view onto a pooled or shared allocation, and `Attachment.data` is
        // declared against a plain ArrayBuffer because the executor hands it
        // straight to `Blob`.
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
