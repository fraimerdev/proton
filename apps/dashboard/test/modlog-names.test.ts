import { describe, expect, test } from 'bun:test';
import { MODERATION_ACTION_KINDS } from '@proton/core';
import { MODULE_LABELS } from '@proton/module-serverlog';
import { specForAction } from '@proton/module-serverlog/catalogue';
import { MODULE_BY_ID } from '../src/lib/modules/catalogue.ts';
import { CATEGORY_CONTENTS } from '../src/pages/serverlog/shared.tsx';

describe('Proton acting on its own is named alike in Discord and on the dashboard', () => {
  test.each(Object.entries(MODULE_LABELS))(
    '%s is "%s" in the mod log and in the case log',
    (moduleId, label) => {
      expect(MODULE_BY_ID.get(moduleId)?.label).toBe(label);
    },
  );
});

describe('the Server Logs categories say where Proton’s moderation lands', () => {
  test.each([...MODERATION_ACTION_KINDS])('a %s Proton performed is a Moderation log', (kind) => {
    expect(specForAction(kind)?.category).toBe('moderation');
  });

  test('Moderation names every kind of action Proton logs there, and Proton’s own among them', () => {
    const copy = CATEGORY_CONTENTS.moderation;

    for (const kind of ['Bans', 'unbans', 'kicks', 'timeouts', 'warnings', 'purges', 'slowmode']) {
      expect(copy).toContain(kind);
    }
    expect(copy).toContain('channel locks');
    expect(copy).toContain('through Proton');
  });

  test('the Proton category no longer claims its moderation actions', () => {
    expect(CATEGORY_CONTENTS.proton).not.toContain('moderation');
    expect(CATEGORY_CONTENTS.proton).toContain('other actions Proton took');
  });
});
