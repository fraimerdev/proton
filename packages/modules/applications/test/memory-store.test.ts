import { describe, expect, test } from 'bun:test';
import { CHANGED } from '../src/runner.ts';
import { CHANGED_ERROR } from '../src/store.ts';
import { MemoryApplicationStore } from './memory-store.ts';
import { describeStoreBookkeeping } from './store-contract.ts';

describeStoreBookkeeping(async () => {
  const store = new MemoryApplicationStore();
  return {
    store,
    wakes: async (guildId) =>
      [...store.wakeRows.values()].filter((row) => row.guildId === guildId).length,
    clearWakes: async (guildId) => {
      for (const [key, row] of store.wakeRows) {
        if (row.guildId === guildId) store.wakeRows.delete(key);
      }
    },
  };
});

describe('superseded actions', () => {
  test('are skipped with the runner’s own copy', () => {
    expect(CHANGED_ERROR).toBe(CHANGED);
  });
});
