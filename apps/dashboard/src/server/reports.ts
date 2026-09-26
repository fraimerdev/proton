import { caseIdSchema } from '@proton/core';
import { reportActionBodySchema } from '@proton/module-moderation/reports-view';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import {
  ApiClient,
  automationRunListQuerySchema,
  reportListQuerySchema,
} from '../lib/api-client.ts';
import { getDiscordUserId } from '../lib/discord-token.ts';
import { loadEnv } from '../lib/env.ts';
import { requireGuildAccess, requireManageGuild } from '../middleware/guild-access.ts';
import { withAudit } from './audit.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

export const searchReports = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(reportListQuerySchema.extend({ guildId: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const { guildId, ...query } = data;
    return api.searchReports(guildId, query, await getDiscordUserId(context.session.user.id));
  });

export const getReportSummary = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(async ({ data, context }) =>
    api.getReportSummary(data.guildId, await getDiscordUserId(context.session.user.id)),
  );

export const getReport = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1), reportId: z.string().min(1).max(64) }))
  .handler(async ({ data, context }) =>
    api.getReport(data.guildId, data.reportId, await getDiscordUserId(context.session.user.id)),
  );

export const listReportAutomationRuns = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(automationRunListQuerySchema.extend({ guildId: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const { guildId, ...query } = data;
    return api.listReportAutomationRuns(
      guildId,
      query,
      await getDiscordUserId(context.session.user.id),
    );
  });

export const getCaseEvidence = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1), caseId: caseIdSchema }))
  .handler(({ data }) => api.getCaseEvidence(data.guildId, data.caseId));

export const actOnReport = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(
    reportActionBodySchema
      .pick({ action: true, params: true, requestId: true })
      .extend({ guildId: z.string().min(1), reportId: z.string().min(1).max(64) }),
  )
  .handler(({ data, context }) => {
    const { guildId, reportId, ...body } = data;
    return withAudit(context.session.user.id, (stamp) =>
      api.actOnReport(guildId, reportId, {
        ...body,
        actorPermissions: context.access.permissions.toString(),
        ...stamp,
      }),
    );
  });
