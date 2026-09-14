import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { ApiClient } from '../lib/api-client.ts';
import { loadEnv } from '../lib/env.ts';
import { requireGuildAccess } from '../middleware/guild-access.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

export const getNameStyleStatus = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data }) => api.getNameStyleStatus(data.guildId));
