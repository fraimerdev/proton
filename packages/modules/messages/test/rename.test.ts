import { describe, expect, test } from 'bun:test';
import { parseCustomId } from '@proton/core';
import { customIdFor, LEGACY_MODULE_ID, readComponentRef } from '../src/component-id.ts';
import { liftSavedEmbeds, MODULE_ID, messagesConfigSchema } from '../src/config.ts';
import { createMessagesModule } from '../src/index.ts';

const STORED_UNDER_THE_OLD_NAME = {
  enabled: true,
  saved: [
    {
      name: 'rules',
      content: 'Read these first.',
      embeds: [{ description: 'Be kind.' }],
    },
  ],
};

/**
 * The rename's first hazard. Zod strips what it does not know, so a row still carrying `saved`
 * parses to an empty template list and the next write persists that loss. The 0017 migration
 * rewrites the stored rows; this is what catches a row the migration never reached.
 */
describe('a config written before the rename', () => {
  test('lifts saved into templates', () => {
    expect(liftSavedEmbeds(STORED_UNDER_THE_OLD_NAME)).toEqual({
      enabled: true,
      templates: STORED_UNDER_THE_OLD_NAME.saved,
    });
  });

  test('survives a parse with its messages intact, rather than coming back empty', () => {
    const parsed = messagesConfigSchema.parse(liftSavedEmbeds(STORED_UNDER_THE_OLD_NAME));

    expect(parsed.templates).toHaveLength(1);
    expect(parsed.templates[0]?.name).toBe('rules');
    expect(parsed.templates[0]?.content).toBe('Read these first.');
  });

  test('parsing it without the lift is exactly the loss the lift prevents', () => {
    expect(messagesConfigSchema.parse(STORED_UNDER_THE_OLD_NAME).templates).toEqual([]);
  });

  test('the manifest carries the lift, so the api applies it on every read and write', () => {
    expect(createMessagesModule().liftStoredConfig).toBe(liftSavedEmbeds);
  });

  test('a config already on the new shape is handed back untouched', () => {
    const current = { enabled: true, templates: [] };

    expect(liftSavedEmbeds(current)).toBe(current);
  });

  test('a row carrying both keeps the new one, because the old is what migration left behind', () => {
    const both = { enabled: true, saved: [{ name: 'stale' }], templates: [{ name: 'current' }] };

    expect(liftSavedEmbeds(both)).toBe(both);
  });

  test('anything that is not a config object passes straight through', () => {
    expect(liftSavedEmbeds(null)).toBeNull();
    expect(liftSavedEmbeds([1, 2])).toEqual([1, 2]);
    expect(liftSavedEmbeds('nope')).toBe('nope');
  });
});

/**
 * The rename's second hazard, and the one with no migration behind it: every button this module
 * ever posted is sitting in a channel carrying `proton:embeds:`, and a press that does not parse
 * is dropped with no reply and no log.
 */
describe('a button posted before the rename', () => {
  const legacyId = `proton:${LEGACY_MODULE_ID}:rules:accept`;

  test('the old prefix is what those buttons really carry', () => {
    expect(parseCustomId(legacyId)?.moduleId).toBe('embeds');
    expect(LEGACY_MODULE_ID).not.toBe(MODULE_ID);
  });

  test('still routes to its message and its key', () => {
    expect(readComponentRef(legacyId)).toEqual({ messageName: 'rules', key: 'accept' });
  });

  test('and so does one posted after the rename', () => {
    expect(readComponentRef(customIdFor('rules')('accept'))).toEqual({
      messageName: 'rules',
      key: 'accept',
    });
  });

  test('new ids are written under the new module id, not the legacy one', () => {
    expect(parseCustomId(customIdFor('rules')('accept'))?.moduleId).toBe(MODULE_ID);
  });

  test('another module’s id is still refused by both', () => {
    expect(readComponentRef('proton:rolemenu:colours:red')).toBeNull();
  });
});
