import { type ModuleContext, type ScheduledHandler, snowflakeSchema } from '@proton/core';
import { z } from 'zod';
import { MODULE_ID, type PollsConfig, pollLink } from './config.ts';
import { bindStore, describeUnbound, type PollsDeps } from './deps.ts';
import { MENTIONS_OFF } from './perform.ts';
import type { PollRecord, PollStore } from './store.ts';

export const ANNOUNCE_JOB = 'announce';

export const announceJobSchema = z.object({ messageId: snowflakeSchema });

export type CloseOutcome = 'announced' | 'not_announced' | 'already_ended';

// Derived from the poll rather than from whatever triggered it: the deadline sweep and an early
// /poll end are two different events that must produce one announcement between them.
export function announceKey(guildId: string, messageId: string): string {
  return `${MODULE_ID}:${guildId}:${messageId}:announce`;
}

export function renderAnnouncement(record: PollRecord): string {
  return (
    `**Poll closed** — “${record.question}”\n` +
    `${pollLink(record.guildId, record.channelId, record.messageId)}\n` +
    'Discord keeps the final tally on the poll itself and I cannot read it back, so open ' +
    'the poll above for the counts.'
  );
}

export async function closePoll(
  ctx: ModuleContext<PollsConfig>,
  store: PollStore,
  record: PollRecord,
  endedAt: Date,
): Promise<CloseOutcome> {
  const ended = await store.end(ctx.guildId, record.messageId, endedAt);

  if (!ctx.config.announceResults) return ended ? 'not_announced' : 'already_ended';

  const channelId = record.announceChannelId ?? record.channelId;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: record.createdBy,
    idempotencyKey: announceKey(ctx.guildId, record.messageId),
    dryRun: false,
    // A poll is not a moderation action; recording one would put every /poll in the case ledger.
    record: false,
    payload: {
      channelId,
      content: renderAnnouncement(record),
      allowedMentions: MENTIONS_OFF,
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.error(
      `The poll “${record.question}” closed, but Proton could not announce it in <#${channelId}>: ` +
        `${result.failure?.humanReason ?? 'no reason was reported'}. Give Proton View Channel ` +
        'and Send Messages there, or change the announce channel in the Polls settings. The ' +
        'poll itself is unaffected.',
      {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        channelId,
        messageId: record.messageId,
        code: result.failure?.code,
      },
    );

    return 'not_announced';
  }

  // Deliberately not gated on `ended`: the delivery that closed the row may have died before it
  // reached this send, and only a later one can repair that. The key is the poll, so a send that
  // genuinely already went out comes back skipped_duplicate instead of posting twice.
  if (result.status === 'skipped_duplicate' && !ended) return 'already_ended';

  return 'announced';
}

export function createAnnounceHandler(deps: PollsDeps): ScheduledHandler<PollsConfig> {
  return async (data, ctx) => {
    const parsed = announceJobSchema.safeParse(data);
    if (!parsed.success) {
      ctx.logger.error(
        'A polls announce job was scheduled without a usable message id, so nothing was ' +
          `announced: ${parsed.error.issues
            .map((issue) => `${issue.path.map(String).join('.')} ${issue.message}`)
            .join('; ')}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }

    const bound = bindStore(deps);
    if ('unbound' in bound) {
      ctx.logger.error(describeUnbound('a finished poll could not be announced', bound.unbound), {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
      });
      return;
    }

    const record = await bound.store.get(ctx.guildId, parsed.data.messageId);
    if (!record) {
      ctx.logger.warn(
        `The poll ${parsed.data.messageId} is no longer in this server's records, so its result ` +
          'was not announced. It was probably deleted along with the server or its channel.',
        { guildId: ctx.guildId, moduleId: MODULE_ID, messageId: parsed.data.messageId },
      );
      return;
    }

    await closePoll(ctx, bound.store, record, new Date());
  };
}
