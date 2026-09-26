import type { ActionFailure, ModuleContext } from '@proton/core';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { z } from 'zod';
import { MODULE_ID, type RemindersConfig } from './config.ts';
import { bindStore, describeUnbound, type RemindersDeps } from './deps.ts';
import { mentionOnly } from './perform.ts';
import { renderDelivery } from './render.ts';

export const DELIVER_JOB = 'deliver';

export const deliverDataSchema = z.object({ reminderId: z.string().min(1) });

function refusedBecause(failure: ActionFailure | undefined, channelId: string): string | null {
  const code = failure?.discordCode;
  const gone = `Discord says <#${channelId}> no longer exists, so there is nowhere to post it.`;
  const keepsFailing = 'Reminders set in that channel keep failing until Proton can post there.';

  switch (code) {
    case RESTJSONErrorCodes.UnknownChannel:
      return gone;
    case RESTJSONErrorCodes.MissingAccess:
      return `Discord says Proton cannot see <#${channelId}>; it needs View Channel there. ${keepsFailing}`;
    case RESTJSONErrorCodes.MissingPermissions:
      return (
        `Discord says Proton is missing a permission to post in <#${channelId}>, most likely Send ` +
        'Messages (Send Messages in Threads, if it is a thread), which a channel overwrite can ' +
        `deny. ${keepsFailing}`
      );
    case RESTJSONErrorCodes.ThreadLocked:
    case RESTJSONErrorCodes.InvalidActionOnArchivedThread:
      return `Discord says <#${channelId}> is a locked or archived thread, so Proton cannot post in it.`;
  }

  switch (failure?.code) {
    case 'discord_404':
      return code === undefined
        ? gone
        : `Discord answered 404 (code ${code}) when Proton tried to post in <#${channelId}>.`;
    case 'discord_403':
      return `Discord refused to post in <#${channelId}> (403${code === undefined ? '' : `, code ${code}`}).`;
    default:
      return null;
  }
}

export async function deliverReminder(
  data: unknown,
  ctx: ModuleContext<RemindersConfig>,
  deps: RemindersDeps,
): Promise<void> {
  const parsed = deliverDataSchema.safeParse(data);
  if (!parsed.success) {
    ctx.logger.error(
      'a scheduled reminder carried data this build cannot read (' +
        `${parsed.error.issues.map((i) => `${i.path.map(String).join('.')} ${i.message}`).join('; ')}` +
        '), so nobody was reminded and retrying would fail the same way. The row was written by ' +
        'a different build of this module — cancel it, or run a worker that matches it.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  const bound = bindStore(deps);
  if ('unbound' in bound) {
    throw new Error(describeUnbound('a due reminder could not be read', bound.unbound));
  }

  const reminder = await bound.store.get(ctx.guildId, parsed.data.reminderId);

  // Redelivery is expected — the sweep runs at least once per row (I4) — so a reminder that was
  // cancelled or already stamped is a no-op here rather than a second ping.
  if (!reminder || reminder.deliveredAt !== null) return;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: reminder.userId,
    idempotencyKey: `${MODULE_ID}:deliver:${reminder.id}`,
    dryRun: false,
    record: false,
    payload: {
      channelId: reminder.channelId,
      content: renderDelivery(reminder.userId, reminder.content),
      allowedMentions: mentionOnly(reminder.userId),
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    const refused = refusedBecause(result.failure, reminder.channelId);
    if (refused !== null) {
      await bound.store.remove(ctx.guildId, reminder.id, reminder.userId);
      ctx.logger.warn(
        `a reminder ${reminder.userId} set was dropped without being posted: ${refused} ` +
          'Discord would refuse a retry the same way, so it was not retried and nobody was told.',
        {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
          reminderId: reminder.id,
          code: result.failure?.code,
          discordCode: result.failure?.discordCode,
          reason: result.failure?.humanReason,
        },
      );
      return;
    }

    throw new Error(
      `the reminder ${reminder.userId} set could not be posted in <#${reminder.channelId}>: ` +
        `${result.failure?.humanReason ?? 'no reason was reported'}`,
    );
  }

  await bound.store.markDelivered(ctx.guildId, reminder.id, new Date());
}
