import { simulationRunSchema } from '@proton/core';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { ApiClient } from '../lib/api-client.ts';
import { loadEnv } from '../lib/env.ts';
import { requireManageGuild } from '../middleware/guild-access.ts';
import { withAudit } from './audit.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

/**
 * requireManageGuild for both modes, not only the send: a preview renders this server's real
 * members and channels through the module's own surface, which is the same information a settings
 * page shows, and a reader who may not change settings has no business rehearsing them either.
 */
export const runSimulation = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(
    simulationRunSchema.extend({
      guildId: z.string().min(1),
      moduleId: z.string().min(1),
    }),
  )
  .handler(({ data, context }) => {
    const { guildId, moduleId, ...run } = data;

    return withAudit(context.session.user.id, (stamp) =>
      api.runSimulation(guildId, moduleId, { ...run, ...stamp }),
    );
  });
