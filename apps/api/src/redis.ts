import { createRedisClient } from '@proton/core/redis';
import { RedisMaintenanceStore } from '@proton/module-antinuke';
import { RedisJoinRolesRunStore } from '@proton/module-joinroles/sync-store';
import type { Redis } from 'ioredis';
import type { ApiEnv } from './env.ts';

export type RedisConnect = (url: string, options: { db: number; label: string }) => Redis;

export interface ApiRedis {
  bus: Redis;
  modules: Redis;
  maintenance: RedisMaintenanceStore;
  joinrolesRuns: RedisJoinRolesRunStore;
}

export function createApiRedis(
  env: Pick<ApiEnv, 'REDIS_URL' | 'REDIS_DB_BUS' | 'REDIS_DB_MODULES'>,
  connect: RedisConnect = createRedisClient,
): ApiRedis | null {
  if (!env.REDIS_URL) return null;

  const bus = connect(env.REDIS_URL, { db: env.REDIS_DB_BUS, label: 'api/bus' });
  const modules = connect(env.REDIS_URL, { db: env.REDIS_DB_MODULES, label: 'api/modules' });

  // Not the bus connection: the worker writes both stores' keys to the modules database.
  return {
    bus,
    modules,
    maintenance: new RedisMaintenanceStore(modules),
    joinrolesRuns: new RedisJoinRolesRunStore(modules),
  };
}

export function disconnectApiRedis(redis: ApiRedis | null): void {
  redis?.bus.disconnect();
  redis?.modules.disconnect();
}
