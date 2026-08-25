import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '@proton/core';
import { findConflicts } from '../src/builder/conflicts.ts';
import { formatColour, parseColour, readDescriptorValues } from '../src/builder/modal.ts';
import {
  BUILDER_STEPS,
  type BuilderStep,
  emptyDraft,
  type GiveawayDraft,
} from '../src/builder/state.ts';
import { applyStepModal, stepModal } from '../src/builder/step-modals.ts';
import { categoriesOf, categoryLabel, readyToPublish, stepScreen } from '../src/builder/steps.ts';

const GUILD = '100000000000000000';
const CHANNEL = '500000000000000000';
const HOST = '400000000000000001';
const ROLE_A = '600000000000000001';
const ROLE_B = '600000000000000002';
const NOW = Date.UTC(2026, 7, 25);

function draftOf(over: Partial<GiveawayDraft> = {}): GiveawayDraft {
  return { ...emptyDraft(GUILD, CHANNEL, HOST, { winnerCount: 1 }, NOW), ...over };
}

function registry(): ProviderRegistry {
  return new ProviderRegistry();
}

function screen(draft: GiveawayDraft, category: string | null = null) {
  const result = stepScreen(draft, registry(), [], category);
  if (!result.ok) throw new Error(result.humanReason);

  return result;
}

describe('the step router', () => {
  test.each([...BUILDER_STEPS])('the %s step renders', (step) => {
    const rendered = screen(draftOf({ step, title: 'A prize' }));

    expect(rendered.content.length).toBeGreaterThan(0);
    expect(rendered.components.length).toBeGreaterThan(0);
  });

  // Five action rows is Discord's ceiling for a message, and nav plus actions already take two.
  test.each([...BUILDER_STEPS])('the %s step stays inside five action rows', (step) => {
    expect(screen(draftOf({ step, title: 'A prize' })).components.length).toBeLessThanOrEqual(5);
  });

  // The action segment carries its own colon, which encodeCustomId escapes — so the id on the
  // wire reads `b\:nav`, and parseCustomId gives it back intact.
  test('every step carries the navigation select', () => {
    for (const step of BUILDER_STEPS) {
      const rendered = screen(draftOf({ step, title: 'A prize' }));
      expect(JSON.stringify(rendered.components)).toContain('b\\\\:nav');
    }
  });

  test('the current step is preselected in the navigation', () => {
    const rendered = screen(draftOf({ step: 'look', title: 'A prize' }));
    const nav = JSON.stringify(rendered.components[0]);

    expect(nav).toContain('"value":"look"');
    expect(nav).toContain('"default":true');
  });

  test('the step heading says where the host is', () => {
    expect(screen(draftOf({ step: 'winners', title: 'x' })).content).toContain('Step 5 of 6');
  });

  test('a giveaway with no prize cannot be published', () => {
    const rendered = screen(draftOf({ step: 'review' }));
    const buttons = JSON.stringify(rendered.components.at(-1));

    expect(buttons).toContain('"disabled":true');
  });

  test('a giveaway with a prize can be published', () => {
    expect(readyToPublish(draftOf({ title: 'A prize' }), registry())).toBe(true);
  });
});

describe('categorising the picker', () => {
  const providers = [
    { moduleId: 'core', id: 'core.a' },
    { moduleId: 'core', id: 'core.b' },
    { moduleId: 'leveling', id: 'leveling.a' },
  ] as never[];

  test('categories come from the owning module', () => {
    expect(categoriesOf(providers)).toEqual(['core', 'leveling']);
  });

  test('a known module gets a friendly name', () => {
    expect(categoryLabel('leveling')).toBe('Activity & levels');
  });

  // A pack added later must still appear, rather than vanishing from a hand-kept list.
  test('an unknown module falls back to its id rather than disappearing', () => {
    expect(categoryLabel('brand-new')).toBe('brand-new');
  });
});

describe('conflict detection', () => {
  const required = { providerId: 'core.has_role', config: { roleIds: [ROLE_A] } };
  const excluded = { providerId: 'core.lacks_role', config: { roleIds: [ROLE_A] } };

  test('requiring and excluding the same role under ALL is blocking', () => {
    const conflicts = findConflicts(registry(), [required, excluded], [], 'all');

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.blocking).toBe(true);
    expect(conflicts[0]?.humanReason).toContain(ROLE_A);
  });

  // Under ANY either branch can carry the entry on its own, so it is redundant rather than
  // impossible — and a builder that cries wolf gets clicked through.
  test('the same pair under ANY is not blocking', () => {
    const conflicts = findConflicts(registry(), [required, excluded], [], 'any');

    expect(conflicts.every((conflict) => !conflict.blocking)).toBe(true);
  });

  test('different roles do not conflict', () => {
    const other = { providerId: 'core.lacks_role', config: { roleIds: [ROLE_B] } };

    expect(findConflicts(registry(), [required, other], [], 'all')).toHaveLength(0);
  });

  test('a duplicated requirement is flagged but not blocking', () => {
    const conflicts = findConflicts(registry(), [required, required], [], 'all');

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.blocking).toBe(false);
  });

  test('a multiply by one is flagged as doing nothing', () => {
    const conflicts = findConflicts(
      registry(),
      [],
      [{ providerId: 'x', config: { amount: 1 }, mode: 'multiply' }],
      'all',
    );

    expect(conflicts[0]?.humanReason).toContain('changes nothing');
  });

  test('a blocking conflict stops publishing', () => {
    const draft = draftOf({ title: 'A prize', requirements: [required, excluded] });

    expect(readyToPublish(draft, registry())).toBe(false);
  });

  test('a non-blocking conflict does not stop publishing', () => {
    const draft = draftOf({ title: 'A prize', requirements: [required, required] });

    expect(readyToPublish(draft, registry())).toBe(true);
  });

  test('the review step shows the conflicts', () => {
    const draft = draftOf({ step: 'review', title: 'A prize', requirements: [required, excluded] });

    expect(screen(draft).content).toContain('Before you publish');
  });
});

describe('reading colours', () => {
  test.each([
    ['#5865F2', 0x5865f2],
    ['5865F2', 0x5865f2],
    ['5865f2', 0x5865f2],
    ['0', 0],
    ['16777215', 0xffffff],
  ] as const)('%s parses to %i', (raw, expected) => {
    expect(parseColour(raw)).toBe(expected);
  });

  test.each(['', 'blurple', '#12345', '16777216', '-1', '#GGGGGG'])('%s is refused', (raw) => {
    expect(parseColour(raw)).toBeNull();
  });

  test('a colour round-trips back to hex', () => {
    expect(formatColour(0x5865f2)).toBe('#5865F2');
    expect(formatColour(0)).toBe('#000000');
  });

  // The stored field is a z.number(); the previous version put the typed string straight in, which
  // sailed past the modal and failed at parseConfig with a message about the wrong type.
  test('a colour descriptor yields a number, not the typed string', () => {
    const read = readDescriptorValues(
      [{ kind: 'colour', path: 'color', label: 'Colour', optional: false }] as never,
      { color: '#5865F2' },
      {},
    );

    expect(read.ok).toBe(true);
    if (!read.ok) return;

    expect(read.config.color).toBe(0x5865f2);
    expect(typeof read.config.color).toBe('number');
  });

  test('an unreadable colour is refused with the value quoted back', () => {
    const read = readDescriptorValues(
      [{ kind: 'colour', path: 'color', label: 'Colour', optional: false }] as never,
      { color: 'blurple' },
      {},
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;

    expect(read.humanReason).toContain('blurple');
  });
});

describe('the step modals', () => {
  test.each(['basics', 'look', 'winners'] as BuilderStep[])('%s opens a modal', (step) => {
    const built = stepModal(step, draftOf());

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // A modal holds one to five top-level components.
    expect(built.modal.components.length).toBeGreaterThan(0);
    expect(built.modal.components.length).toBeLessThanOrEqual(5);
  });

  test.each(['rules', 'bonus', 'review'] as BuilderStep[])('%s has no modal of its own', (step) => {
    expect(stepModal(step, draftOf()).ok).toBe(false);
  });

  test('the basics modal is prefilled from the draft', () => {
    const built = stepModal('basics', draftOf({ title: 'Nitro' }));
    if (!built.ok) throw new Error(built.humanReason);

    expect(JSON.stringify(built.modal)).toContain('Nitro');
  });

  test('applying basics sets the prize and duration', () => {
    const draft = draftOf();
    const applied = applyStepModal('basics', draft, { title: 'Nitro', duration: '12h' });

    expect(applied.ok).toBe(true);
    expect(draft.title).toBe('Nitro');
    expect(draft.durationMs).toBe(12 * 60 * 60 * 1000);
    expect(draft.startsInMs).toBeNull();
  });

  test('a start delay is optional and parsed when given', () => {
    const draft = draftOf();
    applyStepModal('basics', draft, { title: 'Nitro', duration: '12h', startsIn: '2d' });

    expect(draft.startsInMs).toBe(2 * 24 * 60 * 60 * 1000);
  });

  test('an empty prize is refused', () => {
    const applied = applyStepModal('basics', draftOf(), { title: '  ', duration: '12h' });

    expect(applied.ok).toBe(false);
  });

  test('an unreadable start delay is refused rather than ignored', () => {
    const applied = applyStepModal('basics', draftOf(), {
      title: 'Nitro',
      duration: '12h',
      startsIn: 'tomorrow',
    });

    expect(applied.ok).toBe(false);
    if (applied.ok) return;

    expect(applied.humanReason).toContain('tomorrow');
  });

  test('applying appearance stores a parsed colour', () => {
    const draft = draftOf();
    applyStepModal('look', draft, { color: '#FF0000', emoji: '🍕', buttonStyle: '3' });

    expect(draft.color).toBe(0xff0000);
    expect(draft.emoji).toBe('🍕');
    expect(draft.buttonStyle).toBe(3);
  });

  test('an empty colour clears it back to the server default', () => {
    const draft = draftOf({ color: 0xff0000 });
    applyStepModal('look', draft, { color: '' });

    expect(draft.color).toBeNull();
  });

  test('an unsupported button style is ignored rather than sent to Discord', () => {
    const draft = draftOf({ buttonStyle: 1 });
    applyStepModal('look', draft, { buttonStyle: '9' });

    expect(draft.buttonStyle).toBe(1);
  });

  test('applying winner settings stores the cap and claim window', () => {
    const draft = draftOf();
    const applied = applyStepModal('winners', draft, {
      winnerCount: '3',
      maxEntriesPerUser: '50',
      claimWindow: '24h',
    });

    expect(applied.ok).toBe(true);
    expect(draft.winnerCount).toBe(3);
    expect(draft.maxEntriesPerUser).toBe(50);
    expect(draft.claimWindowSeconds).toBe(24 * 60 * 60);
  });

  test('an empty cap and claim window clear them', () => {
    const draft = draftOf({ maxEntriesPerUser: 5, claimWindowSeconds: 3600 });
    applyStepModal('winners', draft, { winnerCount: '1', maxEntriesPerUser: '', claimWindow: '' });

    expect(draft.maxEntriesPerUser).toBeNull();
    expect(draft.claimWindowSeconds).toBeNull();
  });

  test('a winner count outside the range is refused', () => {
    expect(applyStepModal('winners', draftOf(), { winnerCount: '0' }).ok).toBe(false);
    expect(applyStepModal('winners', draftOf(), { winnerCount: 'lots' }).ok).toBe(false);
  });

  test('a claim window under a minute is refused', () => {
    const applied = applyStepModal('winners', draftOf(), {
      winnerCount: '1',
      claimWindow: '10s',
    });

    expect(applied.ok).toBe(false);
  });
});
