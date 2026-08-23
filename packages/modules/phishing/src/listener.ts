import {
  type EventListener,
  type EventType,
  formatDuration,
  MAX_TIMEOUT_MS,
  type ModuleContext,
  tryParseDuration,
} from '@proton/core';
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
      await act(key, message.authorId, verdict, ctx);
      await alert(key, message, verdict, ctx);
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
): Promise<void> {
  const kind = ctx.config.action;
  if (kind === 'none') return;

  const reason = `Posted a link to ${verdict.domain}, listed on Proton's phishing blocklist.`;

  const payload = buildPayload(kind, authorId, ctx.config);
  if (payload === null) {
    ctx.logger.error(
      `phishing could not act on ${authorId}: '${ctx.config.timeoutDuration}' is not a ` +
        'readable timeout length. Fix the Timeout length setting in the Proton dashboard.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind,

    actorId: MODULE_ID,
    targetId: authorId,
    reason,
    payload,
    dryRun: false,

    idempotencyKey: `${key}:action`,
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.error(
      `phishing detected a link to ${verdict.domain} but could not ${kind} ${authorId}: ` +
        `${result.failure?.humanReason ?? 'no reason was reported'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
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
      return { userId, deleteMessageSeconds: 24 * 60 * 60 };
  }
}

async function alert(
  key: string,
  message: { channelId: string; messageId: string; authorId: string },
  verdict: Extract<PhishingVerdict, { matched: true }>,
  ctx: ModuleContext<PhishingConfig>,
): Promise<void> {
  const channelId = ctx.config.alertChannel;
  if (!channelId) return;

  const listed =
    verdict.source === 'server-list'
      ? "this server's own blocked-domains list"
      : 'the community phishing blocklist';

  const taken =
    ctx.config.action === 'none'
      ? 'No action was taken — the Action setting is None.'
      : `Action: ${describeAction(ctx.config)}.`;

  const content =
    `Phishing link detected in <#${message.channelId}>.\n` +
    `Author: <@${message.authorId}>\n` +
    `Link host: \`${verdict.host}\`, matching \`${verdict.domain}\` on ${listed}.\n` +
    `Message: https://discord.com/channels/${ctx.guildId}/${message.channelId}/${message.messageId} ` +
    '— still up; delete it manually.\n' +
    `${taken} If this was wrong, add \`${verdict.domain}\` to Never blocked in the Proton ` +
    'dashboard.';

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: MODULE_ID,

    dryRun: false,
    idempotencyKey: `${key}:alert`,
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
