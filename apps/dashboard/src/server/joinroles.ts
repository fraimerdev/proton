import { JOINROLES_RUN_KINDS } from '@proton/core';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { ApiClient } from '../lib/api-client.ts';
import { loadEnv } from '../lib/env.ts';
import { requireGuildAccess, requireManageGuild } from '../middleware/guild-access.ts';
import { withAudit } from './audit.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

export const getJoinRolesSync = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data }) => api.getJoinRolesSync(data.guildId));

export const startJoinRolesSync = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(z.object({ guildId: z.string().min(1), kind: z.enum(JOINROLES_RUN_KINDS) }))
  .handler(({ data, context }) =>
    withAudit(context.session.user.id, (stamp) =>
      api.startJoinRolesSync(data.guildId, { kind: data.kind, ...stamp }),
    ),
  );
