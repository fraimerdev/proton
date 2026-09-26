import { snowflakeSchema } from '@proton/core';
import {
  applicationDetailSchema,
  deleteApplicantBodySchema,
  deleteApplicantResultSchema,
  queueQuerySchema,
  queueResultSchema,
  queueSummarySchema,
  requestIdSchema,
  reviewMembersSchema,
  staffActionResultSchema,
  staffActionSchema,
} from '@proton/module-applications/view';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { getDiscordUserId } from '../lib/discord-token.ts';
import { requireGuildMember } from '../middleware/guild-access.ts';
import { apiQuery, callApplicationsApi } from './applications-api.ts';
import { withAudit } from './audit.ts';

const REVIEW_MEMBERS_MAX = 50;

const applicationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const STAMP_KEYS: ReadonlySet<string> = new Set(['actorId', 'source', 'ipHash', 'requestId']);

type Stamped = 'actorId' | 'source' | 'ipHash' | 'requestId';
type Unstamped<T> = T extends unknown ? Omit<T, Stamped> : never;

export type ApplicationActionRequest = Unstamped<z.input<typeof staffActionSchema>>;

const INVALID_ACTION =
  'Proton couldn’t read that request, so nothing was changed. Reload the page and try again.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unstamped(request: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(request).filter(([key]) => !STAMP_KEYS.has(key)));
}

export const searchApplicationsSchema = queueQuerySchema.extend({ guildId: snowflakeSchema });
export type SearchApplicationsInput = z.input<typeof searchApplicationsSchema>;

export const searchApplications = createServerFn({ method: 'GET' })
  .middleware([requireGuildMember])
  .validator(searchApplicationsSchema)
  .handler(async ({ data, context }) => {
    const { guildId, ...query } = data;
    const viewerId = await getDiscordUserId(context.session.user.id);

    return callApplicationsApi(
      `/guilds/${guildId}/applications/queue${apiQuery({ ...query, viewerId })}`,
      queueResultSchema,
    );
  });

export const applicationsSummary = createServerFn({ method: 'GET' })
  .middleware([requireGuildMember])
  .validator(z.object({ guildId: snowflakeSchema }))
  .handler(async ({ data, context }) => {
    const viewerId = await getDiscordUserId(context.session.user.id);

    return callApplicationsApi(
      `/guilds/${data.guildId}/applications/summary${apiQuery({ viewerId })}`,
      queueSummarySchema,
    );
  });

export const getApplication = createServerFn({ method: 'GET' })
  .middleware([requireGuildMember])
  .validator(z.object({ guildId: snowflakeSchema, applicationId: applicationIdSchema }))
  .handler(async ({ data, context }) => {
    const viewerId = await getDiscordUserId(context.session.user.id);

    return callApplicationsApi(
      `/guilds/${data.guildId}/applications/${data.applicationId}${apiQuery({ viewerId })}`,
      applicationDetailSchema,
    );
  });

export const applicationMembersSchema = z.object({
  guildId: snowflakeSchema,
  userIds: z.array(snowflakeSchema).max(REVIEW_MEMBERS_MAX),
});
export type ApplicationMembersInput = z.input<typeof applicationMembersSchema>;

export const applicationMembers = createServerFn({ method: 'GET' })
  .middleware([requireGuildMember])
  .validator(applicationMembersSchema)
  .handler(async ({ data, context }) => {
    const viewerId = await getDiscordUserId(context.session.user.id);

    return callApplicationsApi(
      `/guilds/${data.guildId}/applications/members${apiQuery({
        ids: data.userIds.join(','),
        viewerId,
      })}`,
      reviewMembersSchema,
    );
  });

export const actOnApplicationSchema = z.object({
  guildId: snowflakeSchema,
  applicationId: applicationIdSchema,
  requestId: requestIdSchema,
  request: z.custom<ApplicationActionRequest>(isRecord, 'Choose what to do.'),
});
export type ActOnApplicationInput = z.input<typeof actOnApplicationSchema>;

export const actOnApplication = createServerFn({ method: 'POST' })
  .middleware([requireGuildMember])
  .validator(actOnApplicationSchema)
  .handler(({ data, context }) => {
    const { guildId, applicationId, requestId, request } = data;

    return withAudit(context.session.user.id, (stamp) => {
      const params = unstamped(request);
      const body = staffActionSchema.safeParse({
        ...params,
        ...(params.action === 'assign' && params.assigneeId === 'me'
          ? { assigneeId: stamp.actorId }
          : {}),
        requestId,
        ...stamp,
      });
      if (!body.success) throw new Error(INVALID_ACTION);

      return callApplicationsApi(
        `/guilds/${guildId}/applications/${applicationId}/actions`,
        staffActionResultSchema,
        { method: 'POST', body: JSON.stringify(body.data) },
      );
    });
  });

export const deleteApplicantDataSchema = z.object({
  guildId: snowflakeSchema,
  applicantId: snowflakeSchema,
  requestId: requestIdSchema,
});
export type DeleteApplicantDataInput = z.input<typeof deleteApplicantDataSchema>;

export const deleteApplicantData = createServerFn({ method: 'POST' })
  .middleware([requireGuildMember])
  .validator(deleteApplicantDataSchema)
  .handler(({ data, context }) => {
    const { guildId, applicantId, requestId } = data;

    return withAudit(context.session.user.id, (stamp) => {
      const body = deleteApplicantBodySchema.parse({ confirm: true, requestId, ...stamp });

      return callApplicationsApi(
        `/guilds/${guildId}/applications/applicants/${applicantId}/delete`,
        deleteApplicantResultSchema,
        { method: 'POST', body: JSON.stringify(body) },
      );
    });
  });
