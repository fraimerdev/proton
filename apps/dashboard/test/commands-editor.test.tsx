import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandView } from '@proton/core';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type CommandEdits,
  draftIssues,
  draftOf,
  flatFields,
  mapServerIssues,
  NO_EDITS,
  NO_SERVER_ISSUES,
  type ServerIssues,
  withDescription,
  withName,
  withOption,
  withPrivateReply,
  withSavedNameCleared,
} from '../src/pages/commands/draft.ts';
import { MODERATION_REPLY, viewOf } from './commands-views.ts';

const QUERIES = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'queries.ts'), 'utf8');

mock.module('../src/lib/queries.ts', () =>
  Object.fromEntries(
    [...QUERIES.matchAll(/^export (?:function|const) (\w+)/gm)].map(([, name]) => [
      name,
      () => ({ queryKey: ['stub', name], queryFn: async () => null, enabled: false }),
    ]),
  ),
);

const {
  CommandEditor,
  CommandEditorActions,
  commandFooterNote,
  DESCRIPTION_HINT,
  RENAME_CAVEAT,
  RESPOND_PRIVATELY,
  replyDefaultNote,
} = await import('../src/pages/commands/editor.tsx');
const { replySummary } = await import('../src/pages/commands/draft.ts');

const noop = (): void => undefined;

function editor(
  command: CommandView,
  edits: CommandEdits = NO_EDITS,
  server: ServerIssues = NO_SERVER_ISSUES,
): string {
  const draft = draftOf(command, edits);

  return renderToStaticMarkup(
    <CommandEditor
      command={command}
      draft={draft}
      live={draftIssues(command, draft)}
      server={server}
      onName={noop}
      onClearSavedName={noop}
      onDescription={noop}
      onOption={noop}
      onPrivateReply={noop}
    />,
  );
}

function stripTags(markup: string): string {
  return markup.replace(/<[^>]+>/g, '').trim();
}

function buttonTexts(markup: string): string[] {
  return [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    stripTags(match[1] ?? ''),
  );
}

function disabledButtons(markup: string): string[] {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter((match) => /\sdisabled=""/.test(match[1] ?? ''))
    .map((match) => stripTags(match[2] ?? ''));
}

function inputValues(markup: string): string[] {
  return [...markup.matchAll(/<input\b[^>]*\svalue="([^"]*)"/g)].map((match) => match[1] ?? '');
}

function placeholders(markup: string): string[] {
  return [...markup.matchAll(/<input\b[^>]*\splaceholder="([^"]*)"/g)].map(
    (match) => match[1] ?? '',
  );
}

function decode(text: string): string {
  return text
    .replace(/&#x27;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

describe('the command name field', () => {
  test('is prefilled with the name members see, behind a slash that is not part of it', () => {
    const markup = editor(viewOf('ban', { settings: { name: 'bonk' } }));

    expect(markup).toMatch(/class="prefixed-input[^"]* command-name"/);
    expect(markup).toMatch(/<span class="prefixed-input-prefix" aria-hidden="true">\/<\/span>/);
    expect(inputValues(markup)[0]).toBe('bonk');
    expect(markup).toContain('Default: /ban');
  });

  test('warns about Discord permissions only once the name moves', () => {
    const ban = viewOf('ban');

    expect(editor(ban)).not.toContain('Renaming removes');
    expect(decode(editor(ban, withName(NO_EDITS, 'bonk')))).toContain(RENAME_CAVEAT);
  });

  test('says Proton’s own messages follow the rename, as they now do', () => {
    expect(RENAME_CAVEAT).toContain('Proton’s own messages use the new name once Discord has it.');
    expect(RENAME_CAVEAT).not.toContain('keep calling');
  });

  test('a saved name Proton is not using is named under the field with a way to clear it', () => {
    const reason = 'Proton now has its own /kick, so this command is back to /ban.';
    const lost = viewOf('ban', {
      settings: { name: 'kick' },
      effectiveName: 'ban',
      ignored: reason,
    });
    const markup = decode(editor(lost));

    expect(inputValues(markup)[0]).toBe('ban');
    expect(stripTags(markup)).toContain(`Saved name /kick isn’t in use: ${reason}`);
    expect(buttonTexts(markup)).toContain('Clear saved name');
    expect(markup).not.toContain('Renaming removes');

    expect(buttonTexts(editor(lost, withSavedNameCleared(NO_EDITS)))).not.toContain(
      'Clear saved name',
    );

    const renamed = decode(editor(lost, withName(NO_EDITS, 'bonk')));
    expect(renamed).toContain(RENAME_CAVEAT);
    expect(buttonTexts(renamed)).not.toContain('Clear saved name');
  });

  test('a customization Discord refused opens with the name it was saved with', () => {
    const refused = viewOf('ban', {
      settings: { name: 'bonk', description: 'x'.repeat(101) },
      effectiveName: 'ban',
      ignored: 'Discord would refuse this command as customized, so it uses Proton’s defaults.',
      refused: true,
    });
    const markup = decode(editor(refused));

    expect(inputValues(markup)[0]).toBe('bonk');
    expect(markup).toContain(RENAME_CAVEAT);
    expect(markup).toContain('Descriptions can be at most 100 characters (this one is 101).');
    expect(buttonTexts(markup)).not.toContain('Clear saved name');
  });

  test('shows the name Discord would refuse', () => {
    const markup = editor(viewOf('ban'), withName(NO_EDITS, 'two words'));

    expect(markup).toMatch(/class="prefixed-input[^"]* command-name" data-invalid="true"/);
    expect(markup).toContain('no spaces');
  });
});

describe('the description field', () => {
  test('is empty with Proton’s default as the placeholder, and says blank inherits', () => {
    const ban = viewOf('ban');
    const markup = decode(editor(ban));

    expect(placeholders(markup)).toContain(ban.description);
    expect(markup).toContain(DESCRIPTION_HINT);
    expect(inputValues(markup)[1]).toBe('');
    expect(markup).not.toContain('/ 100');
  });

  test('shows a counter once past 80 characters and the limit past 100', () => {
    expect(editor(viewOf('ban'), withDescription(NO_EDITS, 'x'.repeat(81)))).toContain(
      '<span class="command-counter">81 / 100</span>',
    );
    expect(editor(viewOf('ban'), withDescription(NO_EDITS, 'x'.repeat(101)))).toContain(
      'Descriptions can be at most 100 characters (this one is 101).',
    );
  });
});

describe('options', () => {
  test('a flat command lists each option under a fixed mono label with its type', () => {
    const markup = editor(viewOf('kick'));

    expect(markup).toContain('>Options</h3>');
    expect(markup).toMatch(
      /<label class="field-label mono"[^>]*>user<span class="visually-hidden"> in \/kick<\/span>/,
    );
    expect(markup).toContain('User · required');
    expect(markup).toContain('>Text</span>');
  });

  test('subcommands get their own section with their own description, in code order', () => {
    const markup = editor(viewOf('ban'));
    const titles = [
      ...markup.matchAll(/<h3 class="command-section-title"><span class="mono">([^<]+)<\/span>/g),
    ].map((match) => match[1]);

    expect(titles).toEqual(['/ban add', '/ban remove']);
    expect(markup).not.toContain('command-section-toggle');
    expect(markup).toContain('Description<span class="visually-hidden"> of /ban add</span>');
  });

  test('sections follow a rename as it is typed', () => {
    expect(editor(viewOf('ban'), withName(NO_EDITS, 'bonk'))).toContain('/bonk add');
  });

  test('the big commands start collapsed, one toggle per subcommand', () => {
    const giveaway = viewOf('giveaway');
    const markup = editor(giveaway);
    const toggles = [
      ...markup.matchAll(
        /<button type="button" class="command-section-toggle" aria-expanded="(true|false)"/g,
      ),
    ];

    expect(toggles).toHaveLength(28);
    expect(toggles.every((match) => match[1] === 'false')).toBe(true);
    expect(markup).not.toContain('command-section-body');
    expect(markup.match(/command-group-label/g)).toHaveLength(3);
  });

  test('a section holding an override or an error starts open', () => {
    const giveaway = viewOf('giveaway');
    const first = flatFields(giveaway.fields).find((field) => field.kind === 'subcommand');
    const second = flatFields(giveaway.fields).filter((field) => field.kind === 'subcommand')[1];
    if (!first || !second) throw new Error('giveaway has no subcommands');

    const markup = editor(
      giveaway,
      withOption(withOption(NO_EDITS, first.path, 'Custom'), second.path, 'z'.repeat(101)),
    );
    const open = [...markup.matchAll(/class="command-section-toggle" aria-expanded="true"/g)];

    expect(open).toHaveLength(2);
    expect(markup).toContain('Customized');
  });

  test('an issue the server returned opens its section and marks its field', () => {
    const giveaway = viewOf('giveaway');
    const option = flatFields(giveaway.fields).find((field) => field.kind === 'option');
    if (!option) throw new Error('giveaway has no options');

    const markup = editor(
      giveaway,
      NO_EDITS,
      mapServerIssues(giveaway, [{ path: `options.${option.path}`, message: 'Refused here.' }]),
    );

    expect(markup).toContain('Refused here.');
    expect(markup).toContain('aria-expanded="true"');
  });
});

describe('dialog-level alerts', () => {
  test('the size limit and issues without a field are shown above the fields', () => {
    const markup = editor(
      viewOf('ban'),
      NO_EDITS,
      mapServerIssues(viewOf('ban'), [
        { path: 'size', message: 'Discord allows 8000 characters per command.' },
        { path: 'privateReply', message: 'This command cannot reply privately.' },
      ]),
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Discord allows 8000 characters per command.');
    expect(markup).toContain('This command cannot reply privately.');
  });

  test('the footer counts toward 8000 only past 6000', () => {
    const giveaway = viewOf('giveaway');
    let edits = NO_EDITS;
    for (const field of flatFields(giveaway.fields)) {
      edits = withOption(edits, field.path, 'y'.repeat(80));
    }

    expect(commandFooterNote(viewOf('ban'), draftOf(viewOf('ban'), NO_EDITS))).toBeUndefined();
    expect(commandFooterNote(giveaway, draftOf(giveaway, edits))).toMatch(/^\d+ \/ 8000$/);
  });
});

describe('Respond privately', () => {
  test('is absent for commands without a supported reply control', () => {
    expect(editor(viewOf('ban'))).not.toContain('Respond privately');
    expect(
      editor(
        viewOf('ban', {
          reply: {
            supported: false,
            paths: [{ path: 'add', default: 'private', toggleable: false }],
          },
        }),
      ),
    ).not.toContain('Respond privately');
  });

  test('shows the owner’s sentence, the inherited default and no reset while inheriting', () => {
    const view = viewOf('ban', { reply: MODERATION_REPLY });
    const markup = decode(editor(view));

    expect(markup).toContain('Respond privately');
    expect(markup).toContain(RESPOND_PRIVATELY);
    expect(markup).toContain('Default: private (follows Moderation → Reply publicly)');
    expect(markup).toMatch(/role="switch" aria-checked="true" aria-label="Respond privately"/);
    expect(buttonTexts(markup)).not.toContain('Use default');
    expect(markup).toContain('aria-label="More about Respond privately"');
  });

  test('an explicit choice shows itself and offers Use default', () => {
    const view = viewOf('ban', { reply: MODERATION_REPLY });
    const markup = editor(view, withPrivateReply(NO_EDITS, false));

    expect(markup).toMatch(/role="switch" aria-checked="false" aria-label="Respond privately"/);
    expect(buttonTexts(markup)).toContain('Use default');
  });

  test('the note names a plain default when nothing is inherited', () => {
    const control = {
      supported: true,
      paths: [{ path: '', default: 'public' as const, toggleable: true }],
    };
    const view = viewOf('rank', { reply: control });

    expect(replyDefaultNote(view, replySummary(control))).toBe('Default: public');
  });
});

describe('the dialog’s actions', () => {
  const actions = (canReset: boolean, canSave: boolean, saving = false): string =>
    renderToStaticMarkup(
      <CommandEditorActions
        canReset={canReset}
        canSave={canSave}
        saving={saving}
        onReset={noop}
        onCancel={noop}
        onSave={noop}
      />,
    );

  test('read Reset to defaults, Cancel, Save changes, in that order', () => {
    expect(buttonTexts(actions(true, true))).toEqual([
      'Reset to defaults',
      'Cancel',
      'Save changes',
    ]);
    expect(actions(true, true)).toMatch(/class="button button-secondary push-right"[^>]*>Cancel/);
    expect(actions(true, true)).toMatch(/class="button button-primary"[^>]*>Save changes/);
  });

  test('disable Reset at the defaults and Save with nothing to save', () => {
    expect(disabledButtons(actions(false, true))).toEqual(['Reset to defaults']);
    expect(disabledButtons(actions(true, false))).toEqual(['Save changes']);
    expect(disabledButtons(actions(true, true, true))).toEqual([
      'Reset to defaults',
      'Cancel',
      'Save changes',
    ]);
  });
});
