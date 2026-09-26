import {
  type ActionRequest,
  type ActionResult,
  type EventListener,
  type EventType,
  formatDuration,
  MAX_TIMEOUT_MS,
  type ModuleContext,
  snowflakeCreatedAt,
  tryParseDuration,
} from '@proton/core';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import type { PhishingConfig } from './config.ts';
import { bindDeps, describeUnbound, type PhishingDeps } from './deps.ts';
import {
  type InspectedMessage,
  inspectMessage,
  type PhishingVerdict,
  readMessage,
} from './detect.ts';

export const MODULE_ID = 'phishing';

export const PHISHING_EVENT_TYPES: EventType[] = ['message.created', 'message.updated'];

const BAN_DELETES_SECONDS = 24 * 60 * 60;

const BAN_BY_HAND = "If they're not on the ban list, ban them by hand so they can't rejoin.";

export function createPhishingListener(deps: PhishingDeps): EventListener<PhishingConfig> {
  return {
    types: PHISHING_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      if (event.guildId === null) return;

      const message = readMessage(event.payload);
      if (message === null) return;

      const bound = bindDeps(deps);

      if ('deps' in bound && message.authorId === bound.deps.botUserId) return;

      const verdict = await inspect(bound, message, ctx);
      if (verdict === null || !verdict.matched) return;

      ctx.logger.warn(
        `phishing link posted in ${ctx.guildId}: ${verdict.host} matched ` +
          `${verdict.domain} on the ${verdict.source}`,
        {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
          channelId: message.channelId,
          authorId: message.authorId,
          messageId: message.messageId,
          domain: verdict.domain,
        },
      );

      const key = `${MODULE_ID}:${ctx.guildId}:${message.messageId}`;
      const outcome = await act(key, message.authorId, verdict, ctx);
      await alert(key, message, verdict, outcome, ctx);
    },
  };
}

async function inspect(
  bound: ReturnType<typeof bindDeps>,
  message: InspectedMessage,
  ctx: ModuleContext<PhishingConfig>,
): Promise<PhishingVerdict | null> {
  if ('unbound' in bound) {
    if (!/[a-z0-9-]\.[a-z]{2,}/i.test(message.content)) return null;
    ctx.logger.error(describeUnbound(bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return null;
  }

  try {
    return await inspectMessage(message, ctx.config, (candidates) =>
      bound.deps.blocklist.lookup(candidates),
    );
  } catch (error) {
    ctx.logger.error(
      `phishing blocklist could not be read, so this message was not checked: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return null;
  }
}

async function act(
  key: string,
  authorId: string,
  verdict: Extract<PhishingVerdict, { matched: true }>,
  ctx: ModuleContext<PhishingConfig>,
): Promise<ActionResult | null> {
  const kind = ctx.config.action;
  if (kind === 'none') return null;

  const reason = `Posted a link to ${verdict.domain}, a blocked phishing domain.`;

  const payload = buildPayload(kind, authorId, ctx.config);
  if (payload === null) {
    const humanReason =
      `'${ctx.config.timeoutDuration}' isn't a valid timeout duration. Fix the Timeout ` +
      'duration setting in the Proton dashboard.';
    ctx.logger.error(`phishing could not act on ${authorId}: ${humanReason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { status: 'failed_precheck', failure: { code: 'invalid_duration', humanReason } };
  }

  const request: ActionRequest = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind,

    actorId: MODULE_ID,
    targetId: authorId,
    reason,
    payload,
    dryRun: false,

    idempotencyKey: `${key}:action`,
  };

  const result = await ctx.executor.execute(request);

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    const said = result.failure?.humanReason ?? 'no reason was reported';
    const meta = { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code };
    const failure = classifyFailure(kind, result);

    if (failure === 'gone') {
      ctx.logger.warn(
        `phishing detected a link to ${verdict.domain} but ${authorId} is no longer in the ` +
          `server, so the ${kind} may already have gone through or they left first: ${said}`,
        meta,
      );
    } else if (failure === 'unconfirmed') {
      ctx.logger.warn(
        `phishing detected a link to ${verdict.domain} but could not confirm ${authorId} is ` +
          `still in the server, so the ${kind} may already have gone through: ${said}`,
        meta,
      );
    } else {
      ctx.logger.error(
        `phishing detected a link to ${verdict.domain} but could not ${kind} ${authorId}: ${said}`,
        meta,
      );
    }
  }

  return result;
}

function buildPayload(
  kind: 'timeout' | 'kick' | 'ban',
  userId: string,
  config: PhishingConfig,
): Record<string, unknown> | null {
  switch (kind) {
    case 'timeout': {
      const ms = tryParseDuration(config.timeoutDuration);
      if (ms === null || ms <= 0) return null;

      const until = new Date(Date.now() + Math.min(ms, MAX_TIMEOUT_MS));

      return { userId, until };
    }
    case 'kick':
      return { userId };
    case 'ban':
      return { userId, deleteMessageSeconds: BAN_DELETES_SECONDS };
  }
}

async function alert(
  key: string,
  message: { channelId: string; messageId: string; authorId: string },
  verdict: Extract<PhishingVerdict, { matched: true }>,
  outcome: ActionResult | null,
  ctx: ModuleContext<PhishingConfig>,
): Promise<void> {
  const channelId = ctx.config.alertChannel;
  if (!channelId) return;

  const listed =
    verdict.source === 'server-list'
      ? "this server's Extra blocked domains"
      : 'the community phishing blocklist';

  const taken = describeOutcome(ctx.config, outcome);

  const content =
    `Phishing link detected in <#${message.channelId}>.\n` +
    `Author: <@${message.authorId}>\n` +
    `Link host: \`${verdict.host}\`, matching \`${verdict.domain}\` on ${listed}.\n` +
    `Message: https://discord.com/channels/${ctx.guildId}/${message.channelId}/${message.messageId} ` +
    `${describeMessage(ctx.config.action, outcome, message.messageId)}\n` +
    `${taken} If the link is safe, add \`${verdict.domain}\` to Allowed domains in the Proton ` +
    'dashboard.';

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: MODULE_ID,

    dryRun: false,
    // Split by outcome: under one key, a redelivery whose retry succeeds could not correct the alert.
    idempotencyKey:
      outcome === null || tookEffect(outcome) ? `${key}:alert` : `${key}:alert:not-taken`,
    payload: { channelId, content: content.slice(0, 2000) },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.error(
      `phishing could not post its alert to ${channelId}: ` +
        `${result.failure?.humanReason ?? 'no reason was reported'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

function tookEffect(result: ActionResult): boolean {
  return result.status === 'executed' || result.status === 'skipped_duplicate';
}

function describeOutcome(config: PhishingConfig, result: ActionResult | null): string {
  if (result === null) return 'No action was taken because the Action setting is Log only.';

  switch (result.status) {
    // A duplicate is a success: the executor releases its claim whenever the call fails.
    case 'skipped_duplicate':
    case 'executed':
      return `Action: ${describeAction(config)}.`;
    case 'dry_run':
      return `No action was taken because the ${config.action} was only a dry run.`;
    case 'failed_precheck':
    case 'failed_api':
      return describeFailure(config.action, result);
  }
}

function describeMessage(
  action: PhishingConfig['action'],
  outcome: ActionResult | null,
  messageId: string,
): string {
  const stillUp = '(still up, so delete it by hand)';
  if (action !== 'ban' || outcome === null) return stillUp;

  const createdAt = snowflakeCreatedAt(messageId);
  if (createdAt === null || Date.now() - createdAt >= BAN_DELETES_SECONDS * 1000) return stillUp;

  if (tookEffect(outcome)) {
    return '(Discord deletes it with the ban, along with their other messages from the last 24 hours)';
  }

  const failed = outcome.status === 'failed_precheck' || outcome.status === 'failed_api';
  return failed && classifyFailure(action, outcome) !== 'refused'
    ? '(deleted if the ban went through; if not, delete it by hand)'
    : stillUp;
}

function describeFailure(action: PhishingConfig['action'], result: ActionResult): string {
  switch (classifyFailure(action, result)) {
    case 'unconfirmed': {
      const unconfirmed =
        `Couldn't confirm they're still in this server. The ${action} may already have gone ` +
        "through, they may have left or been removed, or Discord couldn't be reached to check.";
      return action === 'ban'
        ? `${unconfirmed} ${BAN_BY_HAND}`
        : `${unconfirmed} If they're still here, ${action} them by hand.`;
    }
    case 'gone': {
      const gone =
        `Discord says they're no longer in this server, so either the ${action} already went ` +
        'through, or they left or were removed first.';
      return action === 'ban' ? `${gone} ${BAN_BY_HAND}` : gone;
    }
    case 'rate_limited':
      return (
        `It's unclear whether the ${action} went through, because Discord was rate limiting ` +
        "Proton at the time. Check, and take the action by hand if it didn't apply."
      );
    case 'refused':
      return `No action was taken because the ${action} failed. ${reasonOf(result)}`;
    case 'unclear':
      return `It's unclear whether the ${action} went through. ${reasonOf(result)}`;
  }
}

function reasonOf(result: ActionResult): string {
  return result.failure?.humanReason ?? 'No reason was reported.';
}

function classifyFailure(
  action: PhishingConfig['action'],
  result: ActionResult,
): 'unconfirmed' | 'gone' | 'rate_limited' | 'refused' | 'unclear' {
  const code = result.failure?.code;

  const removes = action === 'kick' || action === 'ban';

  // Not a refusal: the lookup fails alike after a kick or ban that landed and while Discord is down.
  if (removes && code === 'target_state_unavailable') return 'unconfirmed';
  if (removes && code === 'target_not_member') return 'gone';
  // @discordjs/rest retries a timed-out DELETE, so a kick that landed can still come back 404.
  if (action === 'kick' && code === 'discord_404') {
    const discordCode = result.failure?.discordCode;
    if (discordCode === undefined) return 'unclear';
    if (
      discordCode === RESTJSONErrorCodes.UnknownMember ||
      discordCode === RESTJSONErrorCodes.UnknownUser
    ) {
      return 'gone';
    }
  }
  if (code === 'discord_429') return 'rate_limited';

  return refused(result) ? 'refused' : 'unclear';
}

function refused(result: ActionResult): boolean {
  if (result.status === 'failed_precheck') return true;

  const status = Number(/^discord_(\d{3})$/.exec(result.failure?.code ?? '')?.[1]);
  return status >= 400 && status < 500;
}

function describeAction(config: PhishingConfig): string {
  switch (config.action) {
    case 'timeout': {
      const ms = tryParseDuration(config.timeoutDuration);
      return ms === null
        ? 'timed out'
        : `timed out for ${formatDuration(Math.min(ms, MAX_TIMEOUT_MS))}`;
    }
    case 'kick':
      return 'kicked';
    case 'ban':
      return 'banned';
    case 'none':
      return 'none';
  }
}
