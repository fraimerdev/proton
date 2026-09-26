import { describe, expect, test } from 'bun:test';
import { type ChatCommandData, commandSize } from '@proton/core';
import {
  adoptsFresher,
  atDefaults,
  baseDraft,
  changedFields,
  collapsesSections,
  defaultEdits,
  draftIssues,
  draftOf,
  draftSize,
  flatFields,
  hasIssues,
  isDirty,
  issueFor,
  mapServerIssues,
  NO_EDITS,
  NO_SERVER_ISSUES,
  nameCaret,
  nameInput,
  rebaseEdits,
  replyShown,
  replySummary,
  rootOptions,
  sectionGroups,
  sectionHasIssue,
  sectionHasOverride,
  showCounter,
  spokenPath,
  subcommandCount,
  submission,
  withDescription,
  withName,
  withOption,
  withoutServerIssue,
  withPrivateReply,
  withSavedNameCleared,
} from '../src/pages/commands/draft.ts';
import { CATALOGUE, MODERATION_REPLY, shippedData, viewOf } from './commands-views.ts';

const BAN = viewOf('ban');
const LONG = 'x'.repeat(101);

describe('the draft an edit starts from', () => {
  test('is the effective name, the stored overrides and blanks for everything inherited', () => {
    const view = viewOf('ban', {
      settings: {
        name: 'bonk',
        description: 'Bonk a member',
        optionDescriptions: { 'add.user': 'Who to bonk', 'gone.path': 'kept' },
        privateReply: true,
      },
    });
    const draft = baseDraft(view);

    expect(draft.name).toBe('bonk');
    expect(draft.description).toBe('Bonk a member');
    expect(draft.options['add.user']).toBe('Who to bonk');
    expect(draft.options['remove.user_id']).toBe('');
    expect(Object.hasOwn(draft.options, 'gone.path')).toBe(false);
    expect(draft.privateReply).toBe(true);
  });

  test('a name Proton ignored starts from the name members actually see', () => {
    const view = viewOf('ban', {
      settings: { name: 'kick' },
      effectiveName: 'ban',
      ignored: 'Proton now has its own /kick, so this command is back to /ban.',
    });

    expect(baseDraft(view).name).toBe('ban');
  });

  test('edits layer over the start and nothing else moves', () => {
    const edits = withOption(withDescription(withName(NO_EDITS, 'bonk'), 'Bonk'), 'add.user', 'U');
    const draft = draftOf(BAN, edits);

    expect(draft.name).toBe('bonk');
    expect(draft.description).toBe('Bonk');
    expect(draft.options['add.user']).toBe('U');
    expect(draft.options['add.reason']).toBe('');
    expect(draft.privateReply).toBeNull();
  });

  test('an edit that sets the reply back to the default is still an edit', () => {
    const view = viewOf('ban', { settings: { privateReply: false }, reply: MODERATION_REPLY });

    expect(draftOf(view, NO_EDITS).privateReply).toBe(false);
    expect(draftOf(view, withPrivateReply(NO_EDITS, null)).privateReply).toBeNull();
  });
});

describe('which fields changed', () => {
  test('nothing typed is not dirty, and typing the start back is not dirty either', () => {
    expect(isDirty(BAN, NO_EDITS)).toBe(false);
    expect(isDirty(BAN, withName(NO_EDITS, 'ban'))).toBe(false);
    expect(isDirty(BAN, withName(NO_EDITS, ' ban '))).toBe(false);
    expect(isDirty(BAN, withName(NO_EDITS, ''))).toBe(false);
    expect(isDirty(BAN, withOption(NO_EDITS, 'add.user', '   '))).toBe(false);
  });

  test('each kind of change is named once', () => {
    const edits = withPrivateReply(
      withOption(
        withOption(withDescription(withName(NO_EDITS, 'bonk'), 'B'), 'add.user', 'U'),
        'remove.user_id',
        'R',
      ),
      true,
    );

    expect(changedFields(BAN, edits)).toEqual(['name', 'description', 'options', 'privateReply']);
    expect(changedFields(BAN, withDescription(NO_EDITS, 'B'))).toEqual(['description']);
  });
});

describe('Reset to defaults', () => {
  const custom = viewOf('ban', {
    settings: {
      enabled: false,
      name: 'bonk',
      description: 'Bonk',
      optionDescriptions: { 'add.user': 'U' },
      privateReply: true,
    },
    reply: MODERATION_REPLY,
  });

  test('clears every customization in the draft only', () => {
    const edits = defaultEdits(custom);
    const draft = draftOf(custom, edits);

    expect(draft.name).toBe('ban');
    expect(draft.description).toBe('');
    expect(Object.values(draft.options).every((value) => value === '')).toBe(true);
    expect(draft.privateReply).toBeNull();
    expect(custom.settings.name).toBe('bonk');
  });

  test('never touches the switch', () => {
    expect(submission(custom, defaultEdits(custom))).not.toHaveProperty('enabled');
  });

  test('is offered only while the draft differs from the defaults', () => {
    expect(atDefaults(BAN, NO_EDITS)).toBe(true);
    expect(atDefaults(custom, NO_EDITS)).toBe(false);
    expect(atDefaults(custom, defaultEdits(custom))).toBe(true);
    expect(atDefaults(BAN, withDescription(NO_EDITS, BAN.description))).toBe(true);
    expect(atDefaults(BAN, withPrivateReply(NO_EDITS, false))).toBe(false);
  });
});

describe('the save body', () => {
  test('carries the staleness tokens and trims, dropping blanks', () => {
    const view = viewOf('ban', { settings: { updatedAt: '2026-09-22T10:00:00.000Z' } });
    const body = submission(
      view,
      withOption(
        withOption(withDescription(withName(NO_EDITS, '  bonk '), '  '), 'add.user', ' Who '),
        'add.reason',
        '',
      ),
    );

    expect(body).toEqual({
      name: 'bonk',
      description: null,
      optionDescriptions: { 'add.user': 'Who' },
      privateReply: null,
      expectedUpdatedAt: '2026-09-22T10:00:00.000Z',
      definitionHash: 'hash-ban',
    });
  });

  test('a blank name asks for the default', () => {
    expect(submission(BAN, withName(NO_EDITS, '')).name).toBeNull();
  });

  test('an untouched reply preference is sent exactly as stored', () => {
    const view = viewOf('ban', { settings: { privateReply: true }, reply: MODERATION_REPLY });

    expect(submission(view, withName(NO_EDITS, 'bonk')).privateReply).toBe(true);
    expect(submission(BAN, withName(NO_EDITS, 'bonk')).privateReply).toBeNull();
    expect(submission(view, withPrivateReply(NO_EDITS, null)).privateReply).toBeNull();
  });

  test('a preference the dialog does not show is sent back as stored, and only Reset clears it', () => {
    const hidden = viewOf('ban', { settings: { privateReply: true } });

    expect(submission(hidden, NO_EDITS).privateReply).toBe(true);
    expect(submission(hidden, withDescription(NO_EDITS, 'Bonk')).privateReply).toBe(true);
    expect(submission(hidden, defaultEdits(hidden)).privateReply).toBeNull();
  });
});

describe('the name input', () => {
  test('lowercases and drops a typed or pasted slash', () => {
    expect(nameInput('/Ban')).toBe('ban');
    expect(nameInput('BONK')).toBe('bonk');
    expect(nameInput('//x')).toBe('/x');
  });

  test('puts the caret back where it was in what was typed', () => {
    expect(nameCaret('lockDdown', 5)).toBe(5);
    expect(nameCaret('/Ban', 4)).toBe(3);
    expect(nameCaret('/Ban', 2)).toBe(1);
    expect(nameCaret('/ban', 0)).toBe(0);
    expect(nameCaret('ba/n', 3)).toBe(3);
  });
});

const KICK_TAKEN = 'Proton now has its own /kick, so this command is back to /ban.';
const REFUSED = 'Discord would refuse this command as customized, so it uses Proton’s defaults.';

describe('a saved name Proton is not using', () => {
  const lost = viewOf('ban', {
    settings: { name: 'kick', updatedAt: '2026-09-22T10:00:00.000Z' },
    effectiveName: 'ban',
    ignored: KICK_TAKEN,
    reply: MODERATION_REPLY,
  });

  test('stays out of the field, which shows the name members see', () => {
    expect(baseDraft(lost).name).toBe('ban');
    expect(baseDraft(lost).savedName).toBe('kick');
    expect(baseDraft(BAN).savedName).toBeNull();
    expect(baseDraft(viewOf('ban', { settings: { name: 'bonk' } })).savedName).toBeNull();
  });

  test('is sent back unchanged by a save that never touched the name', () => {
    expect(submission(lost, withDescription(NO_EDITS, 'Bonk')).name).toBe('kick');
    expect(submission(lost, withPrivateReply(NO_EDITS, true)).name).toBe('kick');
    expect(submission(lost, withName(NO_EDITS, 'ban')).name).toBe('kick');
    expect(changedFields(lost, withPrivateReply(NO_EDITS, true))).toEqual(['privateReply']);
  });

  test('is replaced by a name typed into the field', () => {
    expect(submission(lost, withName(NO_EDITS, 'bonk')).name).toBe('bonk');
  });

  test('can be cleared on its own, which is a change to save', () => {
    const cleared = withSavedNameCleared(NO_EDITS);

    expect(draftOf(lost, cleared).savedName).toBeNull();
    expect(changedFields(lost, cleared)).toEqual(['name']);
    expect(submission(lost, cleared).name).toBeNull();
  });

  test('keeps the command off its defaults, so Reset then Save clears it', () => {
    expect(atDefaults(lost, NO_EDITS)).toBe(false);
    expect(atDefaults(lost, defaultEdits(lost))).toBe(true);
    expect(isDirty(lost, defaultEdits(lost))).toBe(true);
    expect(submission(lost, defaultEdits(lost)).name).toBeNull();
  });

  test('a clear survives a rebase only while the name is still saved and unused', () => {
    const later = viewOf('ban', {
      settings: { name: 'kick', description: 'Theirs', updatedAt: '2026-09-22T10:05:00.000Z' },
      effectiveName: 'ban',
      ignored: KICK_TAKEN,
    });
    const cleared = withSavedNameCleared(NO_EDITS);

    expect(rebaseEdits(lost, later, cleared).savedNameCleared).toBe(true);
    expect(rebaseEdits(lost, viewOf('ban'), cleared)).not.toHaveProperty('savedNameCleared');
  });
});

describe('a customization Discord would refuse as a whole', () => {
  const refused = viewOf('ban', {
    settings: { name: 'bonk', description: LONG },
    effectiveName: 'ban',
    ignored: REFUSED,
    refused: true,
  });

  test('opens with its saved name, so fixing what was refused keeps the name', () => {
    expect(baseDraft(refused).name).toBe('bonk');
    expect(baseDraft(refused).savedName).toBeNull();
    expect(draftIssues(refused, baseDraft(refused)).description).toBe(
      'Descriptions can be at most 100 characters (this one is 101).',
    );
    expect(submission(refused, withDescription(NO_EDITS, 'Bonk a member')).name).toBe('bonk');
    expect(atDefaults(refused, NO_EDITS)).toBe(false);
  });

  test('typing Proton’s own name over the saved one drops it, as the server keeps a name in effect', () => {
    const fixed = withDescription(NO_EDITS, 'Bonk a member');

    expect(submission(refused, withName(fixed, 'ban')).name).toBeNull();
    expect(submission(refused, withName(fixed, ' /Ban ')).name).toBeNull();
    expect(submission(refused, withName(fixed, '')).name).toBeNull();
    expect(submission(refused, withName(fixed, 'thump')).name).toBe('thump');
    expect(changedFields(refused, withName(fixed, 'ban'))).toEqual(['name', 'description']);
  });

  test('does not hold its saved name against another command', () => {
    const warn = viewOf('warn', {
      settings: { name: 'caution', description: LONG },
      effectiveName: 'warn',
      ignored: REFUSED,
      refused: true,
    });
    const kick = viewOf('kick');

    expect(
      draftIssues(kick, draftOf(kick, withName(NO_EDITS, 'caution')), [kick, warn]).name,
    ).toBeUndefined();
  });

  test('its own saved name is no new claim, as the server sees it', () => {
    const taken = viewOf('ban', {
      settings: { name: 'kick', description: LONG },
      effectiveName: 'ban',
      ignored: REFUSED,
      refused: true,
    });
    const kick = viewOf('kick');

    expect(draftIssues(taken, baseDraft(taken), [taken, kick]).name).toBeUndefined();
    expect(draftIssues(BAN, draftOf(BAN, withName(NO_EDITS, 'kick')), [BAN, kick]).name).toBe(
      'Proton already has a /kick command. Pick another name.',
    );
  });
});

describe('a fresher copy of the command arriving while the dialog is open', () => {
  const opened = viewOf('ban', { settings: { updatedAt: '2026-09-22T10:00:00.000Z' } });
  const switched = viewOf('ban', {
    settings: { enabled: false, updatedAt: '2026-09-22T10:00:05.000Z' },
  });

  test('is taken while nothing is edited, so a switch flipped meanwhile is no conflict', () => {
    expect(adoptsFresher(opened, switched, NO_EDITS)).toBe(true);
    expect(adoptsFresher(opened, switched, withName(NO_EDITS, 'ban'))).toBe(true);
    expect(
      adoptsFresher(
        opened,
        viewOf('ban', { settings: opened.settings, definitionHash: 'hash-redeployed' }),
        NO_EDITS,
      ),
    ).toBe(true);
    expect(submission(switched, NO_EDITS).expectedUpdatedAt).toBe('2026-09-22T10:00:05.000Z');
  });

  test('is left alone once the draft has changes, or when nothing was saved', () => {
    expect(adoptsFresher(opened, switched, withDescription(NO_EDITS, 'Bonk'))).toBe(false);
    expect(
      adoptsFresher(
        opened,
        { ...opened, settings: { ...opened.settings, enabled: false } },
        NO_EDITS,
      ),
    ).toBe(false);
    expect(adoptsFresher(opened, viewOf('kick'), NO_EDITS)).toBe(false);
  });
});

describe('live checks', () => {
  test('a clean draft has no issues', () => {
    expect(hasIssues(draftIssues(BAN, baseDraft(BAN), [BAN]))).toBe(false);
  });

  test('names Discord would refuse, and names another command holds', () => {
    const kick = viewOf('kick');
    const catalogue = [BAN, kick];

    expect(draftIssues(BAN, draftOf(BAN, withName(NO_EDITS, 'two words'))).name).toContain(
      'no spaces',
    );
    expect(draftIssues(BAN, draftOf(BAN, withName(NO_EDITS, 'kick')), catalogue).name).toBe(
      'Proton already has a /kick command. Pick another name.',
    );
    expect(draftIssues(BAN, draftOf(BAN, withName(NO_EDITS, 'kick'))).name).toBeUndefined();
    expect(draftIssues(BAN, draftOf(BAN, withName(NO_EDITS, ''))).name).toBeUndefined();
  });

  test('a renamed command holding the name is named in the clash', () => {
    const kick = viewOf('kick', {
      settings: { name: 'boot', updatedAt: '2026-09-01T00:00:00.000Z' },
    });

    expect(draftIssues(BAN, draftOf(BAN, withName(NO_EDITS, 'boot')), [BAN, kick]).name).toBe(
      '/kick is already called “boot”. Rename /kick first.',
    );
  });

  test('descriptions past 100 characters are marked on their own field', () => {
    const issues = draftIssues(
      BAN,
      draftOf(BAN, withOption(withDescription(NO_EDITS, LONG), 'add.user', LONG)),
    );

    expect(issues.description).toBe(
      'Descriptions can be at most 100 characters (this one is 101).',
    );
    expect(Object.keys(issues.options)).toEqual(['add.user']);
    expect(issues.size).toBeUndefined();
  });

  test('blank descriptions inherit and are never an issue', () => {
    const issues = draftIssues(
      BAN,
      draftOf(BAN, withOption(withDescription(NO_EDITS, ''), 'add.user', '')),
    );

    expect(hasIssues(issues)).toBe(false);
  });

  test('the size budget counts the fixed part plus every effective text', () => {
    for (const entry of CATALOGUE) {
      if (entry.kind !== 'chat') continue;
      const view = viewOf(entry.key);

      expect(draftSize(view, baseDraft(view))).toBe(commandSize(entry.data));
    }
  });

  test('filling every giveaway field to the limit trips Discord’s 8000-character rule', () => {
    const giveaway = viewOf('giveaway');
    let edits = withDescription(NO_EDITS, 'y'.repeat(100));
    for (const field of flatFields(giveaway.fields)) {
      edits = withOption(edits, field.path, 'y'.repeat(100));
    }

    const issues = draftIssues(giveaway, draftOf(giveaway, edits));

    expect(draftSize(giveaway, draftOf(giveaway, edits))).toBeGreaterThan(8000);
    expect(issues.size).toContain('Discord allows 8000 characters per command');
    expect(Object.keys(issues.options)).toEqual([]);
  });
});

describe('server issues', () => {
  const issues = [
    { path: 'name', message: 'Name refused.' },
    { path: 'description', message: 'Description refused.' },
    { path: 'options.add.user', message: 'Option refused.' },
    { path: 'options.not.here', message: 'Stale option refused.' },
    { path: 'size', message: 'Too big.' },
    { path: 'privateReply', message: 'Cannot be private.' },
  ];

  test('land on the field they name, and anything else is shown for the dialog', () => {
    const mapped = mapServerIssues(BAN, issues);

    expect(mapped.name).toBe('Name refused.');
    expect(mapped.description).toBe('Description refused.');
    expect(mapped.options).toEqual({ 'add.user': 'Option refused.' });
    expect(mapped.size).toBe('Too big.');
    expect(mapped.other).toEqual(['Stale option refused.', 'Cannot be private.']);
  });

  test('clear from a field once it is edited again, taking the size issue with them', () => {
    const mapped = mapServerIssues(BAN, issues);
    const cleared = withoutServerIssue(mapped, { option: 'add.user' });

    expect(cleared.options).toEqual({});
    expect(cleared.name).toBe('Name refused.');
    expect(cleared.size).toBeUndefined();
    expect(withoutServerIssue(mapped, 'name').name).toBeUndefined();
    expect(withoutServerIssue(mapped, 'description').description).toBeUndefined();
  });

  test('a live issue wins over the server’s for the same field', () => {
    const live = draftIssues(BAN, draftOf(BAN, withName(NO_EDITS, 'Two Words')));
    const server = mapServerIssues(BAN, issues);

    expect(issueFor(live, server, 'name')).toBe(live.name);
    expect(issueFor(live, server, 'description')).toBe('Description refused.');
    expect(issueFor(live, NO_SERVER_ISSUES, { option: 'add.user' })).toBeUndefined();
  });
});

describe('after someone else saved', () => {
  test('edits survive for fields that still exist; edits back to the start are dropped', () => {
    const before = viewOf('ban', { settings: { description: 'Old' } });
    const after = viewOf('ban', {
      settings: { description: 'Theirs', updatedAt: '2026-09-22T10:00:00.000Z' },
    });
    const edits = withOption(
      withOption(withDescription(withName(NO_EDITS, 'bonk'), 'Old'), 'add.user', 'Mine'),
      'vanished.option',
      'Gone',
    );

    const rebased = rebaseEdits(before, after, edits);

    expect(rebased.name).toBe('bonk');
    expect(rebased.description).toBeUndefined();
    expect(rebased.options).toEqual({ 'add.user': 'Mine' });
    expect(draftOf(after, rebased).description).toBe('Theirs');
  });

  test('a preference edit is dropped once the command no longer offers the control', () => {
    const before = viewOf('ban', { reply: MODERATION_REPLY });
    const after = viewOf('ban');

    expect(rebaseEdits(before, after, withPrivateReply(NO_EDITS, true))).not.toHaveProperty(
      'privateReply',
    );
    expect(rebaseEdits(before, before, withPrivateReply(NO_EDITS, true)).privateReply).toBe(true);
  });

  test('a Reset keeps clearing the preference after the control is gone', () => {
    const before = viewOf('ban', { settings: { privateReply: true }, reply: MODERATION_REPLY });
    const after = viewOf('ban', {
      settings: { privateReply: true, updatedAt: '2026-09-22T10:00:00.000Z' },
    });
    const rebased = rebaseEdits(before, after, defaultEdits(before));

    expect(rebased.privateReply).toBeNull();
    expect(submission(after, rebased).privateReply).toBeNull();
  });
});

describe('sections', () => {
  test('a command without subcommands is one list of options', () => {
    const kick = viewOf('kick');

    expect(rootOptions(kick.fields).map((field) => field.path)).toEqual(['user', 'reason']);
    expect(sectionGroups(kick.fields)).toEqual([]);
  });

  test('subcommands group under their own group, in code order', () => {
    const ticket = viewOf('ticket');
    const groups = sectionGroups(ticket.fields);
    const grouped = groups.filter((group) => group.group !== null);

    expect(rootOptions(ticket.fields)).toEqual([]);
    expect(grouped.map((group) => group.group?.path)).toEqual(['blacklist']);
    expect(grouped[0]?.sections.map((section) => section.path)).toContain('blacklist.add');
    expect(groups.flatMap((group) => group.sections).length).toBe(subcommandCount(ticket.fields));
  });

  test('identically named options under different subcommands keep separate paths', () => {
    const paths = flatFields(viewOf('ticket').fields).map((field) => field.path);

    expect(paths).toContain('add.user');
    expect(paths).toContain('blacklist.add.user');
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('commands with more than three subcommands collapse', () => {
    expect(collapsesSections(viewOf('ban').fields)).toBe(false);
    expect(collapsesSections(viewOf('giveaway').fields)).toBe(true);
    expect(subcommandCount(viewOf('giveaway').fields)).toBe(28);
  });

  test('a section knows whether it holds an override or an issue', () => {
    const ban = viewOf('ban');
    const add = ban.fields.find((field) => field.path === 'add');
    if (!add) throw new Error('ban has no add');

    expect(sectionHasOverride(add, baseDraft(ban))).toBe(false);
    expect(sectionHasOverride(add, draftOf(ban, withOption(NO_EDITS, 'add.reason', 'Why')))).toBe(
      true,
    );
    expect(sectionHasOverride(add, draftOf(ban, withOption(NO_EDITS, 'add', 'Ban someone')))).toBe(
      true,
    );

    const live = draftIssues(ban, draftOf(ban, withOption(NO_EDITS, 'add.user', LONG)));
    expect(sectionHasIssue(add, live, NO_SERVER_ISSUES)).toBe(true);
    expect(sectionHasIssue(add, draftIssues(ban, baseDraft(ban)), NO_SERVER_ISSUES)).toBe(false);
  });

  test('paths read as the member types them', () => {
    expect(spokenPath('ticket', 'blacklist.add')).toBe('/ticket blacklist add');
    expect(spokenPath('tag', '')).toBe('/tag');
  });
});

describe('the Respond privately control', () => {
  test('summarises the default and the subcommands it cannot change', () => {
    const summary = replySummary({
      supported: true,
      paths: [
        { path: 'give', default: 'public', toggleable: true },
        { path: 'take', default: 'public', toggleable: true },
        { path: 'event.start', default: 'private', toggleable: false },
      ],
    });

    expect(summary).toEqual({
      defaultPrivate: false,
      alwaysPrivate: ['event.start'],
      alwaysPublic: [],
    });
    expect(replySummary(MODERATION_REPLY).defaultPrivate).toBe(true);
    expect(
      replySummary({
        supported: true,
        paths: [
          { path: 'a', default: 'public', toggleable: true },
          { path: 'b', default: 'private', toggleable: true },
        ],
      }).defaultPrivate,
    ).toBe('mixed');
  });

  test('shows the preference, or the default while none is set', () => {
    const summary = replySummary(MODERATION_REPLY);
    const draft = baseDraft(BAN);

    expect(replyShown(draft, summary)).toBe(true);
    expect(replyShown({ ...draft, privateReply: false }, summary)).toBe(false);
  });
});

describe('counters', () => {
  test('appear while typing or once a description passes 80 characters', () => {
    expect(showCounter(false, 'short')).toBe(false);
    expect(showCounter(true, '')).toBe(true);
    expect(showCounter(false, 'x'.repeat(81))).toBe(true);
    expect(showCounter(false, 'x'.repeat(80))).toBe(false);
  });
});

test('the fixtures are the shipped definitions', () => {
  expect((shippedData('ban') as ChatCommandData).name).toBe('ban');
});
