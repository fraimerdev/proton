import {
  dryRunFor,
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

/**
 * Edits are watched as well as new messages.
 *
 * Posting something harmless and editing a scam link into it thirty seconds
 * later is the oldest way past a create-only filter, and Discord raises
 * MESSAGE_UPDATE for it with the new content attached.
 */
export const PHISHING_EVENT_TYPES: EventType[] = ['message.created', 'message.updated'];

/**
 * The message-scanning listener.
 *
 * The shape of this handler is dictated by one requirement above all others: a
 * blocklist that is empty, stale or unreachable must cost the guild its phishing
 * protection and nothing else. So every failure path below returns rather than
 * throws — a throw would leave the event unacknowledged, the bus would redeliver
 * it, and a Redis hiccup would turn into a message-processing outage for every
 * module downstream. That is the opposite of the trade this module exists to
 * make, and it is a deliberate departure from `ModuleRuntime`'s general rule
 * that a throwing handler is the correct way to ask for redelivery.
 */
export function createPhishingListener(deps: PhishingDeps): EventListener<PhishingConfig> {
  return {
    types: PHISHING_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;
      // A DM has no guild, no moderators and no config that applies.
      if (event.guildId === null) return;

      const message = readMessage(event.payload);
      if (message === null) return;

      const bound = bindDeps(deps);

      // Proton's own alert names the domain that matched, so without this the
      // module would match its own alert and loop. Checked before anything else
      // reads the content, and before the unbound warning below, which would
      // otherwise fire on Proton's own messages.
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

      /**
       * Keyed by the **message**, not by the event.
       *
       * This module watches `message.created` and `message.updated`, and the
       * normaliser gives those different ids by construction — they have to
       * differ, or an edit would dedupe against the post it edits and never be
       * checked. But Discord also raises MESSAGE_UPDATE for its own embed
       * resolution, and per the gateway reference that dispatch carries "a
       * message object with the same extra fields as MESSAGE_CREATE" — the full
       * object, original content included. A message containing a link is, by
       * definition, a message Discord will unfurl. So keying on the event id
       * means one scam link produces a create event and an embed-resolution
       * update event, two different keys, and the author is actioned twice: the
       * double-ban class I4 calls catastrophic.
       *
       * The fact being deduped is "Proton acted on this message", so the message
       * id is the key. Every later edit of the same message dedupes against the
       * first action, which is the intended reading: one message, one penalty.
       */
      const key = `${MODULE_ID}:${ctx.guildId}:${message.messageId}`;
      await act(key, message.authorId, verdict, ctx);
      await alert(key, message, verdict, ctx);
    },
  };
}

/**
 * Run the check, or explain why it could not run.
 *
 * The unbound warning is raised here — after a host has been found — rather than
 * on every message. A guild with the module enabled receives thousands of
 * messages an hour and almost none of them contain a link; logging an error for
 * each would bury the one line that matters under noise nobody reads, which is
 * the same outcome as not logging at all.
 */
async function inspect(
  bound: ReturnType<typeof bindDeps>,
  message: InspectedMessage,
  ctx: ModuleContext<PhishingConfig>,
): Promise<PhishingVerdict | null> {
  if ('unbound' in bound) {
    // Only worth saying when there was something to check.
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
    // The blocklist cache is unreachable. Degrade to "no blocklist" and keep
    // handling messages — see the note on `createPhishingListener`.
    ctx.logger.error(
      `phishing blocklist could not be read, so this message was not checked: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return null;
  }
}

/** The action against the author, if the guild asked for one. */
async function act(
  /** The per-message idempotency root — see the note at the call site. */
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
    // The rule engine attributes automatic actions to itself; this module is the
    // actor for its own, so the case ledger says what actually decided.
    actorId: MODULE_ID,
    targetId: authorId,
    reason,
    payload,
    dryRun: dryRunFor(kind),
    // Rooted on the message, so a redelivery, an edit and Discord's own
    // embed-resolution update all ban once (I4). Suffixed so it dedupes against
    // this action rather than against the alert below.
    idempotencyKey: `${key}:action`,
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    // I8's whole point: the executor already knows which permission is missing
    // and where, so it is repeated verbatim rather than paraphrased into "the
    // action failed".
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
      // Discord rejects anything past 28 days outright, which would turn a
      // misconfigured length into no timeout at all rather than a long one.
      const until = new Date(Date.now() + Math.min(ms, MAX_TIMEOUT_MS));
      // No `expiresAt`: Discord lifts a timeout itself, so a scheduled reversal
      // would queue an untimeout for a member who is already free.
      return { userId, until };
    }
    case 'kick':
      return { userId };
    case 'ban':
      // One day of message history, so the rest of the spam run goes with the
      // ban. Not configurable: a guild that wants finer control over deletion
      // has /ban, and one more knob here buys nothing.
      return { userId, deleteMessageSeconds: 24 * 60 * 60 };
  }
}

/** The staff notice, if a channel is configured. */
async function alert(
  /** The per-message idempotency root — see the note at the call site. */
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

  // "Detected", never "removed". Proton cannot delete the message — there is no
  // single-message delete in `ACTION_KINDS` (see the blocker on
  // `createPhishingModule`) — and an alert claiming otherwise would have staff
  // scroll past a live scam link believing it was already gone.
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
    // Never dry-run. I12 withholds a destructive effect, not the explanation of
    // what was detected — an alert suppressed in development is a module nobody
    // can see working.
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
