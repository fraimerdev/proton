import { describe, expect, test } from 'bun:test';
import { Permissions, zodToDescriptors } from '@proton/core';
import { pingConfigSchema } from '@proton/module-ping';
import { getAtPath, setAtPath, toConfig, toFormValues } from '../src/lib/config-paths.ts';
import {
  accessGrants,
  administrableGuilds,
  type DiscordUserGuild,
  resolveGuildAccess,
  withPresence,
} from '../src/lib/guild-access.ts';

const OWNED: DiscordUserGuild = {
  id: '900000000000000001',
  name: 'Owned',
  icon: null,
  owner: true,
  permissions: '0',
};

const MANAGED: DiscordUserGuild = {
  id: '900000000000000002',
  name: 'Managed',
  icon: null,
  owner: false,
  permissions: String(Permissions.ManageGuild),
};

const MEMBER_ONLY: DiscordUserGuild = {
  id: '900000000000000003',
  name: 'Just a member',
  icon: null,
  owner: false,
  permissions: String(Permissions.ViewChannel | Permissions.SendMessages),
};

const GUILDS = [OWNED, MANAGED, MEMBER_ONLY];

describe('resolveGuildAccess', () => {
  test('grants access to an owner even with no permission bits set', () => {
    expect(resolveGuildAccess(GUILDS, OWNED.id)?.via).toBe('owner');
  });

  test('grants access via MANAGE_GUILD', () => {
    expect(resolveGuildAccess(GUILDS, MANAGED.id)?.via).toBe('manage_guild');
  });

  test('grants access via ADMINISTRATOR', () => {
    const admin: DiscordUserGuild = {
      ...MEMBER_ONLY,
      permissions: String(Permissions.Administrator),
    };

    expect(resolveGuildAccess([admin], admin.id)).not.toBeNull();
  });

  test('refuses an ordinary member', () => {
    expect(resolveGuildAccess(GUILDS, MEMBER_ONLY.id)).toBeNull();
  });

  test('refuses a guild the user is not in at all', () => {
    expect(resolveGuildAccess(GUILDS, '111111111111111111')).toBeNull();
  });

  test('refuses when the user has no guilds', () => {
    expect(resolveGuildAccess([], OWNED.id)).toBeNull();
  });

  test('parses high permission bits without precision loss', () => {
    const withHighBits: DiscordUserGuild = {
      ...MEMBER_ONLY,
      permissions: String(Permissions.ManageGuild | Permissions.BypassSlowmode),
    };

    const access = resolveGuildAccess([withHighBits], withHighBits.id);

    expect(access).not.toBeNull();
    expect(access?.permissions).toBe(Permissions.ManageGuild | Permissions.BypassSlowmode);
  });

  test('the picker offers only administrable guilds', () => {
    expect(administrableGuilds(GUILDS).map((g) => g.id)).toEqual([OWNED.id, MANAGED.id]);
  });
});

describe('withPresence', () => {
  test('marks the servers Proton is in and the ones it is not', () => {
    const marked = withPresence(GUILDS, new Set([MANAGED.id]));

    expect(marked.find((g) => g.id === MANAGED.id)?.present).toBe(true);
    expect(marked.find((g) => g.id === OWNED.id)?.present).toBe(false);
  });

  test('puts every server Proton is in ahead of the ones it is not', () => {
    const marked = withPresence(GUILDS, new Set([MEMBER_ONLY.id]));

    expect(marked.map((g) => g.id)).toEqual([MEMBER_ONLY.id, OWNED.id, MANAGED.id]);
  });

  test('leaves Discord’s own order alone within each half', () => {
    const marked = withPresence(GUILDS, new Set([OWNED.id, MANAGED.id, MEMBER_ONLY.id]));

    expect(marked.map((g) => g.id)).toEqual(GUILDS.map((g) => g.id));
  });

  test('an empty presence set leaves the list ordered, not reversed', () => {
    expect(withPresence(GUILDS, new Set()).map((g) => g.id)).toEqual(GUILDS.map((g) => g.id));
  });

  test('carries every field the picker renders through', () => {
    const [first] = withPresence([OWNED], new Set([OWNED.id]));

    expect(first).toEqual({ ...OWNED, present: true });
  });
});

describe('accessGrants', () => {
  test('an owner is granted anything', () => {
    const access = resolveGuildAccess(GUILDS, OWNED.id);

    expect(access && accessGrants(access, Permissions.ManageGuild)).toBe(true);
    expect(access && accessGrants(access, Permissions.BanMembers)).toBe(true);
  });

  test('a manager is granted MANAGE_GUILD but not everything', () => {
    const access = resolveGuildAccess(GUILDS, MANAGED.id);

    expect(access && accessGrants(access, Permissions.ManageGuild)).toBe(true);
    expect(access && accessGrants(access, Permissions.BanMembers)).toBe(false);
  });
});

describe('config path mapping', () => {
  const descriptors = zodToDescriptors(pingConfigSchema);

  test('round-trips a config through flat form values unchanged', () => {
    const config = { enabled: true, response: 'Pong!', restrictToChannel: null };

    expect(toConfig(descriptors, toFormValues(descriptors, config))).toEqual(config);
  });

  test('falls back to declared defaults for absent values', () => {
    const values = toFormValues(descriptors, {});

    expect(values.response).toBe('Pong!');
    expect(values.enabled).toBe(true);
  });

  test('drops values whose field is no longer in the schema', () => {
    const result = toConfig(descriptors, {
      enabled: true,
      response: 'Pong!',
      restrictToChannel: null,
      removedLastRelease: 'stale',
    });

    expect(result).not.toHaveProperty('removedLastRelease');
  });

  test('handles one level of nesting via dotted paths', () => {
    const target: Record<string, unknown> = {};
    setAtPath(target, 'limits.strict', true);

    expect(target).toEqual({ limits: { strict: true } });
    expect(getAtPath(target, 'limits.strict')).toBe(true);
    expect(getAtPath(target, 'limits.missing')).toBeUndefined();
    expect(getAtPath(target, 'nope.deep')).toBeUndefined();
  });
});
