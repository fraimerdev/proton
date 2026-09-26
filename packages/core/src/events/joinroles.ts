import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';

export const JOINROLES_RUN_KINDS = ['sync', 'count'] as const;

export type JoinrolesRunKind = (typeof JOINROLES_RUN_KINDS)[number];

export const joinrolesSyncRequestedSchema = z.object({
  auditId: z.string().min(1),
  guildId: snowflakeSchema,
  runId: z.string().min(1).max(64),
  kind: z.enum(JOINROLES_RUN_KINDS),
  actorId: snowflakeSchema,
});

export type JoinrolesSyncRequested = z.infer<typeof joinrolesSyncRequestedSchema>;
