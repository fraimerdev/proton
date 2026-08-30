import type { ActionResult, EntitlementTier, ModuleContext } from '@proton/core';
import { appealLinkUrl, BUTTON_URL_MAX, newAppealLinkClaims, signAppealLink } from '@proton/core';
import { HONEYPOT_ACTOR, type HoneypotConfig, MODULE_ID } from './config.ts';
import { describeUnbound, type HoneypotDeps } from './deps.ts';
import { type DmFacts, renderDirectMessage } from './render.ts';
import { DM_ATTEMPTS_MAX } from './store.ts';

export type DmOutcome = 'sent' | 'closed' | 'failed' | 'skipped' | 'gave_up';

/**
 * The Appeal button's address, minted per recipient. Every failure here answers `undefined` and
 * the message is still sent — a link that goes nowhere is worse than no button, and a member who
 * was banned must be told even when Proton cannot offer them a way to argue about it.
 */
export async function appealUrlFor(
  ctx: ModuleContext<HoneypotConfig>,
  deps: HoneypotDeps,
  userId: string,
  root: string,
  issuedAt: number,
  bans: boolean,
): Promise<string | undefined> {
  const panelId = ctx.config.appealPanelId;
  if (!panelId || !bans) return undefined;

  if (!deps.linkSecret || !deps.linkBaseUrl) {
    ctx.logger.error(
      describeUnbound(`${userId} was banned and offered no appeal link`, [
        ...(deps.linkSecret ? [] : ['linkSecret']),
        ...(deps.linkBaseUrl ? [] : ['linkBaseUrl']),
      ]),
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
    );
    return undefined;
  }

  try {
    const token = await signAppealLink(
      newAppealLinkClaims({
        guildId: ctx.guildId,
        userId,
        panelId,
        origin: MODULE_ID,

        // The trap root, so a redelivered catch mints a byte-identical link and the appeal filed
        // under it is found rather than filed twice.
        jti: root,
        issuedAt,
      }),
      deps.linkSecret,
    );

    const url = appealLinkUrl(deps.linkBaseUrl, token);
    if (url.length <= BUTTON_URL_MAX) return url;

    ctx.logger.error(
      `${userId} was banned and offered no appeal link: the signed address came to ${url.length} ` +
        `characters and Discord allows ${BUTTON_URL_MAX} on a button.`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
    );
  } catch (error) {
    ctx.logger.error(
      `${userId} was banned and offered no appeal link: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
    );
  }

  return undefined;
}

export const DM_RESULT_LABEL: Record<DmOutcome, string> = {
  sent: 'They were told before it happened.',
  closed: 'They could not be told — their direct messages are closed.',
  failed: 'They could not be told — Discord refused the message.',
  skipped: 'They were not told: this server does not send one.',
  gave_up: 'They were NOT told, after several attempts. Check the log.',
};

function channelIdOf(result: ActionResult): string | null {
  const id = (result.body as { id?: unknown } | undefined)?.id;

  return typeof id === 'string' ? id : null;
}

/**
 * Sent before the punishment, because after a ban there is no shared server left to send it
 * through. The opened channel id is written down before the send: the executor answers a
 * redelivered open with `skipped_duplicate` and **no body**, so a worker that died between the two
 * calls would otherwise leave the member banned, never told, and with nothing to retry from.
 */
export async function sendDirectMessage(
  ctx: ModuleContext<HoneypotConfig>,
  deps: HoneypotDeps,
  userId: string,
  root: string,
  facts: DmFacts,
  tier: EntitlementTier | undefined,
): Promise<DmOutcome> {
  if (!ctx.config.sendDirectMessage) return 'skipped';

  const held = await deps.dms?.recall(ctx.guildId, root);

  let channelId = held?.channelId ?? null;

  if (channelId === null) {
    const attempts = (await deps.dms?.attempted(ctx.guildId, root)) ?? 1;

    if (attempts > DM_ATTEMPTS_MAX) {
      ctx.logger.error(
        `honeypot has tried ${DM_ATTEMPTS_MAX} times to open a direct message with ${userId} and ` +
          'has given up. They were acted on without being told why.',
        { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
      );
      return 'gave_up';
    }

    const opened = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'create_dm',
      actorId: HONEYPOT_ACTOR,
      targetId: userId,

      // The attempt number is in the key on purpose. Without it a retry after a crash comes back a
      // bodiless duplicate for the whole dedupe window and the member is never reached.
      idempotencyKey: `${root}:dm-open:${attempts}`,
      dryRun: false,
      record: false,
      payload: { userId },
    });

    channelId = channelIdOf(opened);

    if (channelId === null) {
      ctx.logger.warn(
        `honeypot could not open a direct message with ${userId}: ${
          opened.failure?.humanReason ?? 'their direct messages are closed.'
        }`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
      );
      return 'closed';
    }

    await deps.dms?.remember(ctx.guildId, root, channelId);
  }

  const built = renderDirectMessage(ctx.config, tier, facts);

  const sent = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: HONEYPOT_ACTOR,
    targetId: userId,
    idempotencyKey: `${root}:dm-send`,
    dryRun: false,
    record: false,
    payload: {
      channelId,
      components: built.components,
      flags: built.flags,
      allowedMentions: { parse: [] },
    },
  });

  if (sent.status === 'executed' || sent.status === 'skipped_duplicate') return 'sent';

  ctx.logger.warn(
    `honeypot opened a direct message with ${userId} but could not send it: ${
      sent.failure?.humanReason ?? 'Discord gave no reason.'
    }`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
  );

  return 'failed';
}
