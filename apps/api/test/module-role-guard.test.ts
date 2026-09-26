import { describe, expect, test } from 'bun:test';
import type { ModuleManifest, ModuleRegistry } from '@proton/core';
import {
  type ApplicationsConfig,
  applicationsConfigSchema,
  applicationsDefaultConfig,
  grantedRoles,
} from '@proton/module-applications/config';
import {
  addedGrants,
  GRANT_UNCONFIRMED,
  ModuleConfigError,
  ModuleConfigService,
} from '../src/modules/service.ts';
import {
  ACCESS_WORDS,
  ADMIN_ROLE,
  buildConfig,
  buildForm,
  FakeMemberAccess,
  GUILD,
  HIGH_ROLE,
  LOW_ROLE,
  MANAGED_ROLE,
  MANAGER,
  OWNER,
  REVIEWER,
} from './application-fixtures.ts';
import { fakePostgres, pick } from './fake-postgres.ts';

const REFUSED_SETTINGS = /settings were not saved:\s*\S/;

const manifest = {
  id: 'applications',
  name: 'Applications',
  configSchema: applicationsConfigSchema,
  defaultConfig: applicationsDefaultConfig,
  schemaVersion: 1,
  grantedRoles,
} as unknown as ModuleManifest;

function withRoles(onAccept: string[], onSubmitRemove: string[] = []): ApplicationsConfig {
  return buildConfig({
    forms: [
      buildForm({
        actions: {
          onAccept: { addRoleIds: onAccept },
          onSubmit: { removeRoleIds: onSubmitRemove },
        },
      }),
    ],
  });
}

function service(stored: ApplicationsConfig | null = null, members = new FakeMemberAccess()) {
  const registry = {
    get: (id: string) => (id === manifest.id ? manifest : undefined),
    all: () => [manifest],
  } as unknown as ModuleRegistry;

  const { handle, queries } = fakePostgres((query) =>
    stored !== null && query.sql.includes('from "guild_modules"')
      ? [
          pick(query, {
            guild_id: GUILD,
            module_id: 'applications',
            enabled: true,
            config: stored,
            schema_version: 1,
            updated_by: OWNER,
            updated_at: '2026-09-01T00:00:00.000Z',
          }),
        ]
      : [],
  );

  Object.assign(handle.db, {
    transaction: async (work: (tx: typeof handle.db) => Promise<unknown>) => work(handle.db),
  });

  return {
    modules: new ModuleConfigService(handle, registry, { memberAccess: members }),
    queries,
    members,
  };
}

function save(
  config: ApplicationsConfig,
  actorId: string,
  source: 'dashboard' | 'command' = 'dashboard',
) {
  return {
    guildId: GUILD,
    moduleId: 'applications',
    config: config as unknown as Record<string, unknown>,
    actorId,
    source,
  };
}

async function refusal(promise: Promise<unknown>): Promise<ModuleConfigError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ModuleConfigError) return error;
    throw error;
  }
  throw new Error('expected the save to be refused');
}

function inserts(queries: { sql: string }[]): string[] {
  return queries.filter((query) => query.sql.startsWith('insert into')).map((query) => query.sql);
}

type Actions = Record<string, { addRoleIds?: string[]; removeRoleIds?: string[] }>;

function formsWith(...forms: [string, Actions][]): ApplicationsConfig {
  return buildConfig({
    forms: forms.map(([id, actions]) => buildForm({ id, name: `Form ${id}`, actions })),
  });
}

describe('addedGrants', () => {
  test('lists each newly granted or removed role once, with its path', () => {
    expect(
      addedGrants(manifest, withRoles([LOW_ROLE]), withRoles([LOW_ROLE, HIGH_ROLE], [HIGH_ROLE])),
    ).toEqual([
      {
        path: 'forms.0.actions.onSubmit.removeRoleIds',
        roleId: HIGH_ROLE,
        scope: 'mods:onSubmit:remove',
      },
    ]);
    expect(addedGrants(manifest, withRoles([HIGH_ROLE]), withRoles([HIGH_ROLE]))).toEqual([]);
    expect(addedGrants({}, withRoles([]), withRoles([HIGH_ROLE]))).toEqual([]);
  });

  test('a role moved from a remove list to an add list in the same form is a new grant', () => {
    const before = formsWith(['mods', { onAccept: { removeRoleIds: [ADMIN_ROLE] } }]);
    const after = formsWith(['mods', { onAccept: { addRoleIds: [ADMIN_ROLE] } }]);

    expect(addedGrants(manifest, before, after)).toEqual([
      {
        path: 'forms.0.actions.onAccept.addRoleIds',
        roleId: ADMIN_ROLE,
        scope: 'mods:onAccept:add',
      },
    ]);
  });

  test('a role copied into another form’s submit list is a new grant', () => {
    const before = formsWith(['mods', { onAccept: { addRoleIds: [ADMIN_ROLE] } }], ['events', {}]);
    const after = formsWith(
      ['mods', { onAccept: { addRoleIds: [ADMIN_ROLE] } }],
      ['events', { onSubmit: { addRoleIds: [ADMIN_ROLE] } }],
    );

    expect(addedGrants(manifest, before, after)).toEqual([
      {
        path: 'forms.1.actions.onSubmit.addRoleIds',
        roleId: ADMIN_ROLE,
        scope: 'events:onSubmit:add',
      },
    ]);
  });

  test('a role moved from accept to submit in the same form is a new grant', () => {
    const before = formsWith(['mods', { onAccept: { addRoleIds: [ADMIN_ROLE] } }]);
    const after = formsWith(['mods', { onSubmit: { addRoleIds: [ADMIN_ROLE] } }]);

    expect(addedGrants(manifest, before, after).map((grant) => grant.path)).toEqual([
      'forms.0.actions.onSubmit.addRoleIds',
    ]);
  });

  test('reordering forms grants nothing new', () => {
    const mods: [string, Actions] = ['mods', { onAccept: { addRoleIds: [ADMIN_ROLE] } }];
    const events: [string, Actions] = ['events', { onSubmit: { addRoleIds: [HIGH_ROLE] } }];

    expect(addedGrants(manifest, formsWith(mods, events), formsWith(events, mods))).toEqual([]);
  });
});

describe('the role grant guard keyed by where a role is given', () => {
  test('refuses a held role copied into another form’s submit list', async () => {
    const stored = formsWith(['mods', { onAccept: { addRoleIds: [ADMIN_ROLE] } }], ['events', {}]);
    const { modules, queries } = service(stored);

    const error = await refusal(
      modules.update(
        save(
          formsWith(
            ['mods', { onAccept: { addRoleIds: [ADMIN_ROLE] } }],
            ['events', { onSubmit: { addRoleIds: [ADMIN_ROLE] } }],
          ),
          MANAGER,
        ),
      ),
    );

    expect(error.code).toBe('invalid_config');
    expect(error.message).toContain('forms.1.actions.onSubmit.addRoleIds');
    expect(inserts(queries)).toEqual([]);
  });

  test('refuses a held role moved from accept to submit, or from a remove list to an add list', async () => {
    const accepted = formsWith(['mods', { onAccept: { addRoleIds: [ADMIN_ROLE] } }]);
    const moved = await refusal(
      service(accepted).modules.update(
        save(formsWith(['mods', { onSubmit: { addRoleIds: [ADMIN_ROLE] } }]), MANAGER),
      ),
    );
    expect(moved.message).toContain('forms.0.actions.onSubmit.addRoleIds');

    const removed = formsWith(['mods', { onReject: { removeRoleIds: [ADMIN_ROLE] } }]);
    const flipped = await refusal(
      service(removed).modules.update(
        save(formsWith(['mods', { onReject: { addRoleIds: [ADMIN_ROLE] } }]), MANAGER),
      ),
    );
    expect(flipped.message).toContain('forms.0.actions.onReject.addRoleIds');
  });

  test('reordering forms is not checked again', async () => {
    const mods: [string, Actions] = ['mods', { onAccept: { addRoleIds: [ADMIN_ROLE] } }];
    const events: [string, Actions] = ['events', {}];
    const { modules, members } = service(formsWith(mods, events));

    await modules.update(save(formsWith(events, mods), MANAGER));
    expect(members.reads).toEqual([]);
  });

  test('the owner can still move a role anywhere', async () => {
    const { modules } = service(formsWith(['mods', { onAccept: { addRoleIds: [ADMIN_ROLE] } }]));

    const result = await modules.update(
      save(formsWith(['mods', { onSubmit: { addRoleIds: [ADMIN_ROLE] } }]), OWNER),
    );
    expect(result.after.config).toMatchObject({
      forms: [{ actions: { onSubmit: { addRoleIds: [ADMIN_ROLE] } } }],
    });
  });
});

describe('the role grant guard on a dashboard save', () => {
  test('refuses a role at or above the saver’s highest role, naming the field', async () => {
    const { modules, queries } = service();

    const error = await refusal(modules.update(save(withRoles([ADMIN_ROLE]), MANAGER)));

    expect(error.code).toBe('invalid_config');
    expect(error.message).toStartWith(
      'Those Applications settings were not saved: forms.0.actions.onAccept.addRoleIds ',
    );
    expect(error.message).toContain(`<@&${ADMIN_ROLE}>`);
    expect(error.message).toMatch(REFUSED_SETTINGS);
    expect(error.message).not.toMatch(ACCESS_WORDS);
    expect(inserts(queries)).toEqual([]);
  });

  test('refuses a role the saver could strip but not grant, on the remove list too', async () => {
    const { modules } = service();

    const error = await refusal(modules.update(save(withRoles([], [ADMIN_ROLE]), MANAGER)));
    expect(error.message).toContain('forms.0.actions.onSubmit.removeRoleIds');
  });

  test('lets a saver give out a role below their own', async () => {
    const { modules, queries } = service();

    const result = await modules.update(save(withRoles([HIGH_ROLE]), MANAGER));

    expect(result.after.config).toMatchObject({
      forms: [{ actions: { onAccept: { addRoleIds: [HIGH_ROLE] } } }],
    });
    expect(inserts(queries)).toHaveLength(2);
  });

  test('lets the owner give out any role Discord allows, but never a managed one', async () => {
    const { modules } = service();

    await modules.update(save(withRoles([ADMIN_ROLE]), OWNER));

    const error = await refusal(modules.update(save(withRoles([MANAGED_ROLE]), OWNER)));
    expect(error.message).toContain('managed by Discord or an integration');
  });

  test('a saver without Manage Roles is refused', async () => {
    const { modules } = service();

    const error = await refusal(modules.update(save(withRoles([LOW_ROLE]), REVIEWER)));
    expect(error.message).toContain('Manage Roles');
  });

  test('roles already in the saved config are not checked again', async () => {
    const { modules, members } = service(withRoles([ADMIN_ROLE]));

    await modules.update(save(withRoles([ADMIN_ROLE]), MANAGER));
    expect(members.reads).toEqual([]);
  });

  test('an unreadable member refuses the save instead of guessing', async () => {
    const members = new FakeMemberAccess();
    members.unavailable.add(MANAGER);
    const { modules, queries } = service(null, members);

    const error = await refusal(modules.update(save(withRoles([LOW_ROLE]), MANAGER)));

    expect(error.code).toBe('role_check_unavailable');
    expect(error.message).toBe(
      `Those Applications settings were not saved: forms.0.actions.onAccept.addRoleIds ${GRANT_UNCONFIRMED}`,
    );
    expect(error.message).toMatch(REFUSED_SETTINGS);
    expect(inserts(queries)).toEqual([]);
  });

  test('saves that do not come from the dashboard are not checked', async () => {
    const { modules, members } = service();

    await modules.update(save(withRoles([ADMIN_ROLE]), MANAGER, 'command'));
    expect(members.reads).toEqual([]);
  });

  test('without a member reader wired, a new grant is refused', async () => {
    const registry = {
      get: () => manifest,
      all: () => [manifest],
    } as unknown as ModuleRegistry;
    const { handle } = fakePostgres();
    const modules = new ModuleConfigService(handle, registry);

    const error = await refusal(modules.update(save(withRoles([LOW_ROLE]), OWNER)));
    expect(error.code).toBe('role_check_unavailable');
  });
});
