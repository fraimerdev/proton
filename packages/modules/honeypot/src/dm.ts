import type { ActionFailure, ActionResult, EntitlementTier, ModuleContext } from '@proton/core';
import { appealLinkUrl, BUTTON_URL_MAX, newAppealLinkClaims, signAppealLink } from '@proton/core';
import { serverFactsFrom, type UserFacts } from '@proton/core/placeholders';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { HONEYPOT_ACTOR, type HoneypotConfig, MODULE_ID } from './config.ts';
import {
  describeUnbound,
  type HoneypotDeps,
  placeholderClock,
  readBotFacts,
  readGuildState,
} from './deps.ts';
import { usesNamespace } from './placeholders.ts';
import { type DmFacts, dmPlaceholderKeys, renderDirectMessage } from './render.ts';
import { DM_ATTEMPTS_MAX } from './store.ts';

export type DmOutcome =
  | 'sent'
  | 'closed'
  | 'unshared'
  | 'unconfirmed'
  | 'failed'
  | 'skipped'
  | 'gave_up';

type Undelivered = 'closed' | 'unshared' | 'unconfirmed' | 'failed';

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

async function profileFor(
  ctx: ModuleContext<HoneypotConfig>,
  deps: HoneypotDeps,
  userId: string,
  keys: ReadonlySet<string>,
): Promise<UserFacts | null> {
  const profiled = [...keys].some(
    (key) => key.startsWith('user.') && key !== 'user.id' && key !== 'user.mention',
  );

  if (!profiled || !deps.placeholders) {
    return { id: userId, username: null, globalName: null, avatarHash: null };
  }

  try {
    return await deps.placeholders.user(userId);
  } catch (error) {
    ctx.logger.warn(
      `honeypot could not read ${userId}'s profile, so their name renders as nothing in the ` +
        `direct message: ${error instanceof Error ? error.message : String(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
    );
    return null;
  }
}

export async function directMessageFacts(
  ctx: ModuleContext<HoneypotConfig>,
  deps: HoneypotDeps,
  userId: string,
): Promise<DmFacts> {
  const state = await readGuildState(ctx, deps);
  const guildName = state?.name ?? (await deps.guildName?.(ctx.guildId)) ?? 'this server';
  if (!ctx.config.sendDirectMessage) return { guildName };

  const keys = dmPlaceholderKeys(ctx.config, ctx.tier);

  return {
    guildName,
    user: await profileFor(ctx, deps, userId, keys),
    server: usesNamespace(keys, 'server') ? serverFactsFrom(state, ctx.guildId) : null,
    bot: usesNamespace(keys, 'bot') ? await readBotFacts(ctx, deps) : null,
  };
}

export const DM_RESULT_LABEL: Record<DmOutcome, string> = {
  sent: 'Sent before the action.',
  closed: 'Not sent: their DMs are closed.',
  unshared: 'Not sent: they no longer share a server with Proton.',
  unconfirmed: 'May not have arrived: Proton couldn’t reach Discord.',
  failed: 'Not sent: Discord refused the DM.',
  skipped: 'Not sent: the DM is off in this server.',
  gave_up: 'Not sent: gave up after several attempts.',
};

function channelIdOf(result: ActionResult): string | null {
  const id = (result.body as { id?: unknown } | undefined)?.id;

  return typeof id === 'string' ? id : null;
}

function undelivered(failure: ActionFailure | undefined): Undelivered {
  const code = failure?.discordCode;

  if (code === RESTJSONErrorCodes.CannotSendMessagesToThisUser) return 'closed';
  if (code === RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds) {
    return 'unshared';
  }
  if (code === undefined && failure?.code === 'discord_403') return 'closed';
  if (failure?.code === 'transport_failure' || /^discord_5\d\d$/.test(failure?.code ?? '')) {
    return 'unconfirmed';
  }

  return 'failed';
}

function reasonFor(outcome: Undelivered, failure: ActionFailure | undefined): string {
  switch (outcome) {
    case 'closed':
      return 'their direct messages are closed.';
    case 'unshared':
      return 'they no longer share a server with Proton.';
    case 'unconfirmed':
      return 'Proton could not reach Discord.';
    case 'failed':
      return failure?.humanReason ?? 'Discord gave no reason.';
  }
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
      const outcome = undelivered(opened.failure);
      ctx.logger.warn(
        `honeypot could not open a direct message with ${userId}: ${reasonFor(outcome, opened.failure)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
      );
      return outcome;
    }

    await deps.dms?.remember(ctx.guildId, root, channelId);
  }

  const now = placeholderClock(deps);
  let built = renderDirectMessage(ctx.config, tier, facts, now);

  if (!built.ok && (tier ?? 'free') !== 'free') {
    ctx.logger.error(
      `honeypot could not fill in this server's own direct message for ${userId}, so it sent ` +
        `Proton's built-in one instead: ${built.humanReason}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
    );
    built = renderDirectMessage(ctx.config, 'free', facts, now);
  }

  if (!built.ok) {
    ctx.logger.error(
      `honeypot opened a direct message with ${userId} but could not write it: ${built.humanReason}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
    );
    return 'failed';
  }

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
      directMessage: true,
    },
  });

  if (sent.status === 'executed' || sent.status === 'skipped_duplicate') return 'sent';

  const outcome = undelivered(sent.failure);
  ctx.logger.warn(
    outcome === 'unconfirmed'
      ? `honeypot sent a direct message to ${userId} but cannot tell whether it arrived: ` +
          'Proton could not reach Discord.'
      : `honeypot could not tell ${userId}: ${reasonFor(outcome, sent.failure)}`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
  );

  return outcome;
}
