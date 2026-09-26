import { describe, expect, test } from 'bun:test';
import {
  COMMAND_CHANGES,
  type ProtonCommandsChanged,
  protonCommandsChangedSchema,
} from '../../src/events/proton.ts';
import { EVENT_TYPES, isEventType, SERVICE_EMITTED_EVENT_TYPES } from '../../src/events/types.ts';

const GUILD = '900000000000000001';

const renamed: ProtonCommandsChanged = {
  auditId: 'aud_01',
  guildId: GUILD,
  actorId: '100000000000000001',
  source: 'dashboard',
  key: 'ban',
  displayName: 'ban',
  newName: 'punish',
  changed: ['name', 'description'],
  enabledBefore: true,
  enabledAfter: true,
  registration: true,
};

describe('proton.commands_changed', () => {
  test('is a declared event type, published by a service', () => {
    expect(isEventType('proton.commands_changed')).toBe(true);
    expect(SERVICE_EMITTED_EVENT_TYPES as readonly string[]).toContain('proton.commands_changed');
    expect(EVENT_TYPES.filter((type) => type === 'proton.commands_changed')).toHaveLength(1);
  });

  test('carries a rename with the name before and after it', () => {
    expect(protonCommandsChangedSchema.parse(renamed)).toEqual(renamed);
  });

  test('a change that is not a rename needs no new name', () => {
    const { newName: _newName, ...switchedOff } = {
      ...renamed,
      changed: ['enabled'],
      enabledAfter: false,
    };

    expect(protonCommandsChangedSchema.parse(switchedOff).newName).toBeNull();
  });

  test('a reply preference alone is marked as needing no registration', () => {
    const parsed = protonCommandsChangedSchema.parse({
      ...renamed,
      newName: null,
      changed: ['privateReply'],
      registration: false,
    });

    expect(parsed.registration).toBe(false);
    expect(parsed.changed).toEqual(['privateReply']);
  });

  test('names what changed, never the text it changed to', () => {
    expect(COMMAND_CHANGES).toEqual(['name', 'description', 'options', 'privateReply', 'enabled']);
    expect(
      protonCommandsChangedSchema.safeParse({ ...renamed, changed: ['Remove someone for good.'] })
        .success,
    ).toBe(false);
  });

  test('refuses a payload without a real guild or audit row', () => {
    expect(protonCommandsChangedSchema.safeParse({ ...renamed, guildId: 'nope' }).success).toBe(
      false,
    );
    expect(protonCommandsChangedSchema.safeParse({ ...renamed, auditId: '' }).success).toBe(false);
    expect(
      protonCommandsChangedSchema.safeParse({ ...renamed, registration: undefined }).success,
    ).toBe(false);
  });

  test('a menu key with a space and a colon is a valid key', () => {
    expect(
      protonCommandsChangedSchema.safeParse({
        ...renamed,
        key: 'user:Report user',
        displayName: 'Report user',
        newName: null,
        changed: ['enabled'],
      }).success,
    ).toBe(true);
  });
});
