import type { ActionFailure, ActionResult, ModuleContext } from '@proton/core';
import { MESSAGE_CONTENT_MAX } from '@proton/core';
import { clipGraphemes, type PlaceholderLookup } from '@proton/core/placeholders';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { APPEALS_ACTOR, type AppealPanel, type AppealsConfig, MODULE_ID } from './config.ts';
import {
  APPEAL_DECISION_SURFACE,
  appealDecisionFacts,
  renderAppealDecision,
} from './placeholders.ts';
import type { AppealRecord, AppealStore } from './store.ts';
import type { FiledAppeal } from './web.ts';

export const DM_ATTEMPTS_MAX = 5;

export type NotifyOutcome = 'sent' | 'closed' | 'failed' | 'unconfirmed' | 'gave_up';

function channelIdOf(result: ActionResult): string | null {
  const id = (result.body as { id?: unknown } | undefined)?.id;

  return typeof id === 'string' ? id : null;
}

function mayHaveLanded(code: string | undefined): boolean {
  return code === 'transport_failure' || /^discord_5\d\d$/.test(code ?? '');
}

const DMS_CLOSED: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.CannotSendMessagesToThisUser,
  RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds,
]);

function dmsClosed(failure: ActionFailure | undefined): boolean {
  const code = failure?.discordCode;
  return code === undefined ? failure?.code === 'discord_403' : DMS_CLOSED.has(code);
}

function undelivered(
  ctx: ModuleContext<AppealsConfig>,
  appeal: AppealRecord,
  result: ActionResult,
  step: 'open' | 'send',
): 'closed' | 'failed' | 'unconfirmed' {
  const context = { guildId: ctx.guildId, moduleId: MODULE_ID, userId: appeal.userId };
  const decided = `appeal #${appeal.number} was decided but`;
  const humanReason = result.failure?.humanReason ?? 'Discord gave no reason.';

  if (dmsClosed(result.failure)) {
    ctx.logger.warn(
      `${decided} ${appeal.userId} could not be told: Discord would not deliver the direct ` +
        'message. Their direct messages are closed, or they no longer share a server with ' +
        'Proton. They do not know the outcome.',
      context,
    );
    return 'closed';
  }

  if (step === 'send' && mayHaveLanded(result.failure?.code)) {
    ctx.logger.error(
      `${decided} the message telling ${appeal.userId} may not have reached them: ` +
        `${humanReason} Proton cannot tell whether they know the outcome.`,
      context,
    );
    return 'unconfirmed';
  }

  ctx.logger.error(
    `${decided} ${appeal.userId} could not be told: ${humanReason} They do not know the outcome.`,
    context,
  );
  return 'failed';
}

export function decisionMessage(
  appeal: Pick<FiledAppeal, 'number' | 'status'>,
  panel: AppealPanel,
  lookup: PlaceholderLookup,
  now: number,
): string {
  const approved = appeal.status === 'approved';

  const verdict = renderAppealDecision(
    approved ? panel.approvedMessage : panel.deniedMessage,
    lookup,
    'discord_text',
    now,
  ).output;

  const rejoin = approved && panel.rejoinUrl ? `\n\n${panel.rejoinUrl}` : '';

  return clipGraphemes(`**Appeal #${appeal.number}**\n${verdict}${rejoin}`, MESSAGE_CONTENT_MAX);
}

/**
 * The same crash-safe shape the honeypot's own DM uses: the opened channel id is written down
 * before the send, because the executor answers a redelivered open with `skipped_duplicate` and no
 * body — and a decision the member is never told about is a decision that did not happen for them.
 */
export async function tellAppellant(
  ctx: ModuleContext<AppealsConfig>,
  store: AppealStore,
  appeal: AppealRecord,
  panel: AppealPanel,
  now: number = Date.now(),
): Promise<NotifyOutcome> {
  let channelId = appeal.dmChannelId;

  if (channelId === null) {
    const attempts = await store.noteDmAttempt(ctx.guildId, appeal.id);

    if (attempts > DM_ATTEMPTS_MAX) {
      ctx.logger.error(
        `appeal #${appeal.number} was decided but ${appeal.userId} could not be reached after ` +
          `${DM_ATTEMPTS_MAX} attempts. They do not know the outcome.`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, userId: appeal.userId },
      );
      return 'gave_up';
    }

    const opened = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'create_dm',
      actorId: APPEALS_ACTOR,
      targetId: appeal.userId,
      idempotencyKey: `${MODULE_ID}:${appeal.id}:dm-open:${attempts}`,
      dryRun: false,
      record: false,
      payload: { userId: appeal.userId },
    });

    channelId = channelIdOf(opened);
    if (channelId === null) return undelivered(ctx, appeal, opened, 'open');

    await store.rememberDm(ctx.guildId, appeal.id, channelId);
  }

  const lookup = APPEAL_DECISION_SURFACE.build(appealDecisionFacts(appeal, panel), { now });

  const sent = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: APPEALS_ACTOR,
    targetId: appeal.userId,
    idempotencyKey: `${MODULE_ID}:${appeal.id}:dm-send:${appeal.status}`,
    dryRun: false,
    record: false,
    payload: {
      channelId,
      content: decisionMessage(appeal, panel, lookup, now),
      allowedMentions: { parse: [] },
      directMessage: true,
    },
  });

  if (sent.status === 'executed' || sent.status === 'skipped_duplicate') return 'sent';

  return undelivered(ctx, appeal, sent, 'send');
}
