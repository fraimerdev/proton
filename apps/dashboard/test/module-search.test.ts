import { describe, expect, test } from 'bun:test';
import type { ModuleSummary } from '@proton/core';
import { searchModules } from '../src/lib/modules/search.ts';

function hitFor(query: string, moduleId: string, summaries: readonly ModuleSummary[] = []) {
  return searchModules(query, summaries).modules.find((hit) => hit.meta.id === moduleId);
}

describe('searchModules', () => {
  test('carries the area whose label matched, so the link lands on it', () => {
    const hit = hitFor('bots', 'joinroles');

    expect(hit?.hint).toBe('Bots');
    expect(hit?.area).toBe('bots');
  });

  test('drops the area when a field label outranks it', () => {
    const summaries = [
      { id: 'verification', fields: [{ label: 'Pan' }] },
    ] as unknown as ModuleSummary[];
    const hit = hitFor('pan', 'verification', summaries);

    expect(hit?.hint).toBe('Pan');
    expect(hit?.area).toBeUndefined();
  });

  test('keeps no area for an alias match', () => {
    const hit = hitFor('captcha', 'verification');

    expect(hit?.hint).toBe('captcha');
    expect(hit?.area).toBeUndefined();
  });
});
