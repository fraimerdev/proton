import { REST } from '@discordjs/rest';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import type { EventBus } from '@proton/core';
import { normalise, type RawDispatch } from './normaliser.ts';
import type { RedisSessionStore } from './session-store.ts';

export interface GatewayManagerOptions {
  token: string;
  intents: number;
  restProxyUrl: string;
  store: RedisSessionStore;
  bus: EventBus;
  onEvent?: (type: string) => void;
}

/**
 * Wire @discordjs/ws to Redis-backed session state and the event bus.
 *
 * Two things worth noting:
 *
 * 1. The REST client here points at Proton's own proxy, not discord.com. The
 *    manager needs `GET /gateway/bot` for the shard count and `max_concurrency`,
 *    and I2 admits no exceptions — even this one call is egress.
 *
 * 2. `retrieveSessionInfo` / `updateSessionInfo` are what make I13 real. With
 *    them, a gateway restart RESUMEs instead of IDENTIFYing, and the 1000/day
 *    session-start budget survives ordinary deploys.
 */
export function createGatewayManager(options: GatewayManagerOptions): WebSocketManager {
  const rest = new REST({ version: '10', api: `${options.restProxyUrl.replace(/\/$/, '')}/api` });
  rest.setToken(options.token);

  const manager = new WebSocketManager({
    token: options.token,
    intents: options.intents,
    rest,
    retrieveSessionInfo: options.store.retrieveSessionInfo,
    updateSessionInfo: options.store.updateSessionInfo,
  });

  manager.on(WebSocketShardEvents.Dispatch, (payload) => {
    const raw = payload as unknown as RawDispatch;
    const event = normalise(raw);
    if (!event) return;

    options.onEvent?.(event.type);
    void options.bus.publish(event);
  });

  return manager;
}
