import { describe, expect, test } from 'bun:test';
import { type ConfigWriteIssue, type ModuleManifest, ModuleRegistry } from '@proton/core';
import type { DbHandle } from '@proton/db';
import { z } from 'zod';
import { assertWriteRefinements } from '../src/modules/refine-write.ts';
import { ModuleConfigError, ModuleConfigService } from '../src/modules/service.ts';

const GUILD = '900000000000000001';
const ACTOR = '100000000000000001';

const ISSUES: ConfigWriteIssue[] = [
  { path: 'displayNameStyle.font', message: 'Monkey Bars is not available for apps yet.' },
  { path: 'displayNameStyle.colours', message: 'Gradient takes two colours, not 1.' },
];

function refusal(run: () => unknown): ModuleConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ModuleConfigError) return error;
    throw error;
  }
  throw new Error('the save was not refused');
}

const SERVER_ISSUES = /settings were not saved:\s*(.+)$/s;

function serverErrors(message: string): Map<string, string> {
  const errors = new Map<string, string>();
  const body = SERVER_ISSUES.exec(message)?.[1];
  if (body === undefined) return errors;

  for (const part of body.split(';')) {
    const match = /^\s*([A-Za-z0-9_.[\]]+)\s+(.+?)\s*$/.exec(part);
    const path = match?.[1];
    const detail = match?.[2];
    if (path === undefined || detail === undefined || !path.includes('.')) continue;

    if (!errors.has(path)) errors.set(path, detail);
  }

  return errors;
}

describe('assertWriteRefinements', () => {
  test('refuses as invalid_config, naming each path and message in the save error’s shape', () => {
    const error = refusal(() =>
      assertWriteRefinements({ name: 'Branding', refineWrite: () => ISSUES }, {}, {}),
    );

    expect(error.code).toBe('invalid_config');
    expect(error.message).toBe(
      'Those Branding settings were not saved: ' +
        'displayNameStyle.font Monkey Bars is not available for apps yet.; ' +
        'displayNameStyle.colours Gradient takes two colours, not 1.',
    );
  });

  test('each issue lands on its own field when the settings form reads the error', () => {
    const error = refusal(() =>
      assertWriteRefinements({ name: 'Branding', refineWrite: () => ISSUES }, {}, {}),
    );

    expect([...serverErrors(error.message)]).toEqual([
      ['displayNameStyle.font', 'Monkey Bars is not available for apps yet.'],
      ['displayNameStyle.colours', 'Gradient takes two colours, not 1.'],
    ]);
  });

  test('the hook is handed the next config and then the one before it', () => {
    const seen: unknown[][] = [];
    const next = { look: 'next' };
    const before = { look: 'before' };

    assertWriteRefinements(
      {
        name: 'Branding',
        refineWrite: (...args) => {
          seen.push(args);
          return [];
        },
      },
      next,
      before,
    );

    expect(seen).toEqual([[next, before]]);
  });

  test('a manifest without the hook never refuses anything', () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{}, {}],
      [{ displayNameStyle: { font: 'monkey-bars' } }, {}],
      [{ __proto__: null }, { displayNameStyle: null }],
    ];

    for (const [next, before] of cases) {
      expect(() => assertWriteRefinements({ name: 'Ping' }, next, before)).not.toThrow();
    }
  });
});

describe('ModuleConfigService and refineWrite', () => {
  const schema = z.object({
    enabled: z.boolean().default(true),
    look: z.string().default('plain'),
  });

  type Looks = z.infer<typeof schema>;

  function manifestWith(refineWrite?: (next: Looks, before: Looks) => ConfigWriteIssue[]) {
    const manifest: ModuleManifest<typeof schema> = {
      id: 'looks',
      name: 'Looks',
      category: 'utility',
      configSchema: schema,
      defaultConfig: { enabled: true, look: 'plain' },
      schemaVersion: 1,
      requiredIntents: [],
      requiredPermissions: [],
      ...(refineWrite ? { refineWrite } : {}),
    };

    return manifest;
  }

  const lockedOnChange =
    (seen: Array<{ next: Looks; before: Looks }>) => (next: Looks, before: Looks) => {
      seen.push({ next, before });
      return next.look === 'locked' && before.look !== 'locked'
        ? [{ path: 'look.name', message: 'Locked is not available for apps yet.' }]
        : [];
    };

  function serviceOver(stored: Record<string, unknown>, manifest: ModuleManifest) {
    const writes = { transactions: 0 };
    const rows = [{ enabled: true, config: stored, schemaVersion: 1 }];

    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
      transaction: async () => {
        writes.transactions += 1;
      },
    };

    const registry = new ModuleRegistry();
    registry.register(manifest);

    return { service: new ModuleConfigService({ db } as unknown as DbHandle, registry), writes };
  }

  test('a refused write is stopped before anything is written, the hook seeing the parsed next and the stored before', async () => {
    const seen: Array<{ next: Looks; before: Looks }> = [];
    const { service, writes } = serviceOver(
      { enabled: true, look: 'plain' },
      manifestWith(lockedOnChange(seen)),
    );

    const error = await service
      .update({
        guildId: GUILD,
        moduleId: 'looks',
        config: { look: 'locked' },
        actorId: ACTOR,
        source: 'dashboard',
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ModuleConfigError);
    expect(error instanceof ModuleConfigError ? error.code : null).toBe('invalid_config');
    expect(error instanceof ModuleConfigError ? error.message : '').toBe(
      'Those Looks settings were not saved: look.name Locked is not available for apps yet.',
    );
    expect(seen).toEqual([
      { next: { enabled: true, look: 'locked' }, before: { enabled: true, look: 'plain' } },
    ]);
    expect(writes.transactions).toBe(0);
  });

  test('a stored value the hook would refuse does not block switching the module off', async () => {
    const seen: Array<{ next: Looks; before: Looks }> = [];
    const { service, writes } = serviceOver(
      { enabled: true, look: 'locked' },
      manifestWith(lockedOnChange(seen)),
    );

    const { after } = await service.update({
      guildId: GUILD,
      moduleId: 'looks',
      enabled: false,
      actorId: ACTOR,
      source: 'dashboard',
    });

    expect(after.config).toEqual({ enabled: false, look: 'locked' });
    expect(writes.transactions).toBe(1);
  });

  test('reads never consult the hook', async () => {
    const { service } = serviceOver(
      { enabled: true, look: 'locked' },
      manifestWith(() => {
        throw new Error('refineWrite ran on a read');
      }),
    );

    expect((await service.get(GUILD, 'looks')).config).toEqual({ enabled: true, look: 'locked' });
  });

  test('a module without the hook saves exactly as before', async () => {
    const { service, writes } = serviceOver({ enabled: true, look: 'plain' }, manifestWith());

    await service.update({
      guildId: GUILD,
      moduleId: 'looks',
      config: { look: 'locked' },
      actorId: ACTOR,
      source: 'dashboard',
    });

    expect(writes.transactions).toBe(1);
  });
});
