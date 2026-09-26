import { applicationLifecycleSchema, type ProtonEvent } from '@proton/core';
import type { AchievementsDeps } from '../deps.ts';
import {
  activityRecord,
  type CollectorEngine,
  type Ctx,
  ENGINE,
  mismatchedGuild,
  organicCausation,
  submit,
  unreadable,
} from './common.ts';

export const APPLICATIONS_SOURCE = 'applications';

export async function collectApplicationAccepted(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  engine: CollectorEngine = ENGINE,
): Promise<void> {
  const parsed = applicationLifecycleSchema.safeParse(event.payload);
  if (!parsed.success) {
    unreadable(ctx, 'an accepted application', event.id, parsed.error.message);
    return;
  }

  const accepted = parsed.data;
  if (mismatchedGuild(ctx, accepted.guildId, 'an accepted application', event.id)) return;
  if (accepted.status !== 'accepted') return;

  // Keyed on the application alone: reopening and accepting it again must not count it twice.
  const record = activityRecord(ctx, {
    userId: accepted.applicantId,
    metric: 'applications_accepted',
    sourceKey: accepted.applicationId,
    occurredAt: accepted.occurredAt,
    sourceModule: APPLICATIONS_SOURCE,
    causation: organicCausation(event.id),
  });
  if (!record) return;

  await submit(ctx, deps, engine, { records: [record], originChannelId: null });
}
