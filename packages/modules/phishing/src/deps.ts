import type { BlocklistStore } from './store.ts';

export interface PhishingDeps {
  blocklist?: BlocklistStore;

  botUserId?: string;
}

export interface BoundPhishingDeps {
  blocklist: BlocklistStore;
  botUserId: string;
}

const PORT_HINTS: Record<string, string> = {
  blocklist: 'blocklist: new RedisBlocklistStore(redis)',
  botUserId: "botUserId: the application's own user id, from READY",
};

export type BindResult = { deps: BoundPhishingDeps } | { unbound: string[] };

export function bindDeps(deps: PhishingDeps): BindResult {
  const { blocklist, botUserId } = deps;

  const unbound: string[] = [];
  if (!blocklist) unbound.push('blocklist');
  if (!botUserId) unbound.push('botUserId');

  if (!blocklist || !botUserId) return { unbound };
  return { deps: { blocklist, botUserId } };
}

export function describeUnbound(unbound: readonly string[]): string {
  return (
    'Phishing detection is enabled in this server but is NOT running: the module was built ' +
    `without ${unbound.join(', ')}. Messages are being read and discarded unchecked. The ` +
    `process running modules must call createPhishingModule({ ${unbound
      .map((port) => PORT_HINTS[port] ?? port)
      .join(', ')} }).`
  );
}
