import type { SourceMessage } from './source.ts';
import type { StarboardStore } from './store.ts';

export interface SourceMessageRequest {
  channelId: string;
  messageId: string;

  emoji: string;

  withReactors: boolean;
}

export interface StarboardDeps {
  store?: StarboardStore;

  /** Re-read and recount every time. Never count reaction events — they have no stable id. */
  readMessage?(request: SourceMessageRequest): Promise<SourceMessage | null>;
}

export interface BoundStarboardDeps {
  store: StarboardStore;
  readMessage(request: SourceMessageRequest): Promise<SourceMessage | null>;
}

export type BindResult = { deps: BoundStarboardDeps } | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  store: 'store: new DrizzleStarboardStore(dbHandle)',
  readMessage: 'readMessage: GET /channels/{channelId}/messages/{messageId} via the REST proxy',
};

export function bindDeps(deps: StarboardDeps): BindResult {
  const { store, readMessage } = deps;

  const unbound: string[] = [];
  if (!store) unbound.push('store');
  if (!readMessage) unbound.push('readMessage');

  if (!store || !readMessage) return { unbound };
  return { deps: { store, readMessage } };
}

export function describeUnbound(unbound: readonly string[]): string {
  return (
    'The starboard is enabled in this server but is NOT running: the module was built ' +
    `without ${unbound.join(', ')}. Stars are being counted by nobody and no board post will ` +
    'ever appear. The process running modules must call createStarboardModule({ ' +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
