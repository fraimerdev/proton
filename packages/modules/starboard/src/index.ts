import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  STARBOARD_SCHEMA_VERSION,
  starboardConfigSchema,
  starboardDefaultConfig,
} from './config.ts';
import type { StarboardDeps } from './deps.ts';
import { createStarboardListener } from './listener.ts';

export {
  DEFAULT_STAR_EMOJI,
  STARBOARD_SCHEMA_VERSION,
  type StarboardConfig,
  starboardConfigSchema,
  starboardDefaultConfig,
} from './config.ts';
export {
  type BoardPost,
  countStars,
  decide,
  type Eligibility,
  eligibility,
  INELIGIBLE_REASONS,
  type IneligibleReason,
  type StarboardDecision,
  type StarboardState,
  type StarCount,
} from './decide.ts';
export {
  type BindResult,
  type BoardPostQuery,
  type BoundStarboardDeps,
  bindDeps,
  describeUnbound,
  type SourceMessageRequest,
  type StarboardDeps,
} from './deps.ts';
export {
  type BoardMessage,
  type BoardMessageInput,
  boardPostMatches,
  buildBoardMessage,
  DESCRIPTION_MAX,
  jumpUrl,
  STAR_COLOUR,
} from './embed.ts';
export {
  createKey,
  createStarboardListener,
  MODULE_ID,
  STARBOARD_EVENT_TYPES,
} from './listener.ts';
export { DrizzleStarboardStore } from './postgres-store.ts';
export {
  type EmojiRef,
  emojiDisplay,
  emojiRestForm,
  firstImage,
  parseEmoji,
  rawStarCount,
  readReaction,
  readSourceMessage,
  type SourceAttachment,
  type SourceMessage,
  type SourceMessageExtras,
  type SourceReaction,
  type StarReaction,
  sameEmoji,
} from './source.ts';
export type { StarboardPost, StarboardStore } from './store.ts';
export {
  type NewStarboardPostRow,
  type StarboardPostRow,
  starboardPosts,
} from './table.ts';

/**
 * Starboard (PLAN.md §8, Phase 3).
 *
 * A factory rather than a constant because the module needs a table and two
 * message reads, and §7's `ModuleContext` supplies neither — see
 * `StarboardDeps`, and `createLoggingModule` for the same gap.
 *
 * One decision determines everything else in the package: **the count is
 * re-read from the message, never accumulated from events.** Reaction dispatches
 * carry no id of their own, so the gateway derives one from
 * `(channel, message, user, emoji)`; a genuine react → unreact → react inside
 * the executor's dedupe window is therefore indistinguishable from a RESUME
 * redelivery. A module that counted the events would drift by one and stay
 * wrong forever, with nothing to reconcile against. Re-reading makes an event a
 * trigger rather than a datum, which makes redelivery free and makes the whole
 * state machine (`decide.ts`) a pure function of the message.
 *
 * The one thing that is not idempotent by construction is the first post: two
 * members starring together produce two different event ids and two handlers
 * that both find no board post. That is what I4 is for, and it is solved with
 * an idempotency key derived from `(guild, source message, 'create')` rather
 * than from the event — no lock, no leader, and `skipped_duplicate` becomes a
 * repair signal rather than a no-op. `create` in `listener.ts` sets it out.
 *
 * Two gaps are worth naming rather than discovering:
 *
 *  1. **`ActionResult` does not carry the created message's id.** The executor
 *     discards Discord's response body, so a module cannot learn the id of a
 *     message it just sent — and this module needs exactly that to edit or
 *     delete its own board post later. It is recovered by looking the post up
 *     again (`StarboardDeps.resolveBoardPost`), which costs a read per board
 *     post and is the ugliest thing here. Closing it means widening
 *     `ActionResult`, which is `packages/core`'s to do.
 *  2. **`manifest.migrations` still runs nowhere.** As with `logging`, the DDL
 *     ships in the core set instead — `packages/db/drizzle/0005_starboard.sql` —
 *     and `migrations` below is empty rather than holding a second copy of it.
 */
export function createStarboardModule(
  deps: StarboardDeps = {},
): ModuleManifest<typeof starboardConfigSchema> {
  return {
    id: 'starboard',
    name: 'Starboard',
    category: 'engagement',
    configSchema: starboardConfigSchema,
    defaultConfig: starboardDefaultConfig,
    schemaVersion: STARBOARD_SCHEMA_VERSION,

    /**
     * `GuildMessageReactions` (1<<10) is the load-bearing one: without it
     * MESSAGE_REACTION_ADD is never dispatched, so the module would sit in a
     * server watching an empty stream and reporting itself healthy. It is not
     * privileged, so declaring it costs a guild nothing and the registry names
     * it if the application is ever identified without it.
     *
     * `Guilds` and `GuildMessages` are declared because they describe the
     * surface this module works on — guild channels, and the messages it reads
     * back and posts — and both are likewise non-privileged. `MessageContent` is
     * deliberately absent: the board embed reproduces the starred message's
     * text, but that text arrives through `GET /channels/{c}/messages/{m}`,
     * which returns `content` on the strength of READ_MESSAGE_HISTORY rather
     * than the intent. A starboard that demanded a privileged intent it never
     * uses would be refused by servers that were right to refuse it.
     */
    requiredIntents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],

    /**
     * The four permissions without which the module cannot do its one job.
     *
     * VIEW_CHANNEL and READ_MESSAGE_HISTORY are what `GET /channels/{c}/messages/{m}`
     * needs (verified), and that read *is* the design — no read, no count.
     * SEND_MESSAGES and EMBED_LINKS are what posting the board embed needs; a
     * starboard that cannot post is not a degraded starboard, it is none. So
     * unlike `phishing`'s optional alert channel, these belong in the hard gate,
     * where the registry names the missing one instead of a guild watching stars
     * accumulate against nothing.
     *
     * **MANAGE_MESSAGES is deliberately not here**, and this is the one
     * judgement call in the manifest. It is needed only for `delete_message` —
     * retracting a board post when a message falls back below the threshold —
     * and that is the least important of the four transitions; create, edit and
     * no-op all work without it. `cases` keeps ban rights out of its hard gate
     * so a guild that never grants bans still gets its moderation history, and
     * the same argument applies with more force here: taking away a working
     * starboard to protect a cleanup step trades the feature for the tidying.
     * `antiraid` argues the other way — both its permissions are hard-gated,
     * because a security control whose value is being ready before the raid must
     * not discover the gap at 3am. A starboard is not that; nothing is lost by
     * finding out at the moment of the first retraction. And the requirement is
     * itself over-strict: `REQUIRED_PERMISSIONS` says in as many words that
     * deleting your own message needs nothing, and MANAGE_MESSAGES is demanded
     * only to keep one rule per kind. Hard-gating a module on a permission
     * Discord would not actually have asked for is the wrong trade. The
     * executor's precheck names it when the delete is attempted (I8), which is
     * the right layer for a per-action requirement.
     *
     * These are evaluated at guild level, so an overwrite that denies
     * SEND_MESSAGES in the board channel specifically still surfaces as a
     * precheck or a 403 rather than as a disabled module — the same limitation
     * `phishing` records about its alert channel.
     */
    requiredPermissions: [
      Permissions.ViewChannel,
      Permissions.ReadMessageHistory,
      Permissions.SendMessages,
      Permissions.EmbedLinks,
    ],

    listeners: [createStarboardListener(deps)],

    // See gap 2 above: the DDL is packages/db/drizzle/0005_starboard.sql.
    migrations: [],

    dashboard: {
      icon: 'star',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'boardChannelId'] },
        { id: 'threshold', title: 'Stars', fields: ['emoji', 'threshold'] },
        {
          id: 'scope',
          title: 'What can be starred',
          fields: ['sourceChannelIds', 'ignoreBots', 'selfStarAllowed', 'ignoreNsfw'],
        },
      ],
    },
  };
}

/**
 * The module as the registry and dashboard see it, with nothing bound.
 *
 * Safe because `enabled` defaults to false: a guild that has not opted in
 * produces no board posts at all. A guild that has opted in gets an error naming
 * exactly what is unwired the first time someone stars a message, rather than
 * silence — which, for a feature a whole server can watch failing, is the one
 * outcome ruled out.
 */
export const starboardModule: ModuleManifest<typeof starboardConfigSchema> =
  createStarboardModule();

export default starboardModule;
