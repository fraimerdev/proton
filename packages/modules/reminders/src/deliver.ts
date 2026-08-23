import type { ModuleContext } from '@proton/core';
import { z } from 'zod';
import { MODULE_ID, type RemindersConfig } from './config.ts';
import { bindStore, describeUnbound, type RemindersDeps } from './deps.ts';
import { mentionOnly } from './perform.ts';
import { renderDelivery } from './render.ts';

export const DELIVER_JOB = 'deliver';

export const deliverDataSchema = z.object({ reminderId: z.string().min(1) });

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
    throw new Error(
      `the reminder ${reminder.userId} set could not be posted in <#${reminder.channelId}>: ` +
        `${result.failure?.humanReason ?? 'no reason was reported'}`,
    );
  }

  await bound.store.markDelivered(ctx.guildId, reminder.id, new Date());
}
