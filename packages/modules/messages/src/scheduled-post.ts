import { type DiscordMessageBody, toDiscordMessage } from '@proton/core';
import { z } from 'zod';
import { customIdFor } from './component-id.ts';
import { findTemplate, MODULE_ID, normaliseTemplateName, type SavedMessage } from './config.ts';
import { type MessagesContext, postMessage, succeeded } from './perform.ts';
import { followingRun } from './schedule.ts';

export const POST_JOB = 'post';

export const SCHEDULED_ACTOR = 'proton:schedule';

export const postDataSchema = z
  .object({
    templateName: z.string().min(1).optional(),

    // What the retired announcements module wrote. A row it booked is still sitting in
    // scheduled_actions carrying this key, and there is no run of the migration that can reach one
    // written after it — so this is read forever rather than migrated away.
    announcementId: z.string().min(1).optional(),

    // The run it was booked for, carried so a repeat gets a fresh idempotency key each time.
    // Without it every occurrence shares one key and the executor drops all but the first.
    runAt: z.iso.datetime({ offset: true }),
  })
  .transform((data) => ({
    templateName: data.templateName ?? data.announcementId ?? '',
    runAt: data.runAt,
  }))
  .refine((data) => data.templateName !== '', {
    message: 'the scheduled row names no template',
  });

export type PostData = z.infer<typeof postDataSchema>;

export function postKey(guildId: string, templateName: string, runAt: string): string {
  return `${MODULE_ID}:post:${guildId}:${normaliseTemplateName(templateName)}:${runAt}`;
}

export type PostOutcome =
  | { action: 'skipped'; reason: string }
  | { action: 'posted'; rescheduled: Date | null };

async function bookNext(
  ctx: MessagesContext,
  template: SavedMessage,
  firedAt: Date,
): Promise<Date | null> {
  const booked = template.schedule;
  if (!booked) return null;

  const next = followingRun(booked, firedAt);

  if (next.status === 'unreadable') {
    ctx.logger.error(
      `“${template.name}” posted but will not repeat: ${next.humanReason} Fix it in the Proton ` +
        'dashboard under Messages → Templates and save, which books it again.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, template: template.name },
    );
    return null;
  }

  if (next.status === 'passed') return null;

  if (typeof ctx.schedule !== 'function') {
    ctx.logger.error(
      `“${template.name}” posted but cannot repeat: this process has no scheduler, so the module ` +
        'context was built without `schedule`. The worker must be started with a scheduled-action ' +
        'store.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, template: template.name },
    );
    return null;
  }

  const outcome = await ctx.schedule(
    POST_JOB,
    next.runAt,
    normaliseTemplateName(template.name),
    { templateName: template.name, runAt: next.runAt.toISOString() },
    { replace: true },
  );

  if (!outcome.scheduled) {
    ctx.logger.error(
      `“${template.name}” posted but its next run was not booked — the scheduler already held a ` +
        'job under its key. It will be booked again the next time this server’s Messages ' +
        'settings are saved, or when the worker next starts.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, template: template.name },
    );
    return null;
  }

  return next.runAt;
}

// Discord documents `parse` as mutually exclusive with the explicit users/roles arrays — sending
// both is refused outright — so a ping role pins this message's mentions to exactly that role and
// nothing else pings, whatever the template's own mention policy says.
export function withPing(
  body: DiscordMessageBody,
  pingRoleId: string | undefined,
): DiscordMessageBody {
  if (!pingRoleId) return body;

  const mention = `<@&${pingRoleId}>`;

  // toDiscordMessage sets `flags` on the components-v2 branch and nowhere else. That message
  // carries no `content` at all, so the mention can only be written into the layout by hand — the
  // allowed-mentions entry still makes it ping when it is.
  const laidOut = body.flags !== undefined;

  return {
    ...body,
    ...(laidOut ? {} : { content: `${mention}\n${body.content ?? ''}`.trimEnd() }),
    allowedMentions: { parse: [], roles: [pingRoleId] },
  };
}

export async function runScheduledPost(
  data: unknown,
  ctx: MessagesContext,
  now: Date = new Date(),
): Promise<PostOutcome> {
  const parsed = postDataSchema.safeParse(data);
  if (!parsed.success) {
    ctx.logger.error(
      'a scheduled template carried data this build cannot read (' +
        parsed.error.issues.map((i) => `${i.path.map(String).join('.')} ${i.message}`).join('; ') +
        '), so nothing was posted and retrying would fail the same way. The row was written by a ' +
        'different build of this module — save the Messages settings once to rewrite it.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return { action: 'skipped', reason: 'the scheduled data could not be read' };
  }

  const template = findTemplate(ctx.config.templates, parsed.data.templateName);

  if (!template) {
    ctx.logger.info(
      `a schedule fired for the template '${parsed.data.templateName}', which this server no ` +
        'longer has, so nothing was posted and it will not fire again.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return { action: 'skipped', reason: 'that template is no longer configured' };
  }

  const booked = template.schedule;

  if (!booked) {
    ctx.logger.info(
      `“${template.name}” was due but no longer carries a schedule, so nothing was posted.`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, template: template.name },
    );
    return { action: 'skipped', reason: 'that template is no longer scheduled' };
  }

  if (!ctx.config.enabled || !booked.enabled) {
    ctx.logger.info(`“${template.name}” was due but is switched off, so nothing was posted.`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      template: template.name,
    });
    return { action: 'skipped', reason: 'that template is switched off' };
  }

  const result = await postMessage(ctx, {
    channelId: booked.channelId,
    body: withPing(
      toDiscordMessage(template, { customIdFor: customIdFor(template.name), now }),
      booked.pingRoleId,
    ),
    actorId: SCHEDULED_ACTOR,
    idempotencyRoot: postKey(ctx.guildId, template.name, parsed.data.runAt),
  });

  if (!succeeded(result)) {
    throw new Error(
      `the scheduled template “${template.name}” could not be posted in <#${booked.channelId}>: ` +
        `${result.failure?.humanReason ?? 'no reason was reported'}. Give Proton View Channel ` +
        'and Send Messages there, or point the schedule at a channel it can post in.',
    );
  }

  const rescheduled = booked.mode === 'repeat' ? await bookNext(ctx, template, now) : null;

  return { action: 'posted', rescheduled };
}
