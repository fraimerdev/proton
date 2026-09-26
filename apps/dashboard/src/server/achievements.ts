import { snowflakeSchema } from '@proton/core';
import {
  jobRequestSchema,
  resetRequestSchema,
  rewardListQuerySchema,
  rewardRetryRequestSchema,
  unlockListQuerySchema,
} from '@proton/module-achievements/view';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { ApiClient } from '../lib/api-client.ts';
import { fetchProtonRolePower } from '../lib/discord.ts';
import { loadEnv } from '../lib/env.ts';
import { requireGuildAccess, requireManageGuild } from '../middleware/guild-access.ts';
import { withAudit } from './audit.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

export const getAchievementsOverview = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data }) => api.getAchievementsOverview(data.guildId));

export const getAchievementMember = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1), userId: snowflakeSchema }))
  .handler(({ data }) => api.getAchievementMember(data.guildId, data.userId));

export const listAchievementUnlocks = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(unlockListQuerySchema.extend({ guildId: z.string().min(1) }))
  .handler(({ data }) => {
    const { guildId, ...query } = data;
    return api.listAchievementUnlocks(guildId, query);
  });

export const listAchievementRewards = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(rewardListQuerySchema.extend({ guildId: z.string().min(1) }))
  .handler(({ data }) => {
    const { guildId, ...query } = data;
    return api.listAchievementRewards(guildId, query);
  });

export const getProtonRolePower = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data }) =>
    fetchProtonRolePower(env.REST_PROXY_URL, data.guildId, env.DISCORD_CLIENT_ID),
  );

export const retryAchievementRewards = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(rewardRetryRequestSchema.extend({ guildId: z.string().min(1) }))
  .handler(({ data, context }) => {
    const { guildId, ...body } = data;
    return withAudit(context.session.user.id, (stamp) =>
      api.retryAchievementRewards(guildId, { ...body, ...stamp }),
    );
  });

export const resetAchievements = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(z.object({ guildId: z.string().min(1), reset: resetRequestSchema }))
  .handler(({ data, context }) =>
    withAudit(context.session.user.id, (stamp) =>
      api.resetAchievements(data.guildId, { ...data.reset, ...stamp }),
    ),
  );

export const requestAchievementJob = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(jobRequestSchema.extend({ guildId: z.string().min(1) }))
  .handler(({ data, context }) => {
    const { guildId, ...body } = data;
    return withAudit(context.session.user.id, (stamp) =>
      api.requestAchievementJob(guildId, { ...body, ...stamp }),
    );
  });
