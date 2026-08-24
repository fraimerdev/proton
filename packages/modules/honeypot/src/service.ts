import {
  type ActionResult,
  type EventListener,
  type EventType,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  type ModuleContext,
  type ProtonEvent,
} from '@proton/core';
import { HONEYPOT_ACTOR, type HoneypotChannel, type HoneypotConfig, MODULE_ID } from './config.ts';
import { describeUnbound, type HoneypotDeps } from './deps.ts';
import { buildNoticeComponents } from './notice.ts';
import type { NoticeBook } from './store.ts';

export const HONEYPOT_SERVICE_EVENT_TYPES: EventType[] = ['proton.config_changed'];

export interface NoticeChange {
  channelId: string;
  did: 'posted' | 'refreshed' | 'removed' | 'failed';
}

export type NoticeOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'refused'; reason: string }
  | { action: 'reconciled'; changes: NoticeChange[] };

function field(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

function succeeded(result: ActionResult): boolean {
  return (
    result.status === 'executed' ||
    result.status === 'dry_run' ||
    result.status === 'skipped_duplicate'
  );
}

function sentMessageId(result: ActionResult): string | null {
  const id = (result.body as { id?: unknown } | undefined)?.id;

  return typeof id === 'string' ? id : null;
}

export function createHoneypotNoticeListener(deps: HoneypotDeps): EventListener<HoneypotConfig> {
  return {
    types: HONEYPOT_SERVICE_EVENT_TYPES,
    async handler(event, ctx) {
      await reconcileNotices(event, ctx, deps);
    },
  };
}

export async function reconcileNotices(
  event: ProtonEvent,
  ctx: ModuleContext<HoneypotConfig>,
  deps: HoneypotDeps,
): Promise<NoticeOutcome> {
  if (field(event.payload, 'moduleId') !== MODULE_ID) {
    return { action: 'ignored', reason: 'another module was saved' };
  }

  const notices = deps.notices;
  if (!notices) {
    ctx.logger.error(describeUnbound('the honeypot notices were not reconciled', ['notices']), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { action: 'refused', reason: 'the notice port is unbound' };
  }

  // The module-level switch is not in the config schema, so a module that was just turned off can
  // only learn it from the event that announced the change.
  const live = field(event.payload, 'enabledAfter') !== false && ctx.config.enabled;

  const wanted = new Map<string, HoneypotChannel>(
    live ? ctx.config.channels.filter((c) => c.enabled).map((c) => [c.channelId, c]) : [],
  );

  const book = await notices.get(ctx.guildId);
  const next: NoticeBook = {};
  const changes: NoticeChange[] = [];

  for (const [channelId, channel] of wanted) {
    const known = book[channelId];
    const change = await ensure(
      ctx,
      event,
      channel,
      known,
      await caughtFor(deps, ctx.guildId, channelId),
    );

    if (change.record) next[channelId] = change.record;
    if (change.did) changes.push({ channelId, did: change.did });
  }

  for (const [channelId, record] of Object.entries(book)) {
    if (wanted.has(channelId)) continue;

    // The channel is not a trap any more, so a notice saying it is would be a lie.
    const removed = await run(
      ctx,
      {
        kind: 'delete_message',
        payload: { channelId, messageId: record.messageId },
        idempotencyKey: `${MODULE_ID}:${event.id}:notice-remove:${channelId}`,
      },
      `take down the notice in ${channelId}`,
    );

    // Forgetting a notice Discord refused to delete strands it: nothing would ever try again, and
    // the channel would keep a message calling itself a trap that no longer is.
    if (!succeeded(removed) && removed.failure?.code !== 'discord_404') {
      next[channelId] = record;
      changes.push({ channelId, did: 'failed' });
      continue;
    }

    changes.push({ channelId, did: 'removed' });
  }

  await notices.put(ctx.guildId, next);

  return { action: 'reconciled', changes };
}

interface EnsureResult {
  record?: { messageId: string; postedAt: number } | undefined;
  did?: NoticeChange['did'] | undefined;
}

async function ensure(
  ctx: ModuleContext<HoneypotConfig>,
  event: ProtonEvent,
  channel: HoneypotChannel,
  known: { messageId: string; postedAt: number } | undefined,
  caught: number,
): Promise<EnsureResult> {
  const built = buildNoticeComponents(channel, caught);
  if (!built.ok) {
    ctx.logger.error(`honeypot could not build its notice: ${built.humanReason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { did: 'failed' };
  }

  // No allowedMentions here: editMessagePayloadSchema has no such field and Zod strips it, so
  // putting it on the shared object would read as a guarantee the edit does not carry.
  const message = { channelId: channel.channelId, components: built.components };

  if (known) {
    const edited = await run(
      ctx,
      {
        kind: 'edit_message',

        // No flags on the edit: Discord refuses to take IS_COMPONENTS_V2 off a message, and the
        // send that created it already set the bit.
        payload: { ...message, messageId: known.messageId },
        idempotencyKey: `${MODULE_ID}:${event.id}:notice-edit:${channel.channelId}`,
      },
      `refresh the notice in ${channel.channelId}`,
    );

    if (succeeded(edited)) return { record: known, did: 'refreshed' };

    // Somebody deleted it. Remembering a dead id would make every later save fail the same way, so
    // fall through and post a fresh one.
    if (edited.failure?.code !== 'discord_404') return { record: known, did: 'failed' };
  }

  const posted = await run(
    ctx,
    {
      kind: 'send',
      payload: { ...message, allowedMentions: { parse: [] }, flags: MESSAGE_FLAG_IS_COMPONENTS_V2 },
      idempotencyKey: `${MODULE_ID}:${event.id}:notice-post:${channel.channelId}`,
    },
    `post the notice in ${channel.channelId}`,
  );

  if (!succeeded(posted)) return { did: 'failed' };

  const messageId = sentMessageId(posted);
  if (!messageId) {
    ctx.logger.error(
      `honeypot posted its notice in ${channel.channelId} but Discord returned no message id, so ` +
        'the next save cannot refresh it and will post a second one. Delete this one by hand.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return { did: 'failed' };
  }

  return { record: { messageId, postedAt: event.occurredAt }, did: 'posted' };
}

async function run(
  ctx: ModuleContext<HoneypotConfig>,
  request: {
    kind: 'send' | 'edit_message' | 'delete_message';
    payload: unknown;
    idempotencyKey: string;
  },
  attempt: string,
): Promise<ActionResult> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: request.kind,
    actorId: HONEYPOT_ACTOR,
    dryRun: false,
    record: false,
    idempotencyKey: request.idempotencyKey,
    payload: request.payload,
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.error(
      `honeypot could not ${attempt}: ${result.failure?.humanReason ?? 'no reason was reported'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }

  return result;
}

async function caughtFor(deps: HoneypotDeps, guildId: string, channelId: string): Promise<number> {
  return deps.stats ? deps.stats.total(guildId, channelId) : 0;
}

export const NOTICE_REFRESH_MS = 10_000;

// Debounced across every worker process: a raid of fifty bots must not become fifty edits of one
// message, and a missed count is picked up by the next trip outside the window or the next save.
export async function refreshNoticeCount(
  ctx: ModuleContext<HoneypotConfig>,
  deps: HoneypotDeps,
  channelId: string,
  eventId: string,
): Promise<'refreshed' | 'debounced' | 'skipped'> {
  const { notices, stats } = deps;
  if (!notices || !stats) return 'skipped';

  const known = (await notices.get(ctx.guildId))[channelId];
  if (!known) return 'skipped';

  const channel = ctx.config.channels.find((candidate) => candidate.channelId === channelId);
  if (!channel) return 'skipped';

  if (!(await stats.claimRefresh(ctx.guildId, channelId, NOTICE_REFRESH_MS))) return 'debounced';

  const built = buildNoticeComponents(channel, await stats.total(ctx.guildId, channelId));
  if (!built.ok) return 'skipped';

  await run(
    ctx,
    {
      kind: 'edit_message',
      payload: {
        channelId,
        messageId: known.messageId,
        components: built.components,
        allowedMentions: { parse: [] },
      },
      idempotencyKey: `${MODULE_ID}:${eventId}:notice-count:${channelId}`,
    },
    `move the count on the notice in ${channelId}`,
  );

  return 'refreshed';
}
