import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import { type FormConfig, formSchema } from '../src/config.ts';
import {
  formSnapshotSchema,
  publishIssues,
  sameSnapshot,
  snapshotDiff,
  snapshotOf,
  stableStringify,
} from '../src/version.ts';

const ROLE = '200000000000000001';
const CHANNEL = '300000000000000001';

function form(overrides: Partial<z.input<typeof formSchema>> = {}): FormConfig {
  return formSchema.parse({
    id: 'mods',
    name: 'Moderator Application',
    description: 'Help keep the server safe.',
    intro: 'Thanks for applying.',
    sections: [
      {
        id: 'about',
        title: 'About you',
        questions: [
          { id: 'name', type: 'short', label: 'Your name' },
          {
            id: 'experienced',
            type: 'single',
            label: 'Moderated before?',
            options: [
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ],
          },
          {
            id: 'details',
            type: 'paragraph',
            label: 'Tell us more',
            showIf: { questionId: 'experienced', values: ['yes'] },
          },
        ],
      },
    ],
    ...overrides,
  });
}

describe('snapshotOf', () => {
  test('it keeps exactly the versioned parts of a form', () => {
    const snapshot = snapshotOf(form({ emoji: { name: '🛡️' } }));

    expect(Object.keys(snapshot).sort()).toEqual([
      'confirmation',
      'description',
      'emoji',
      'formId',
      'intro',
      'name',
      'requirements',
      'sections',
    ]);
    expect(snapshot.formId).toBe('mods');
    expect(Object.keys(snapshotOf(form()))).not.toContain('emoji');
  });

  test('live settings never change the snapshot, so saving them needs no publish', () => {
    const base = snapshotOf(form());
    const live = snapshotOf(
      form({
        intake: { open: true, cap: 10, cooldownDays: 3 },
        review: { channelId: CHANNEL, cardAnswers: 'full', requireTwoReviewers: true },
        messages: { closed: 'Back soon.' },
        notify: { dm: false },
        actions: { onAccept: { addRoleIds: [ROLE], xp: 50 } },
        interview: { ticketTypeId: 'interview' },
        archived: true,
      }),
    );

    expect(sameSnapshot(base, live)).toBe(true);
  });

  test('versioned changes do change it', () => {
    const base = snapshotOf(form());

    expect(sameSnapshot(base, snapshotOf(form({ name: 'Mod Application' })))).toBe(false);
    expect(sameSnapshot(base, snapshotOf(form({ requirements: { minLevel: 5 } })))).toBe(false);
    expect(sameSnapshot(base, snapshotOf(form({ confirmation: 'Thanks!' })))).toBe(false);
  });

  test('it is a deep copy that survives a round trip through the database', () => {
    const source = form();
    const snapshot = snapshotOf(source);
    const stored = formSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));

    expect(stored).toEqual(snapshot);
    expect(sameSnapshot(stored, snapshot)).toBe(true);

    source.sections[0]?.questions.pop();
    expect(snapshot.sections[0]?.questions).toHaveLength(3);
  });
});

describe('stableStringify', () => {
  test('key order and undefined keys make no difference; array order does', () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(
      stableStringify({ a: { d: [1, 2] }, b: 1 }),
    );
    expect(stableStringify({ a: [1, 2] })).not.toBe(stableStringify({ a: [2, 1] }));
    expect(stableStringify([undefined])).toBe('[null]');
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify('text')).toBe('"text"');
  });
});

describe('snapshotDiff', () => {
  test('a first publish adds every question', () => {
    expect(snapshotDiff(null, snapshotOf(form()))).toEqual({
      added: ['name', 'experienced', 'details'],
      removed: [],
      changed: [],
      requirementsChanged: true,
      textChanged: true,
    });
  });

  test('it names the questions added, removed and changed', () => {
    const before = snapshotOf(form());
    const after = snapshotOf(
      form({
        sections: [
          {
            id: 'about',
            title: 'About you',
            questions: [
              { id: 'name', type: 'short', label: 'Your full name' },
              {
                id: 'experienced',
                type: 'single',
                label: 'Moderated before?',
                options: [
                  { value: 'yes', label: 'Yes' },
                  { value: 'no', label: 'No' },
                ],
              },
              { id: 'age', type: 'number', label: 'Age', integer: true },
            ],
          },
        ],
      }),
    );

    expect(snapshotDiff(before, after)).toEqual({
      added: ['age'],
      removed: ['details'],
      changed: ['name'],
      requirementsChanged: false,
      textChanged: false,
    });
  });

  test('form text and requirements are reported apart from questions', () => {
    const before = snapshotOf(form());

    expect(snapshotDiff(before, snapshotOf(form({ intro: 'New intro.' })))).toEqual({
      added: [],
      removed: [],
      changed: [],
      requirementsChanged: false,
      textChanged: true,
    });
    expect(snapshotDiff(before, snapshotOf(form({ requirements: { accountAgeDays: 7 } })))).toEqual(
      {
        added: [],
        removed: [],
        changed: [],
        requirementsChanged: true,
        textChanged: false,
      },
    );
  });

  test('an identical snapshot reports nothing', () => {
    const snapshot = snapshotOf(form());
    expect(snapshotDiff(snapshot, structuredClone(snapshot))).toEqual({
      added: [],
      removed: [],
      changed: [],
      requirementsChanged: false,
      textChanged: false,
    });
  });
});

describe('publishIssues', () => {
  test('a valid form with questions can be published', () => {
    expect(publishIssues(form())).toEqual([]);
  });

  test('a form with no questions cannot', () => {
    expect(publishIssues(form({ sections: [] }))).toEqual([
      'Add at least one question before publishing.',
    ]);
    expect(publishIssues(form({ sections: [{ id: 'empty' }] }))).toEqual([
      'Add at least one question before publishing.',
    ]);
  });

  test('a form that no longer validates lists why, once per message', () => {
    const broken = form();
    const [section] = broken.sections;
    const first = section?.questions[0];
    if (section === undefined || first === undefined) throw new Error('no question');
    section.questions.push({ ...first, label: 'Again' }, { ...first, label: 'And again' });

    expect(publishIssues(broken)).toEqual(["Another question already uses the ID 'name'."]);
  });
});
