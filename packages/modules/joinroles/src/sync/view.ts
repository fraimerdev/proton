import { JOINROLES_RUN_KINDS, snowflakeSchema } from '@proton/core';
import { z } from 'zod';
import type { JoinrolesConfig } from '../config.ts';

export const SYNC_TRIGGERS = ['dashboard', 'schedule'] as const;

export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const SYNC_RUN_STATES = ['queued', 'running'] as const;

export const SYNC_OUTCOMES = ['done', 'failed', 'stopped'] as const;

export type SyncOutcome = (typeof SYNC_OUTCOMES)[number];

export const SKIP_REASONS = ['excluded', 'pending', 'outranks', 'owner', 'left', 'failed'] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

export const GRANT_REFUSAL_CODES = ['everyone', 'missing', 'managed', 'above_proton'] as const;

export type GrantRefusalCode = (typeof GRANT_REFUSAL_CODES)[number];

export const COUNT_COOLDOWN_MS = 10 * 60_000;

// Past run.ts's longest retry wait (15 s × 2⁴) plus a slow batch, or a live run gets replaced.
export const SYNC_STALE_MS = 10 * 60_000;

const tally = z.number().int().nonnegative();
const instant = z.number().int().nonnegative();

export const skipCountsSchema = z.object({
  excluded: tally.default(0),
  pending: tally.default(0),
  outranks: tally.default(0),
  owner: tally.default(0),
  left: tally.default(0),
  failed: tally.default(0),
} satisfies Record<SkipReason, z.ZodType>);

export type SkipCounts = z.infer<typeof skipCountsSchema>;

export const blockedRoleSchema = z.object({
  roleId: snowflakeSchema,
  code: z.enum(GRANT_REFUSAL_CODES),
});

export type BlockedRole = z.infer<typeof blockedRoleSchema>;

export const syncFailureSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(1000),
  roleId: snowflakeSchema.optional(),
});

export type SyncFailure = z.infer<typeof syncFailureSchema>;

export const syncRunSchema = z.object({
  runId: z.string().min(1).max(64),
  guildId: snowflakeSchema,
  kind: z.enum(JOINROLES_RUN_KINDS),
  trigger: z.enum(SYNC_TRIGGERS),
  actorId: snowflakeSchema.nullable(),
  state: z.enum(SYNC_RUN_STATES),

  after: z.string().regex(/^\d{1,20}$/),
  total: tally.optional(),
  processed: tally,
  updated: tally,
  missing: tally,
  skipped: skipCountsSchema,
  blockedRoles: z.array(blockedRoleSchema).max(40).default([]),
  failures: tally.default(0),

  queuedAt: instant,
  startedAt: instant.optional(),
  heartbeatAt: instant,
});

export type SyncRun = z.infer<typeof syncRunSchema>;

export const syncRunViewSchema = syncRunSchema.omit({ after: true, failures: true });

export type SyncRunView = z.infer<typeof syncRunViewSchema>;

export const lastSyncSchema = z.object({
  runId: z.string().min(1).max(64),
  trigger: z.enum(SYNC_TRIGGERS),
  outcome: z.enum(SYNC_OUTCOMES),
  failure: syncFailureSchema.nullable(),
  processed: tally,
  updated: tally,
  skipped: skipCountsSchema,
  blockedRoles: z.array(blockedRoleSchema).max(40).default([]),
  startedAt: instant,
  finishedAt: instant,
});

export type LastSync = z.infer<typeof lastSyncSchema>;

export const syncEstimateSchema = z.object({
  missing: tally,
  pending: tally,
  scanned: tally,
  countedAt: instant,
  source: z.enum(['count', 'sync']),
  fingerprint: z.string().max(2000),
  failure: syncFailureSchema.nullable(),
});

export type SyncEstimate = z.infer<typeof syncEstimateSchema>;

export const syncStatusSchema = z.object({
  run: syncRunViewSchema.nullable(),
  last: lastSyncSchema.nullable(),
  estimate: syncEstimateSchema.extend({ stale: z.boolean() }).nullable(),
  nextCountAt: instant.nullable(),
  now: instant,
});

export type JoinRolesSyncStatus = z.infer<typeof syncStatusSchema>;

export const syncStartResultSchema = z.object({
  runId: z.string().min(1).max(64),
  kind: z.enum(JOINROLES_RUN_KINDS),
});

export type SyncStartResult = z.infer<typeof syncStartResultSchema>;

export function queuedRun(input: {
  runId: string;
  guildId: string;
  kind: SyncRun['kind'];
  trigger: SyncTrigger;
  actorId: string | null;
  now: number;
}): SyncRun {
  return {
    runId: input.runId,
    guildId: input.guildId,
    kind: input.kind,
    trigger: input.trigger,
    actorId: input.actorId,
    state: 'queued',
    after: '0',
    processed: 0,
    updated: 0,
    missing: 0,
    skipped: emptySkipCounts(),
    blockedRoles: [],
    failures: 0,
    queuedAt: input.now,
    heartbeatAt: input.now,
  };
}

export function syncRunView(run: SyncRun): SyncRunView {
  const { after: _after, failures: _failures, ...view } = run;
  return view;
}

export function isStaleRun(run: Pick<SyncRun, 'heartbeatAt'>, now: number): boolean {
  return now - run.heartbeatAt >= SYNC_STALE_MS;
}

export function emptySkipCounts(): SkipCounts {
  return { excluded: 0, pending: 0, outranks: 0, owner: 0, left: 0, failed: 0 };
}

type FingerprintInput = Pick<
  JoinrolesConfig,
  | 'memberRoleIds'
  | 'botRoleIds'
  | 'syncExcludeEnabled'
  | 'syncExcludeRoleIds'
  | 'grantWhenScreeningPasses'
>;

export function syncFingerprint(config: FingerprintInput): string {
  const sorted = (ids: readonly string[]) => [...new Set(ids)].sort().join(',');

  return [
    `m:${sorted(config.memberRoleIds)}`,
    `b:${sorted(config.botRoleIds)}`,
    `x:${config.syncExcludeEnabled ? sorted(config.syncExcludeRoleIds) : ''}`,
    `s:${config.grantWhenScreeningPasses ? 1 : 0}`,
  ].join('|');
}
