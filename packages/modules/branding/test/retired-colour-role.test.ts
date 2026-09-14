import { describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import {
  type BrandingConfig,
  brandingConfigSchema,
  brandingDefaultConfig,
  brandingFormSchema,
  liftStoredConfig,
} from '../src/config.ts';
import { brandingModule } from '../src/index.ts';
import type { DisplayNameStyle } from '../src/name-style.ts';
import {
  AVATAR_HASH,
  BANNER_HASH,
  BOT_ROLE_POSITION,
  COLOUR_ROLE,
  configChanged,
  GUILD,
  guildAvailable,
  type Harness,
  harness,
  PNG_DATA_URI,
} from './harness.ts';

const FULL = {
  nickname: 'Dreamliner',
  avatarHash: AVATAR_HASH,
  bannerHash: BANNER_HASH,
  bio: 'The friendly one.',
};

const STYLE: DisplayNameStyle = {
  font: 'modern',
  effect: 'gradient',
  colours: [0x5865f2, 0xeb459e],
};

const KEPT = { enabled: true, ...FULL, displayNameStyle: STYLE, restoreOnDisable: false };

const RETIRED = { nameEffect: 'gradient', primaryColor: 0x4db9c0, secondaryColor: 0xffffff };

const ROLE_PATH = `/guilds/${GUILD}/roles/${COLOUR_ROLE}`;
const ROLE_KEY = `branding:${GUILD}:colour-role:${COLOUR_ROLE}`;

const WITHOUT_MANAGE_ROLES = Permissions.ViewChannel | Permissions.ChangeNickname;

const SETTLED = { nick: 'Dreamliner', avatar: 'a1', banner: 'b1' };
const BLANK = { nick: null, avatar: null, banner: null };

const COLOUR_FIELD = /"(colou?rs?|primary_color|secondary_color|tertiary_color)"/;

function roleCalls(h: Harness) {
  return h.calls().filter((call) => call.path.includes('/roles'));
}

function roleWarnings(h: Harness) {
  return h.logs.filter((line) => line.message.includes('name colour'));
}

function deletions(h: Harness): number {
  return h.kinds().filter((kind) => kind === 'delete_role').length;
}

describe('loading a config saved while the role colour existed', () => {
  const expected = brandingConfigSchema.parse(KEPT);

  test('drops each retired key on its own and keeps every other key', () => {
    for (const [key, value] of Object.entries(RETIRED)) {
      const lifted = liftStoredConfig({ ...KEPT, [key]: value });

      expect(lifted).not.toHaveProperty(key);
      expect(lifted).toEqual(KEPT);
      expect(brandingConfigSchema.parse(lifted)).toEqual(expected);
    }
  });

  test('drops all three together and keeps every other key', () => {
    const lifted = liftStoredConfig({ ...KEPT, ...RETIRED });

    for (const key of Object.keys(RETIRED)) expect(lifted).not.toHaveProperty(key);
    expect(lifted).toEqual(KEPT);
    expect(brandingConfigSchema.parse(lifted)).toEqual(expected);
  });

  test('never fails a read, whatever the retired keys held', () => {
    for (const value of ['sparkle', -1, 0x1000000, '', null, { r: 1 }, ['solid']]) {
      const row = { ...KEPT, nameEffect: value, primaryColor: value, secondaryColor: value };
      const loaded = brandingConfigSchema.safeParse(liftStoredConfig(row));

      expect({ value, success: loaded.success }).toEqual({ value, success: true });
      expect(loaded.data).toEqual(expected);
    }
  });

  test('drops them on the write path too, where the style stamp is added', () => {
    expect(liftStoredConfig({ ...KEPT, ...RETIRED }, {})).toEqual({
      ...KEPT,
      nameStyleNative: true,
    });
  });

  test('offers no field for them in the form, the defaults or the manifest', () => {
    const fields = brandingModule.dashboard?.sections.flatMap((section) => section.fields) ?? [];

    for (const key of Object.keys(RETIRED)) {
      expect(Object.keys(brandingFormSchema.shape)).not.toContain(key);
      expect(brandingDefaultConfig).not.toHaveProperty(key);
      expect(fields).not.toContain(key);
    }
    expect(brandingModule.dashboard?.sections.map((section) => section.id)).not.toContain('colour');
  });
});

describe('deleting the colour role an earlier Proton made, on reconnect', () => {
  test('deletes exactly the recorded role, keyed on its id, and forgets it', async () => {
    const h = harness();
    h.roles.held = COLOUR_ROLE;

    await h.listen(guildAvailable(SETTLED), FULL);

    expect(roleCalls(h)).toEqual([expect.objectContaining({ method: 'DELETE', path: ROLE_PATH })]);
    expect(h.keys()).toEqual([ROLE_KEY]);
    expect(h.roles.held).toBeNull();
    expect(h.roles.forgets).toBe(1);
    expect(h.recorder.recorded).toEqual([]);
    expect(roleWarnings(h)).toEqual([]);
  });

  test('keys the deletion on the role id alone, whatever the member or the settings', async () => {
    const configs: Partial<BrandingConfig>[] = [FULL, {}];
    const keys: string[][] = [];

    for (const config of configs) {
      for (const member of [BLANK, SETTLED]) {
        const h = harness();
        h.roles.held = COLOUR_ROLE;
        await h.listen(guildAvailable(member), config);
        keys.push(h.keys().filter((key) => key.includes('colour-role')));
      }
    }

    expect(keys).toEqual([[ROLE_KEY], [ROLE_KEY], [ROLE_KEY], [ROLE_KEY]]);
  });

  test('runs after the profile and nickname, which still go out unchanged', async () => {
    const h = harness();
    h.roles.held = COLOUR_ROLE;

    await h.listen(guildAvailable(BLANK), FULL);

    expect(h.bodies()).toEqual([
      { avatar: PNG_DATA_URI, banner: PNG_DATA_URI, bio: 'The friendly one.' },
      { nick: 'Dreamliner' },
    ]);
    expect(h.calls().at(-1)).toEqual(
      expect.objectContaining({ method: 'DELETE', path: ROLE_PATH }),
    );
  });

  test('forgets a role Discord says is already gone', async () => {
    const h = harness();
    h.roles.held = COLOUR_ROLE;
    h.rest.roleDeleteAnswer = { status: 404, body: { message: 'Unknown Role', code: 10011 } };

    await h.listen(guildAvailable(SETTLED), FULL);

    expect(roleCalls(h)).toHaveLength(1);
    expect(h.roles.held).toBeNull();
    expect(roleWarnings(h)).toEqual([]);
  });

  test('keeps the record without Manage Roles, names it, and asks once per reconnect', async () => {
    const h = harness({ botPermissions: WITHOUT_MANAGE_ROLES });
    h.roles.held = COLOUR_ROLE;

    await h.listen(guildAvailable(SETTLED), FULL);

    expect(roleCalls(h)).toEqual([]);
    expect(h.roles.held).toBe(COLOUR_ROLE);
    expect(h.roles.forgets).toBe(0);
    expect(deletions(h)).toBe(1);
    expect(roleWarnings(h)).toHaveLength(1);
    expect(roleWarnings(h)[0]?.message).toContain('Manage Roles permission in this server');

    await h.listen(guildAvailable(SETTLED), FULL);

    expect(deletions(h)).toBe(2);
    expect(roleWarnings(h)).toHaveLength(2);
    expect(h.roles.held).toBe(COLOUR_ROLE);
  });

  test('keeps the record when the role sits at or above Proton’s highest role', async () => {
    for (const colourRolePosition of [BOT_ROLE_POSITION, BOT_ROLE_POSITION + 3]) {
      const h = harness({ colourRolePosition });
      h.roles.held = COLOUR_ROLE;

      await h.listen(guildAvailable(SETTLED), FULL);

      expect(roleCalls(h)).toEqual([]);
      expect(h.roles.held).toBe(COLOUR_ROLE);
      expect(deletions(h)).toBe(1);
      expect(roleWarnings(h)[0]?.message).toContain('above or equal to my highest role');
    }
  });

  test('keeps the record when Discord refuses, and asks only once in that pass', async () => {
    const h = harness();
    h.roles.held = COLOUR_ROLE;
    h.rest.roleDeleteAnswer = {
      status: 403,
      body: { message: 'Missing Permissions', code: 50013 },
    };

    await h.listen(guildAvailable(SETTLED), FULL);

    expect(roleCalls(h)).toHaveLength(1);
    expect(h.roles.held).toBe(COLOUR_ROLE);
    expect(roleWarnings(h)).toHaveLength(1);
  });

  test('never deletes a role the store did not record', async () => {
    const h = harness();

    await h.listen(guildAvailable(BLANK), FULL);
    await h.listen(configChanged(), FULL);
    await h.command(FULL);

    expect(roleCalls(h)).toEqual([]);
    expect(h.kinds()).not.toContain('delete_role');
  });
});

describe('deleting the colour role when Branding is saved', () => {
  test('an enabled save deletes the recorded role under the same key as a reconnect', async () => {
    const h = harness();
    h.roles.held = COLOUR_ROLE;

    await h.listen(configChanged({ auditId: 'audit-9' }), FULL);

    expect(roleCalls(h)).toEqual([expect.objectContaining({ method: 'DELETE', path: ROLE_PATH })]);
    expect(h.keys()).toEqual([
      `branding:${GUILD}:audit-9:profile`,
      `branding:${GUILD}:audit-9:nickname`,
      ROLE_KEY,
    ]);
    expect(h.roles.held).toBeNull();
  });

  test('a save of only the display name style still cleans up', async () => {
    const h = harness();
    h.roles.held = COLOUR_ROLE;

    await h.listen(configChanged({ changedKeys: ['displayNameStyle'] }), FULL);

    expect(roleCalls(h)).toHaveLength(1);
    expect(h.roles.held).toBeNull();
  });

  test('a save and a reconnect that both find the record delete the role once', async () => {
    const h = harness();
    h.roles.get = async () => COLOUR_ROLE;

    await h.listen(configChanged(), FULL);
    await h.listen(guildAvailable(SETTLED), FULL);

    expect(deletions(h)).toBe(2);
    expect(roleCalls(h)).toHaveLength(1);
    expect(h.roles.forgets).toBe(1);
  });

  test('a save without Manage Roles asks once and keeps the record', async () => {
    const h = harness({ botPermissions: WITHOUT_MANAGE_ROLES });
    h.roles.held = COLOUR_ROLE;

    await h.listen(configChanged(), FULL);

    expect(deletions(h)).toBe(1);
    expect(h.roles.held).toBe(COLOUR_ROLE);
    expect(roleWarnings(h)).toHaveLength(1);
  });

  test('switching Branding off leaves the role alone', async () => {
    const h = harness();
    h.roles.held = COLOUR_ROLE;

    await h.listen(configChanged({ enabledBefore: true, enabledAfter: false }), {
      ...FULL,
      enabled: false,
    });

    expect(roleCalls(h)).toEqual([]);
    expect(h.roles.held).toBe(COLOUR_ROLE);
  });

  test('a save to a module that was already off leaves the role alone', async () => {
    const h = harness();
    h.roles.held = COLOUR_ROLE;

    await h.listen(configChanged({ enabledBefore: false, enabledAfter: false }), {
      ...FULL,
      enabled: false,
    });

    expect(roleCalls(h)).toEqual([]);
  });
});

describe('no colour anywhere', () => {
  test('a stored row still carrying a colour sends no colour and no role request on any path', async () => {
    const config = brandingConfigSchema.parse(liftStoredConfig({ ...KEPT, ...RETIRED }));
    const off = { ...config, enabled: false, restoreOnDisable: true };

    const runs: Array<(h: Harness) => Promise<void>> = [
      (h) => h.listen(configChanged({ changedKeys: [] }), config),
      (h) => h.listen(guildAvailable(BLANK), config),
      (h) => h.listen(configChanged({ enabledBefore: true, enabledAfter: false }), off),
      (h) => h.command(config),
    ];

    for (const run of runs) {
      const h = harness();
      await run(h);

      const bodies = h.calls().map((call) => JSON.stringify(call.body ?? {}));
      expect(h.calls().length).toBeGreaterThan(0);
      expect(roleCalls(h)).toEqual([]);
      expect(bodies.filter((body) => COLOUR_FIELD.test(body))).toEqual([]);
    }
  });
});

describe('the manifest', () => {
  const DECLARED = [
    'set_bot_nickname',
    'set_bot_profile',
    'set_bot_name_style',
    'delete_role',
    'interaction_reply',
    'interaction_followup',
  ];

  test('declares exactly the kinds Branding issues, and none of the colour kinds', () => {
    const declared: readonly string[] = brandingModule.actionKinds ?? [];

    expect(declared).toEqual(DECLARED);
    for (const retired of ['create_role', 'edit_role', 'add_bot_role', 'remove_bot_role']) {
      expect(declared).not.toContain(retired);
    }
  });

  test('every declared kind is issued somewhere, and nothing undeclared is', async () => {
    const h = harness();
    h.roles.held = COLOUR_ROLE;

    await h.listen(configChanged({ changedKeys: [] }), { ...FULL, displayNameStyle: STYLE });
    await h.listen(configChanged({ enabledBefore: true, enabledAfter: false }), {
      ...FULL,
      enabled: false,
    });
    await h.command({ ...FULL, displayNameStyle: STYLE });

    expect([...new Set<string>(h.kinds())].sort()).toEqual([...DECLARED].sort());
  });
});
