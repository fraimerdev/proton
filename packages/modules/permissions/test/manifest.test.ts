import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, zodToDescriptors } from '@proton/core';
import { commandOverridesFormSchema, permissionsConfigSchema } from '../src/config.ts';
import { permissionsModule } from '../src/index.ts';

const MOD_ROLE = '410000000000000009';

describe('permissions manifest', () => {
  /**
   * Registration checks the default config against the schema and that the
   * dashboard can render it, so this one call is the module's contract test.
   */
  test('registers cleanly', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(permissionsModule)).not.toThrow();
    expect(registry.get('permissions')?.schemaVersion).toBe(1);
  });

  /** Enforcement gates other modules' commands, so this one ships none itself. */
  test('owns no commands and no listeners', () => {
    expect(permissionsModule.commands).toBeUndefined();
    expect(permissionsModule.listeners).toBeUndefined();
  });

  test('a fresh install restricts nothing', () => {
    expect(permissionsModule.defaultConfig.overrides).toEqual({});
  });
});

describe('permissions config', () => {
  test('an override maps a command name to role ids', () => {
    const parsed = permissionsConfigSchema.parse({ overrides: { ban: [MOD_ROLE] } });

    expect(parsed.enabled).toBe(true);
    expect(parsed.overrides.ban).toEqual([MOD_ROLE]);
  });

  test('a key that could never be a command name is refused on write', () => {
    const result = permissionsConfigSchema.safeParse({ overrides: { '/Ban': [MOD_ROLE] } });

    expect(result.success).toBe(false);
    // Says what a key must look like, rather than "invalid input".
    expect(result.error?.issues[0]?.message).toContain('lowercase');
  });

  test('a role id that is not a snowflake is refused on write', () => {
    const result = permissionsConfigSchema.safeParse({ overrides: { ban: ['@Moderator'] } });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['overrides', 'ban', 0]);
  });

  /**
   * The map's keys are the loaded commands — runtime data, not a static shape —
   * so the generator emits nothing for it and the dashboard builds the fields
   * from the live command list instead (§9).
   */
  test('the overrides map yields no generated field, but the per-command form does', () => {
    const paths = zodToDescriptors(permissionsConfigSchema).map((d) => d.path);
    expect(paths).toEqual(['enabled']);

    const fields = zodToDescriptors(commandOverridesFormSchema(['ban', 'ping']));

    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ path: 'ban', kind: 'role-id', array: true, label: '/ban' });
    expect(fields[1]).toMatchObject({ path: 'ping', kind: 'role-id', array: true });
  });

  test('the generated form accepts exactly what the stored map accepts', () => {
    const form = commandOverridesFormSchema(['ban']);

    expect(form.parse({ ban: [MOD_ROLE] })).toEqual({ ban: [MOD_ROLE] });
    expect(form.safeParse({ ban: ['not-an-id'] }).success).toBe(false);
    // An untouched picker submits nothing and means "no requirement".
    expect(form.parse({})).toEqual({ ban: [] });
  });
});
