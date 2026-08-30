import { REST } from '@discordjs/rest';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import type { EventBus } from '@proton/core';
import type { GatewayPresenceUpdateData } from 'discord-api-types/v10';
import { normalise, type RawDispatch } from './normaliser.ts';
import type { RedisSessionStore } from './session-store.ts';

export interface GatewayManagerOptions {
  token: string;
  intents: number;
  presence: GatewayPresenceUpdateData;
  restProxyUrl: string;
  store: RedisSessionStore;
  bus: EventBus;
  onEvent?: (type: string) => void;
}

export function createGatewayManager(options: GatewayManagerOptions): WebSocketManager {
  const rest = new REST({ version: '10', api: `${options.restProxyUrl.replace(/\/$/, '')}/api` });
  rest.setToken(options.token);

  const manager = new WebSocketManager({
    token: options.token,
    intents: options.intents,
    initialPresence: options.presence,
    rest,
    retrieveSessionInfo: options.store.retrieveSessionInfo,
    updateSessionInfo: options.store.updateSessionInfo,
  });

  manager.on(WebSocketShardEvents.Dispatch, (payload) => {
    const raw = payload as unknown as RawDispatch;

    for (const event of normalise(raw)) {
      options.onEvent?.(event.type);
      void options.bus.publish(event);
    }
  });

  return manager;
}
