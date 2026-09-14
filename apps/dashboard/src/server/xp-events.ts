import { xpEventCreateSchema, xpEventViewSchema } from '@proton/module-leveling/config';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadEnv } from '../lib/env.ts';
import { requireGuildAccess, requireManageGuild } from '../middleware/guild-access.ts';
import { withAudit } from './audit.ts';

const env = loadEnv();

const xpEventListSchema = z.object({
  events: z.array(xpEventViewSchema),
  now: z.number(),
});

export type XpEventList = z.infer<typeof xpEventListSchema>;

const xpEventStartedSchema = z.object({
  status: z.enum(['created', 'exists']),
  event: xpEventViewSchema.nullable(),
});

export type XpEventStarted = z.infer<typeof xpEventStartedSchema>;

const xpEventEndedSchema = z.object({ result: z.enum(['ended', 'cancelled']) });

export type XpEventEnded = z.infer<typeof xpEventEndedSchema>;

const startXpEventSchema = xpEventCreateSchema.extend({
  guildId: z.string().min(1),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});

export type StartXpEventInput = z.input<typeof startXpEventSchema>;

const apiMessageSchema = z.object({ message: z.string() });

async function callApi<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<z.output<TSchema>> {
  const response = await fetch(`${env.API_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-proton-secret': env.API_SHARED_SECRET,
      ...init.headers,
    },
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const refusal = apiMessageSchema.safeParse(body);

    throw new Error(
      refusal.success
        ? refusal.data.message
        : `Proton's API did not answer (HTTP ${response.status}). Nothing was changed — try ` +
            'again, and if it keeps happening the API is the part that is down, not Discord.',
    );
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new Error(
      `the api answered ${path} with a shape this dashboard does not understand — ` +
        `${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`,
    );
  }

  return parsed.data;
}

export const listXpEvents = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(
    ({ data }): Promise<XpEventList> =>
      callApi(`/guilds/${data.guildId}/leveling/xp-events`, xpEventListSchema),
  );

export const startXpEvent = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(startXpEventSchema)
  .handler(({ data, context }): Promise<XpEventStarted> => {
    const { guildId, ...event } = data;

    return withAudit(context.session.user.id, (stamp) =>
      callApi(`/guilds/${guildId}/leveling/xp-events`, xpEventStartedSchema, {
        method: 'POST',
        body: JSON.stringify({ ...event, ...stamp }),
      }),
    );
  });

export const endXpEvent = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(z.object({ guildId: z.string().min(1), eventId: z.string().min(1).max(200) }))
  .handler(
    ({ data, context }): Promise<XpEventEnded> =>
      withAudit(context.session.user.id, (stamp) =>
        callApi(
          `/guilds/${data.guildId}/leveling/xp-events/${encodeURIComponent(data.eventId)}`,
          xpEventEndedSchema,
          { method: 'DELETE', headers: { 'x-proton-actor': stamp.actorId } },
        ),
      ),
  );
