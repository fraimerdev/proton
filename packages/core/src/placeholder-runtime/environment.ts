import type { GuildStateStore } from '../guild-state/types.ts';
import {
  type BotFacts,
  type PlaceholderEnvironment,
  PROTON_SUPPORT_URL,
  serverFactsFrom,
  type UserFacts,
} from '../placeholders/index.ts';
import { isSnowflake } from '../placeholders/shared/user.ts';
import { USER_PROFILE_TTL_MS, type UserProfile } from '../users/profile-cache.ts';
import { isPseudoActor, type UserResolver } from '../users/resolver.ts';

const BOT_RETRY_MS = 60_000;

export interface PlaceholderEnvironmentDeps {
  applicationId: string;
  dashboardUrl: string;
  users: UserResolver;
  guildState: Pick<GuildStateStore, 'get'>;
  now?: (() => number) | undefined;
}

async function profileOf(users: UserResolver, userId: string): Promise<UserProfile | null> {
  try {
    const profile = await users.resolve(userId);
    return profile?.id === userId ? profile : null;
  } catch {
    return null;
  }
}

export function createPlaceholderEnvironment(
  deps: PlaceholderEnvironmentDeps,
): PlaceholderEnvironment {
  const { applicationId, dashboardUrl, users, guildState } = deps;
  const clock = deps.now ?? (() => Date.now());

  let cached: { facts: BotFacts; until: number } | null = null;
  let loading: Promise<BotFacts> | null = null;

  async function loadBot(): Promise<BotFacts> {
    const profile = isSnowflake(applicationId) ? await profileOf(users, applicationId) : null;

    const facts: BotFacts = Object.freeze({
      id: applicationId,
      name: profile === null ? null : (profile.globalName ?? profile.username),
      avatarHash: profile === null ? null : profile.avatarHash,
      websiteUrl: dashboardUrl,
      supportUrl: PROTON_SUPPORT_URL,
    });

    cached = { facts, until: clock() + (profile === null ? BOT_RETRY_MS : USER_PROFILE_TTL_MS) };
    return facts;
  }

  return {
    applicationId,

    bot() {
      if (cached !== null && clock() < cached.until) return Promise.resolve(cached.facts);

      if (loading === null) {
        loading = loadBot().finally(() => {
          loading = null;
        });
      }

      return loading;
    },

    async server(guildId) {
      if (!isSnowflake(guildId)) return serverFactsFrom(null, guildId);
      return serverFactsFrom(await guildState.get(guildId), guildId);
    },

    async user(userId) {
      if (!isSnowflake(userId) && !isPseudoActor(userId)) return null;

      const profile = await profileOf(users, userId);
      if (profile === null) return null;

      const facts: UserFacts = {
        id: profile.id,
        username: profile.username,
        globalName: profile.globalName,
        avatarHash: profile.avatarHash,
      };
      return facts;
    },

    now: () => clock(),
  };
}
