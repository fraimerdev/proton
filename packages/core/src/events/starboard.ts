import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';

export const starboardMessagePostedSchema = z.object({
  guildId: snowflakeSchema,
  sourceMessageId: snowflakeSchema,
  sourceChannelId: snowflakeSchema,
  authorId: snowflakeSchema,
  authorBot: z.boolean(),
  boardMessageId: snowflakeSchema,
  starCount: z.number().int().min(0),
  activityAt: z.number().int(),
});

export type StarboardMessagePosted = z.infer<typeof starboardMessagePostedSchema>;
