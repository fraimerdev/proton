import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';

// No user id in the payload's own right beyond this one: the dashboard has already proved the
// signed-in session owns it, and the worker must not re-derive it from anything the browser sent.
export const verificationWebPassedSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,
  jti: z.string().min(1).max(64),
  verifiedAt: z.number().int().nonnegative(),
});

export type VerificationWebPassed = z.infer<typeof verificationWebPassedSchema>;
