import { describe, expect, test } from 'bun:test';
import { postableSchema } from '@proton/core';
import { createModuleRegistry } from '@proton/modules';

const registry = createModuleRegistry();

const postable = registry.all().filter((manifest) => manifest.postables);

describe('what a module says it keeps in a channel', () => {
  test('is declared by exactly the modules whose settings draw a post button', () => {
    expect(postable.map((manifest) => manifest.id).sort()).toEqual([
      'rolemenu',
      'tickets',
      'verification',
    ]);
  });

  test('satisfies the schema the dashboard reads it back through', () => {
    for (const manifest of postable) {
      const declared = manifest.postables?.(manifest.defaultConfig as never) ?? [];

      for (const entry of declared) {
        expect(`${manifest.id}: ${postableSchema.safeParse(entry).success}`).toBe(
          `${manifest.id}: true`,
        );
      }
    }
  });

  // The api derives this on every read of a config, and a throw there would take the settings page
  // down over a button. It is guarded, but a manifest that needs the guard is a bug in the manifest.
  test('never throws on the config the module ships with', () => {
    for (const manifest of postable) {
      expect(() => manifest.postables?.(manifest.defaultConfig as never)).not.toThrow();
    }
  });

  test('names one panel per id, so a button can never stand for two', () => {
    for (const manifest of postable) {
      const declared = manifest.postables?.(manifest.defaultConfig as never) ?? [];
      const ids = declared.map((entry) => entry.id);

      expect(`${manifest.id}: ${new Set(ids).size}`).toBe(`${manifest.id}: ${ids.length}`);
    }
  });
});

describe('the panels each module offers', () => {
  test('verification has its one panel, named and channelled from the config', () => {
    const manifest = registry.get('verification');

    expect(manifest?.postables?.({ panelChannelId: '700000000000000001' } as never)).toEqual([
      { id: 'panel', name: 'Verification panel', channelId: '700000000000000001' },
    ]);
  });

  test('rolemenu offers one per menu, keyed by the id its custom ids carry', () => {
    const manifest = registry.get('rolemenu');

    const declared = manifest?.postables?.({
      menus: [
        { id: 'colours', channelId: '700000000000000001', kind: 'button', mode: 'toggle' },
        { id: 'pings', channelId: '700000000000000002', kind: 'select', mode: 'unique' },
      ],
    } as never);

    expect(declared?.map((entry) => entry.id)).toEqual(['colours', 'pings']);
    expect(declared?.[1]?.channelId).toBe('700000000000000002');
  });

  test('tickets offers one per panel, under the name the admin gave it', () => {
    const manifest = registry.get('tickets');

    expect(
      manifest?.postables?.({
        panels: [{ id: 'support', name: 'Get help', channelId: '700000000000000003' }],
      } as never),
    ).toEqual([{ id: 'support', name: 'Get help', channelId: '700000000000000003' }]);
  });

  // An unset channel is left absent rather than reported as '': the post button reads it to decide
  // whether it can send at all, and an empty string is truthy enough to have got that wrong.
  test('leaves the channel off a panel that has none yet', () => {
    const manifest = registry.get('rolemenu');

    const declared = manifest?.postables?.({
      menus: [{ id: 'colours', channelId: '', kind: 'button', mode: 'toggle' }],
    } as never);

    expect(declared?.[0]?.channelId).toBeUndefined();
  });
});
