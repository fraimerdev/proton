import type { ReminderStore } from './store.ts';

export interface RemindersDeps {
  store?: ReminderStore;
}

const PORT_HINTS: Record<string, string> = {
  store: 'store: new DrizzleReminderStore(db)',
};

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `Reminders is enabled in this server but ${what} is NOT running: the module was built ` +
    `without ${unbound.join(', ')}. The process running modules must call ` +
    `createRemindersModule({ ${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

export type StoreBinding = { store: ReminderStore } | { unbound: string[] };

export function bindStore(deps: RemindersDeps): StoreBinding {
  return deps.store ? { store: deps.store } : { unbound: ['store'] };
}
