import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  appealPanelsSchema,
  appealsConfigSchema,
  appealsDefaultConfig,
  appealsFormSchema,
} from '../src/config.ts';
import { appealsModule } from '../src/index.ts';

function registry(): ModuleRegistry {
  const built = new ModuleRegistry();
  built.register(appealsModule);
  return built;
}

describe('the manifest', () => {
  test('ships defaults its own schema accepts, and that review nothing', () => {
    expect(appealsConfigSchema.safeParse(appealsDefaultConfig).success).toBe(true);
    expect(appealsDefaultConfig.enabled).toBe(false);
    expect(appealsDefaultConfig.panels).toEqual([]);
  });

  test('keeps the forms out of the generated form, which cannot render them', () => {
    const paths = registry()
      .descriptors('appeals')
      .map((descriptor) => descriptor.path);

    expect(paths).not.toContain('panels');
    expect(Object.keys(appealsConfigSchema.shape)).toContain('panels');
    expect(new Set(paths)).toEqual(new Set(Object.keys(appealsFormSchema.shape)));
  });

  test('runs on the one unprivileged intent — it reads no message and watches no member', () => {
    expect(appealsModule.requiredIntents).toEqual([GatewayIntentBits.Guilds]);
  });

  test('asks for Ban Members, which is what accepting an appeal usually means', () => {
    expect(appealsModule.requiredPermissions).toEqual([Permissions.BanMembers]);
  });

  // An undeclared kind is not caught at registration; it throws mid-run, out of the handler.
  test('declares every kind a review can execute', () => {
    const declared = new Set(appealsModule.actionKinds);

    for (const kind of [
      'interaction_reply',
      'interaction_followup',
      'send',
      'edit_message',
      'unban',
      'untimeout',
      'create_dm',
    ] as const) {
      expect(`${kind}: ${declared.has(kind)}`).toBe(`${kind}: true`);
    }
  });

  test('listens for a submitted appeal and for the buttons on its card', () => {
    expect(appealsModule.listeners?.map((listener) => listener.types)).toEqual([
      ['appeals.submitted'],
      ['interaction.component'],
    ]);
  });

  test('emits the decision, so Server Logs can carry it', () => {
    expect(appealsModule.emits).toEqual(['appeals.decided']);
  });

  test('caps the form list at the tier limit, which only a save can enforce', () => {
    expect(appealsModule.configLimits).toEqual([{ key: 'appealPanels', path: 'panels' }]);
  });

  test('books no scheduled work — an appeal waits on a person, not a clock', () => {
    expect(appealsModule.schedules).toBeUndefined();
  });

  test('every dashboard section names a real config key', () => {
    const keys = new Set(Object.keys(appealsConfigSchema.shape));
    const claimed = appealsModule.dashboard?.sections.flatMap((section) => section.fields) ?? [];

    expect(claimed.length).toBeGreaterThan(0);
    for (const field of claimed) expect(keys.has(field)).toBe(true);
  });
});

describe('the forms', () => {
  const form = {
    id: 'ban',
    name: 'Ban appeal',
    questions: [{ key: 'why', label: 'Why?' }],
  };

  test('refuses two forms sharing an id, because a honeypot points at one by id', () => {
    const parsed = appealPanelsSchema.safeParse([form, { ...form, name: 'Other' }]);

    expect(parsed.success).toBe(false);
  });

  test('refuses two questions sharing a key, because one answer would overwrite the other', () => {
    const parsed = appealPanelsSchema.safeParse([
      {
        ...form,
        questions: [
          { key: 'why', label: 'A' },
          { key: 'why', label: 'B' },
        ],
      },
    ]);

    expect(parsed.success).toBe(false);
  });

  test('takes a form with one question and fills the rest in', () => {
    const parsed = appealPanelsSchema.parse([form]);

    expect(parsed[0]?.enabled).toBe(true);
    expect(parsed[0]?.onApprove).toBe('unban');
    expect(parsed[0]?.windowDays).toBe(30);
  });

  test('refuses a form with no questions at all', () => {
    expect(appealPanelsSchema.safeParse([{ ...form, questions: [] }]).success).toBe(false);
  });
});
