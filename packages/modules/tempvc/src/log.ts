import type { ModuleContext } from '@proton/core';
import { MODULE_ID, type TempVcConfig } from './config.ts';

/**
 * What a server admin can be told happened. Deliberately a small closed set rather than a general
 * logger: these go to a channel humans read, and every one of them is something somebody might have
 * to explain later.
 */
export const TEMP_VOICE_EVENTS = [
  'created',
  'deleted',
  'renamed',
  'limit_changed',
  'privacy_changed',
  'trusted',
  'untrusted',
  'blocked',
  'unblocked',
  'kicked',
  'transferred',
  'claimed',
  'reconciled',
  'error',
] as const;

export type TempVoiceEvent = (typeof TEMP_VOICE_EVENTS)[number];

const HEADINGS: Record<TempVoiceEvent, string> = {
  created: 'Channel created',
  deleted: 'Channel deleted',
  renamed: 'Renamed',
  limit_changed: 'Member limit changed',
  privacy_changed: 'Privacy changed',
  trusted: 'Member trusted',
  untrusted: 'Trust removed',
  blocked: 'Member blocked',
  unblocked: 'Block lifted',
  kicked: 'Member disconnected',
  transferred: 'Ownership transferred',
  claimed: 'Ownership claimed',
  reconciled: 'Reconciled after a restart',
  error: 'Something went wrong',
};

export interface LogFields {
  channelId?: string | null | undefined;
  actorId?: string | null | undefined;
  targetId?: string | null | undefined;

  detail?: string | undefined;
}

export function renderLogLine(event: TempVoiceEvent, fields: LogFields): string {
  const parts = [`**${HEADINGS[event]}**`];

  if (fields.channelId) parts.push(`<#${fields.channelId}>`);
  if (fields.actorId) parts.push(`by <@${fields.actorId}>`);
  if (fields.targetId) parts.push(`→ <@${fields.targetId}>`);
  if (fields.detail) parts.push(`— ${fields.detail}`);

  return `🔊 ${parts.join(' · ')}`.slice(0, 2000);
}

/**
 * Posts one line to the configured log channel. Silent when logging is off or no channel is set,
 * and never allowed to fail the action it is reporting — a log that cannot be written is worth a
 * warning in the process log, not an aborted channel deletion.
 */
export async function logTempVoice(
  ctx: ModuleContext<TempVcConfig>,
  event: TempVoiceEvent,
  fields: LogFields = {},
): Promise<void> {
  if (!ctx.config.loggingEnabled) return;

  const channelId = ctx.config.logChannelId;
  if (!channelId) return;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: MODULE_ID,
    reason: `temporary voice: ${event}`,
    // The reported channel and the event name, so a redelivered voice event does not double-post
    // while two genuinely different events on one channel still both land.
    idempotencyKey: `${MODULE_ID}:log:${event}:${fields.channelId ?? 'none'}:${fields.targetId ?? fields.actorId ?? 'none'}`,
    dryRun: false,
    record: false,
    payload: {
      channelId,
      content: renderLogLine(event, fields),
      allowedMentions: { parse: [] },
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `a temporary voice event could not be logged to <#${channelId}>: ${
        result.failure?.humanReason ?? 'unknown reason'
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, event },
    );
  }
}
