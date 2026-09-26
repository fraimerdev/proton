import { commandEnabledBodySchema, commandUpdateBodySchema } from '@proton/core';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { ApiClient } from '../lib/api-client.ts';
import { loadEnv } from '../lib/env.ts';
import { requireGuildAccess, requireManageGuild } from '../middleware/guild-access.ts';
import { withAudit } from './audit.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

const commandTarget = { guildId: z.string().min(1), key: z.string().min(1) };
const stampFields = { actorId: true, source: true, ipHash: true } as const;
const updateInputSchema = commandUpdateBodySchema.omit(stampFields).extend(commandTarget);

export type CommandUpdateInput = z.input<typeof updateInputSchema>;

export const getGuildCommands = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data }) => api.getCommands(data.guildId));

export const updateGuildCommand = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(updateInputSchema)
  .handler(({ data: { guildId, key, ...input }, context }) =>
    withAudit(context.session.user.id, (stamp) =>
      api.updateCommand(guildId, key, { ...input, ...stamp }),
    ),
  );

export const setGuildCommandEnabled = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(commandEnabledBodySchema.omit(stampFields).extend(commandTarget))
  .handler(({ data, context }) =>
    withAudit(context.session.user.id, (stamp) =>
      api.setCommandEnabled(data.guildId, data.key, { enabled: data.enabled, ...stamp }),
    ),
  );

export const ackLostCommandPermissions = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data, context }) =>
    withAudit(context.session.user.id, (stamp) =>
      api.ackLostCommandPermissions(data.guildId, stamp),
    ),
  );
