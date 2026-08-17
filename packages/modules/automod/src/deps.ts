import type { GuildState, RateWindowStore } from '@proton/core';

export interface NativeRule {
  id: string;
  name: string;
  creatorId: string | null;
  triggerType: number;
  enabled: boolean;
  exemptRoles: string[];
  exemptChannels: string[];
}

export interface AutomodDeps {
  rateWindow?: RateWindowStore;
  guildState?: { get(guildId: string): Promise<GuildState | null> };
  // Proton's own user id. Without it automod screens its own alerts and acts on itself.
  botUserId?: string;
  // Reads only. Writes go through the executor so every rule change lands in the case ledger.
  readNativeRules?(guildId: string): Promise<NativeRule[] | null>;
}

export interface BoundAutomodDeps {
  rateWindow: RateWindowStore;
  guildState: { get(guildId: string): Promise<GuildState | null> };
  botUserId: string;
}

export type BindResult = { deps: BoundAutomodDeps } | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  rateWindow: 'rateWindow: new RedisRateWindow(moduleRedis)',
  guildState: 'guildState: new RedisGuildStateStore(stateRedis)',
  botUserId: 'botUserId: env.DISCORD_APPLICATION_ID',
  readNativeRules: 'readNativeRules: GET /guilds/{id}/auto-moderation/rules via the REST proxy',
};

export function bindDeps(deps: AutomodDeps): BindResult {
  const { rateWindow, guildState, botUserId } = deps;

  const unbound: string[] = [];
  if (!rateWindow) unbound.push('rateWindow');
  if (!guildState) unbound.push('guildState');
  if (!botUserId) unbound.push('botUserId');

  if (!rateWindow || !guildState || !botUserId) return { unbound };
  return { deps: { rateWindow, guildState, botUserId } };
}

export function describeUnbound(unbound: readonly string[]): string {
  return (
    'Automod is enabled in this server but is NOT screening anything: the module was built ' +
    `without ${unbound.join(', ')}. Every message is being read and discarded unchecked. The ` +
    'process running modules must call createAutomodModule({ ' +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
