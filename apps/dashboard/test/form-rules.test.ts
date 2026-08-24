import { describe, expect, test } from 'bun:test';
import type { FieldDescriptor } from '@proton/core';
import { zodToDescriptors } from '@proton/core';
import { antinukeConfigSchema } from '@proton/module-antinuke/config';
import { automodFormSchema } from '@proton/module-automod/config';
import { paramLabel, ruleIsOff, singular, toRows, words } from '../src/components/form/rules.ts';

function descriptorsOf(schema: Parameters<typeof zodToDescriptors>[0]): FieldDescriptor[] {
  return zodToDescriptors(schema);
}

function inSection(all: readonly FieldDescriptor[], paths: readonly string[]): FieldDescriptor[] {
  return paths.map((path) => {
    const found = all.find((descriptor) => descriptor.path === path);
    if (!found) throw new Error(`no '${path}' descriptor — the manifest section is out of date`);

    return found;
  });
}

function shape(rows: ReturnType<typeof toRows>): string[] {
  return rows.map((row) =>
    row.kind === 'field'
      ? `field ${row.descriptor.path}`
      : `rule ${row.label} [${row.head?.path ?? '-'}] (${row.params
          .map((param) => param.label ?? '=')
          .join(
            ', ',
          )})${row.stacked.length > 0 ? ` +${row.stacked.map((s) => s.path).join(',')}` : ''}`,
  );
}

describe('word splitting', () => {
  test('splits camelCase into lowercase words', () => {
    expect(words('linkBlockDomains')).toEqual(['link', 'block', 'domains']);
    expect(words('flood')).toEqual(['flood']);
    expect(words('Flood: window')).toEqual(['flood:', 'window']);
  });

  test('singular makes links and link the same subject', () => {
    expect(singular('links')).toBe('link');
    expect(singular('attachments')).toBe('attachment');
    expect(singular('caps')).toBe('cap');
    expect(singular('duplicate')).toBe('duplicate');
  });

  test('it never eats a word that is not a plural s', () => {
    expect(singular('ss')).toBe('ss');
    expect(singular('address')).toBe('address');
    expect(singular('emoji')).toBe('emoji');
  });
});

describe('param labels', () => {
  test('the module’s own colon convention names the part', () => {
    expect(paramLabel('Flood: window', 'Message flood')).toBe('Window');
    expect(paramLabel('Mentions: limit', 'Mass mentions')).toBe('Limit');
  });

  test('a shared leading run is dropped, and what is left is the part', () => {
    expect(paramLabel('Channel deletion window', 'Channel deletion')).toBe('Window');
    expect(paramLabel('Channel deletions per member', 'Channel deletion')).toBe('Per member');
  });

  test('a label that says nothing new is left unlabelled', () => {
    expect(paramLabel('Server', 'Server')).toBeUndefined();
  });

  test('an unrelated label is kept whole', () => {
    expect(paramLabel('Blocked domains', 'Blocked links')).toBe('Blocked domains');
  });
});

describe('automod folds its checks into rules', () => {
  const all = descriptorsOf(automodFormSchema);

  test('spam becomes three rules and no loose rows', () => {
    const rows = toRows(
      inSection(all, [
        'floodSeverity',
        'floodCount',
        'floodWindow',
        'duplicateSeverity',
        'duplicateCount',
        'duplicateWindow',
        'mentionsSeverity',
        'mentionsLimit',
      ]),
    );

    expect(shape(rows)).toEqual([
      'rule Message flood [floodSeverity] (Messages, Window)',
      'rule Duplicate messages [duplicateSeverity] (Repeats, Window)',
      'rule Mass mentions [mentionsSeverity] (Limit)',
    ]);
  });

  test('a plural head and a singular member are still one subject', () => {
    const rows = toRows(
      inSection(all, [
        'invitesSeverity',
        'linksSeverity',
        'linkBlockDomains',
        'linkAllowDomains',
        'attachmentsSeverity',
        'attachmentExtensions',
        'patternsSeverity',
      ]),
    );

    expect(shape(rows)).toEqual([
      'field invitesSeverity',
      'rule Blocked links [linksSeverity] () +linkBlockDomains,linkAllowDomains',
      'rule Attachments [attachmentsSeverity] () +attachmentExtensions',
      'field patternsSeverity',
    ]);
  });

  test('a growing control stays stacked instead of joining the inline line', () => {
    const rows = toRows(
      inSection(all, [
        'linksSeverity',
        'linkBlockDomains',
        'linkAllowDomains',
        'attachmentsSeverity',
        'attachmentExtensions',
      ]),
    );
    const rule = rows[0];

    expect(rule?.kind).toBe('rule');
    if (rule?.kind !== 'rule') return;

    expect(rule.params).toEqual([]);
    expect(rule.stacked.map((descriptor) => descriptor.path)).toEqual([
      'linkBlockDomains',
      'linkAllowDomains',
    ]);
  });
});

describe('antinuke folds its threshold pairs', () => {
  const all = descriptorsOf(antinukeConfigSchema);

  test('ten fields become five rules', () => {
    const rows = toRows(
      inSection(all, [
        'channelDeleteLimit',
        'channelDeleteWindow',
        'roleDeleteLimit',
        'roleDeleteWindow',
        'webhookDeleteLimit',
        'webhookDeleteWindow',
        'emojiDeleteLimit',
        'emojiDeleteWindow',
        'memberRemoveLimit',
        'memberRemoveWindow',
      ]),
    );

    expect(rows).toHaveLength(5);
    expect(shape(rows)[0]).toBe('rule Channel deletion [-] (Per member, Window)');
  });
});

describe('grouping declines where it would not earn itself', () => {
  const all = descriptorsOf(automodFormSchema);

  test('one family in a section is left as plain rows', () => {
    const rows = toRows(inSection(all, ['exemptRoleIds', 'exemptChannelIds', 'exemptBots']));

    expect(rows.every((row) => row.kind === 'field')).toBe(true);
  });

  test('a section whose fields share nothing is untouched', () => {
    const rows = toRows(
      inSection(all, ['blockedWords', 'allowedWords', 'presets', 'mentionLimit', 'nativeSpam']),
    );

    expect(rows.every((row) => row.kind === 'field')).toBe(true);
  });

  test('a section’s own switch never joins a row inside it', () => {
    const rows = toRows(
      inSection(all, [
        'floodSeverity',
        'floodCount',
        'floodWindow',
        'mentionsSeverity',
        'mentionsLimit',
      ]),
    );

    expect(
      rows.some((row) => row.kind === 'field' && row.descriptor.path === 'floodSeverity'),
    ).toBe(false);
  });

  test('nested paths are never paired across their parents', () => {
    const nested: FieldDescriptor[] = [
      { path: 'categories.server', label: 'Server', kind: 'boolean', optional: false },
      { path: 'categoryChannels.server', label: 'Server', kind: 'string', optional: false },
      { path: 'categories.roles', label: 'Roles', kind: 'boolean', optional: false },
      { path: 'categoryChannels.roles', label: 'Roles', kind: 'string', optional: false },
    ];

    expect(toRows(nested).every((row) => row.kind === 'field')).toBe(true);
  });
});

describe('a rule switched off hides the settings it is not reading', () => {
  const all = descriptorsOf(automodFormSchema);
  const rows = toRows(
    inSection(all, [
      'floodSeverity',
      'floodCount',
      'floodWindow',
      'mentionsSeverity',
      'mentionsLimit',
    ]),
  );

  const flood = rows.find((row) => row.kind === 'rule');

  test('off hides them', () => {
    expect(flood?.kind).toBe('rule');
    if (flood?.kind !== 'rule') return;

    expect(ruleIsOff(flood, { floodSeverity: 'off' })).toBe(true);
    expect(ruleIsOff(flood, { floodSeverity: 'medium' })).toBe(false);
  });

  test('a rule with no severity of its own never hides anything', () => {
    const antinuke = toRows(
      inSection(descriptorsOf(antinukeConfigSchema), [
        'channelDeleteLimit',
        'channelDeleteWindow',
        'roleDeleteLimit',
        'roleDeleteWindow',
      ]),
    ).find((row) => row.kind === 'rule');

    expect(antinuke?.kind).toBe('rule');
    if (antinuke?.kind !== 'rule') return;

    expect(ruleIsOff(antinuke, {})).toBe(false);
  });
});
