import { describe, expect, test } from 'bun:test';
import type { BotNameStyle, BrandingNameStyleStore, NameStyleState } from '@proton/core';
import type { DisplayNameStyle } from '@proton/module-branding/name-style';
import {
  type NameStyleStatus,
  type NameStyleView,
  nameStyleStatusSchema,
} from '@proton/module-branding/name-style-status';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import { ModuleConfigError, type ModuleConfigView } from '../src/modules/service.ts';

const SECRET = 'shared-secret-for-tests';
const GUILD = '900000000000000001';
const OTHER = '900000000000000002';
const AT = 1_787_000_000_000;

const GRADIENT: DisplayNameStyle = {
  font: 'modern',
  effect: 'gradient',
  colours: [0x5865f2, 0xeb459e],
};
const GRADIENT_WIRE: BotNameStyle = { fontId: 6, effectId: 2, colours: [0x5865f2, 0xeb459e] };
const GRADIENT_VIEW: NameStyleView = { ...GRADIENT_WIRE, font: 'modern', effect: 'gradient' };

const SOLID_WIRE: BotNameStyle = { fontId: 11, effectId: 1, colours: [0x2a8af7] };
const SOLID_VIEW: NameStyleView = { ...SOLID_WIRE, font: 'gg-sans', effect: 'solid' };

const UNAVAILABLE: DisplayNameStyle = { font: 'monkey-bars', effect: 'solid', colours: [0x2a8af7] };

interface Saved {
  enabled: boolean;
  config: Record<string, unknown>;
}

function saved(displayNameStyle: unknown, enabled = true): Saved {
  return { enabled, config: { enabled, displayNameStyle } };
}

function confirmed(guildId: string, style: BotNameStyle | null): NameStyleState {
  return {
    guildId,
    requested: style,
    outcome: 'confirmed',
    reason: null,
    attemptedAt: AT,
    confirmed: style,
    confirmedAt: AT,
    updatedAt: AT,
  };
}

function appWith(
  guilds: Record<string, Saved>,
  rows: Record<string, NameStyleState> = {},
  refusal?: Error,
) {
  const asked: { modules: string[][]; store: string[] } = { modules: [], store: [] };

  const modules = {
    get: async (guildId: string, moduleId: string): Promise<ModuleConfigView> => {
      asked.modules.push([guildId, moduleId]);
      if (refusal) throw refusal;

      const held = guilds[guildId] ?? saved(null, false);

      return {
        moduleId,
        enabled: held.enabled,
        config: held.config,
        schemaVersion: 3,
        migrated: false,
        tier: 'free',
        postables: [],
      };
    },
  };

  const refuseWrite = () => Promise.reject(new Error('reading the status must never write it'));

  const brandingNameStyles: BrandingNameStyleStore = {
    get: async (guildId) => {
      asked.store.push(guildId);
      return rows[guildId] ?? null;
    },
    recordAttempt: refuseWrite,
    confirmObserved: refuseWrite,
    forgetConfirmed: refuseWrite,
  };

  const app = createApiApp({
    modules,
    brandingNameStyles,
    sharedSecret: SECRET,
  } as unknown as ApiDeps);

  return { app, asked };
}

type App = ReturnType<typeof appWith>['app'];

function request(
  app: App,
  guildId: string,
  headers: Record<string, string> = { 'x-proton-secret': SECRET },
) {
  return app.request(`/guilds/${guildId}/branding/name-style/status`, { headers });
}

async function statusOf(app: App, guildId: string): Promise<NameStyleStatus> {
  const response = await request(app, guildId);

  expect(response.status).toBe(200);

  return nameStyleStatusSchema.parse(await response.json());
}

describe('GET /guilds/:guildId/branding/name-style/status', () => {
  test('is refused without the shared secret, before anything is read', async () => {
    const { app, asked } = appWith(
      { [GUILD]: saved(GRADIENT) },
      { [GUILD]: confirmed(GUILD, GRADIENT_WIRE) },
    );

    expect((await request(app, GUILD, {})).status).toBe(401);
    expect((await request(app, GUILD, { 'x-proton-secret': 'wrong' })).status).toBe(401);
    expect(asked).toEqual({ modules: [], store: [] });
  });

  test('reads the module and the record for the guild in the path and nothing else', async () => {
    const { app, asked } = appWith({ [GUILD]: saved(GRADIENT), [OTHER]: saved(GRADIENT) });

    await statusOf(app, GUILD);

    expect(asked).toEqual({ modules: [[GUILD, 'branding']], store: [GUILD] });
  });

  test('another server’s confirmed style never leaks into this one’s answer', async () => {
    const { app } = appWith(
      { [GUILD]: saved(GRADIENT), [OTHER]: saved(GRADIENT) },
      { [OTHER]: confirmed(OTHER, GRADIENT_WIRE) },
    );

    expect(await statusOf(app, GUILD)).toEqual({
      state: 'applying',
      reason: null,
      requested: GRADIENT,
      lastAttempt: null,
      confirmed: null,
    });
    expect((await statusOf(app, OTHER)).state).toBe('applied');
  });

  test('a confirmed request reads as applied, carrying the confirmed style', async () => {
    const { app } = appWith(
      { [GUILD]: saved(GRADIENT) },
      { [GUILD]: confirmed(GUILD, GRADIENT_WIRE) },
    );

    expect(await statusOf(app, GUILD)).toEqual({
      state: 'applied',
      reason: null,
      requested: GRADIENT,
      lastAttempt: {
        style: GRADIENT_VIEW,
        outcome: 'confirmed',
        reason: null,
        attemptedAt: AT,
        updatedAt: AT,
      },
      confirmed: { style: GRADIENT_VIEW, confirmedAt: AT },
    });
  });

  test('a saved style Proton has not tried yet reads as applying, keeping the last confirmed one', async () => {
    const { app } = appWith(
      { [GUILD]: saved(GRADIENT) },
      { [GUILD]: confirmed(GUILD, SOLID_WIRE) },
    );

    const status = await statusOf(app, GUILD);

    expect(status.state).toBe('applying');
    expect(status.lastAttempt?.style).toEqual(SOLID_VIEW);
    expect(status.confirmed).toEqual({ style: SOLID_VIEW, confirmedAt: AT });
  });

  test('a saved style that is not available for apps reads as unavailable, whatever was confirmed', async () => {
    const { app } = appWith(
      { [GUILD]: saved(UNAVAILABLE) },
      { [GUILD]: confirmed(GUILD, SOLID_WIRE) },
    );

    const status = await statusOf(app, GUILD);

    expect(status.state).toBe('unavailable');
    expect(status.reason).toBeNull();
    expect(status.requested).toEqual(UNAVAILABLE);
  });

  test('either switch being off reads as off', async () => {
    const { app } = appWith(
      {
        [GUILD]: saved(GRADIENT, false),
        [OTHER]: { enabled: true, config: { enabled: false, displayNameStyle: GRADIENT } },
      },
      { [GUILD]: confirmed(GUILD, GRADIENT_WIRE) },
    );

    expect((await statusOf(app, GUILD)).state).toBe('off');
    expect((await statusOf(app, OTHER)).state).toBe('off');
  });

  test('no style and no record reads as none', async () => {
    const { app } = appWith({ [GUILD]: saved(null) });

    expect((await statusOf(app, GUILD)).state).toBe('none');
  });

  test('a settings read the service refuses comes back as that refusal', async () => {
    const message = 'Proton could not read this server’s Branding settings.';
    const { app } = appWith({}, {}, new ModuleConfigError('invalid_stored_config', message));

    const response = await request(app, GUILD);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_stored_config', message });
  });
});
