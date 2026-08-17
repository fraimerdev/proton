import type { RestProxyClient } from '../actions/rest-client.ts';
import { toUserProfile, type UserProfile, type UserProfileCache } from './profile-cache.ts';

export const PSEUDO_ACTOR_PREFIX = 'proton:';

export interface UserResolver {
  resolve(userId: string): Promise<UserProfile | null>;
}

export interface UserResolverDeps {
  cache: UserProfileCache;
  rest: RestProxyClient;

  pseudoActors?: Record<string, { username: string; avatarUrl: string | null }>;

  onUnavailable?(userId: string, status: number): void;
}

export function isPseudoActor(actorId: string): boolean {
  return actorId.startsWith(PSEUDO_ACTOR_PREFIX);
}

export function createUserResolver(deps: UserResolverDeps): UserResolver {
  const inflight = new Map<string, Promise<UserProfile | null>>();

  async function fetch(userId: string): Promise<UserProfile | null> {
    const response = await deps.rest.request({ method: 'GET', path: `/users/${userId}` });

    if (response.status >= 400) {
      deps.onUnavailable?.(userId, response.status);
      return null;
    }

    const profile = toUserProfile(response.body);
    if (profile) await deps.cache.put(profile);

    return profile;
  }

  return {
    async resolve(userId: string): Promise<UserProfile | null> {
      if (isPseudoActor(userId)) {
        const known = deps.pseudoActors?.[userId];
        return {
          id: userId,
          username: known?.username ?? userId.slice(PSEUDO_ACTOR_PREFIX.length),
          globalName: null,
          avatarUrl: known?.avatarUrl ?? null,
        };
      }

      const cached = await deps.cache.get(userId);
      if (cached) return cached;

      // A burst of logs about one moderator would otherwise become a burst of identical
      // /users/{id} calls before the first one lands in the cache.
      const existing = inflight.get(userId);
      if (existing) return existing;

      const pending = fetch(userId).finally(() => inflight.delete(userId));
      inflight.set(userId, pending);

      return pending;
    },
  };
}
