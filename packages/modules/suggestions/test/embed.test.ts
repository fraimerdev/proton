import { describe, expect, test } from 'bun:test';
import { parseCustomId } from '@proton/core';
import { SUGGESTION_STATUSES } from '../src/decide.ts';
import {
  buildSuggestionEmbed,
  buildVoteRow,
  DESCRIPTION_MAX,
  DOWN_EMOJI,
  NO_VOTES,
  net,
  STATUS_COLOURS,
  STATUS_LABELS,
  type SuggestionView,
  signed,
  threadName,
  UP_EMOJI,
} from '../src/embed.ts';
import { readVotePress } from '../src/interactions.ts';

const AUTHOR = '100000000000000001';
const STAFF = '100000000000000003';
const OTHER_STAFF = '100000000000000004';

function view(overrides: Partial<SuggestionView> = {}): SuggestionView {
  return {
    id: 'sug-1',
    number: 12,
    authorId: AUTHOR,
    content: 'Add a bot-commands channel.',
    status: 'open',
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    ...overrides,
  };
}

interface Field {
  name: string;
  value: string;
}

function fields(embed: Record<string, unknown>): Field[] {
  return (embed.fields ?? []) as Field[];
}

function field(embed: Record<string, unknown>, name: string): Field | undefined {
  return fields(embed).find((entry) => entry.name === name);
}

describe('net and signed', () => {
  test('net is upvotes minus downvotes', () => {
    expect(net({ up: 5, down: 2 })).toBe(3);
    expect(net({ up: 0, down: 4 })).toBe(-4);
    expect(net(NO_VOTES)).toBe(0);
  });

  test('a positive score carries its plus so nobody has to guess the direction', () => {
    expect(signed(3)).toBe('+3');
    expect(signed(0)).toBe('0');
    expect(signed(-4)).toBe('-4');
  });
});

describe('buildSuggestionEmbed', () => {
  test('titles the post with the number staff will type into /suggestion', () => {
    expect(buildSuggestionEmbed(view(), NO_VOTES, { anonymous: false }).title).toBe(
      'Suggestion #12',
    );
  });

  test('every status has its own colour, and no two share one', () => {
    const colours = SUGGESTION_STATUSES.map(
      (status) => buildSuggestionEmbed(view({ status }), NO_VOTES, { anonymous: false }).color,
    );

    expect(colours).toEqual(SUGGESTION_STATUSES.map((status) => STATUS_COLOURS[status]));
    expect(new Set(colours).size).toBe(SUGGESTION_STATUSES.length);
  });

  test('carries the text and credits the author', () => {
    const embed = buildSuggestionEmbed(view(), NO_VOTES, { anonymous: false });

    expect(embed.description).toContain('Add a bot-commands channel.');
    expect(embed.description).toContain(`<@${AUTHOR}>`);
  });

  test('anonymous hides the author entirely rather than naming them faintly', () => {
    const embed = buildSuggestionEmbed(view(), NO_VOTES, { anonymous: true });

    expect(embed.description).not.toContain(AUTHOR);
    expect(embed.description).toContain('anonymously');
  });

  test('shows both tallies and the net score', () => {
    const embed = buildSuggestionEmbed(view(), { up: 5, down: 2 }, { anonymous: false });
    const votes = field(embed, 'Votes');

    expect(votes?.value).toContain(`${UP_EMOJI} **5**`);
    expect(votes?.value).toContain(`${DOWN_EMOJI} **2**`);
    expect(votes?.value).toContain('**+3**');
  });

  test('an open suggestion has no decision field at all', () => {
    const embed = buildSuggestionEmbed(view(), NO_VOTES, { anonymous: false });

    expect(field(embed, 'Status')?.value).toBe(STATUS_LABELS.open);
    expect(fields(embed).map((entry) => entry.name)).toEqual(['Votes', 'Status']);
    expect(embed.timestamp).toBeUndefined();
  });

  test('a decision names who made it, quotes the reason and stamps the time', () => {
    const decidedAt = new Date('2026-05-01T10:00:00.000Z');
    const embed = buildSuggestionEmbed(
      view({
        status: 'accepted',
        decidedBy: STAFF,
        decidedAt,
        decisionReason: 'Good idea, doing it this week.',
      }),
      NO_VOTES,
      { anonymous: false },
    );

    const decision = field(embed, 'Accepted by');
    expect(decision?.value).toContain(`<@${STAFF}>`);
    expect(decision?.value).toContain('> Good idea, doing it this week.');
    expect(embed.timestamp).toBe(decidedAt.toISOString());
  });

  test('each decided status heads its field with its own verb', () => {
    for (const [status, heading] of [
      ['accepted', 'Accepted by'],
      ['denied', 'Denied by'],
      ['implemented', 'Implemented by'],
    ] as const) {
      const embed = buildSuggestionEmbed(
        view({ status, decidedBy: STAFF, decidedAt: new Date() }),
        NO_VOTES,
        { anonymous: false },
      );

      expect(field(embed, heading)).toBeDefined();
    }
  });

  test('a re-decided suggestion shows the latest verdict and only the latest', () => {
    const first = view({
      status: 'accepted',
      decidedBy: STAFF,
      decidedAt: new Date('2026-05-01T10:00:00.000Z'),
      decisionReason: 'Sounds good.',
    });

    const second = view({
      status: 'denied',
      decidedBy: OTHER_STAFF,
      decidedAt: new Date('2026-05-08T10:00:00.000Z'),
      decisionReason: 'On reflection, no.',
    });

    buildSuggestionEmbed(first, NO_VOTES, { anonymous: false });
    const embed = buildSuggestionEmbed(second, NO_VOTES, { anonymous: false });

    const decisions = fields(embed).filter((entry) => entry.name.endsWith(' by'));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.name).toBe('Denied by');

    const rendered = JSON.stringify(embed);
    expect(rendered).toContain(OTHER_STAFF);
    expect(rendered).toContain('On reflection, no.');
    expect(rendered).not.toContain(STAFF);
    expect(rendered).not.toContain('Sounds good.');
  });

  test('a decided row with no decider on it still renders rather than showing a dangling field', () => {
    const embed = buildSuggestionEmbed(view({ status: 'accepted', decidedBy: null }), NO_VOTES, {
      anonymous: false,
    });

    expect(fields(embed).map((entry) => entry.name)).toEqual(['Votes', 'Status']);
    expect(field(embed, 'Status')?.value).toBe('Accepted');
  });

  test('a very long suggestion is trimmed to what Discord accepts instead of being refused', () => {
    const embed = buildSuggestionEmbed(
      view({ content: 'x'.repeat(DESCRIPTION_MAX + 500) }),
      NO_VOTES,
      { anonymous: false },
    );

    expect(String(embed.description)).toHaveLength(DESCRIPTION_MAX);
  });
});

describe('buildVoteRow', () => {
  test('gives one row of two buttons whose ids decode back to this suggestion', () => {
    const row = buildVoteRow('sug-1', 'open');
    expect(row.ok).toBe(true);
    if (!row.ok) return;

    const buttons = (row.components[0]?.components ?? []) as Array<Record<string, unknown>>;
    expect(buttons).toHaveLength(2);

    expect(readVotePress(buttons[0]?.custom_id)).toEqual({
      suggestionId: 'sug-1',
      direction: 'up',
    });
    expect(readVotePress(buttons[1]?.custom_id)).toEqual({
      suggestionId: 'sug-1',
      direction: 'down',
    });
  });

  test('the ids are ours, so another module can tell them apart from its own', () => {
    const row = buildVoteRow('sug-1', 'open');
    if (!row.ok) throw new Error(row.humanReason);

    const buttons = (row.components[0]?.components ?? []) as Array<Record<string, unknown>>;
    expect(parseCustomId(buttons[0]?.custom_id)?.moduleId).toBe('suggestions');
  });

  test('an open suggestion has both buttons live', () => {
    const row = buildVoteRow('sug-1', 'open');
    if (!row.ok) throw new Error(row.humanReason);

    const buttons = (row.components[0]?.components ?? []) as Array<Record<string, unknown>>;
    expect(buttons.every((button) => button.disabled === undefined)).toBe(true);
  });

  test('a decided suggestion greys both buttons out rather than leaving a dead button live', () => {
    for (const status of ['accepted', 'denied', 'implemented'] as const) {
      const row = buildVoteRow('sug-1', status);
      if (!row.ok) throw new Error(row.humanReason);

      const buttons = (row.components[0]?.components ?? []) as Array<Record<string, unknown>>;
      expect(buttons.every((button) => button.disabled === true)).toBe(true);
    }
  });

  test('refuses an id too long for a custom_id, and says why, instead of posting a dead button', () => {
    const row = buildVoteRow('s'.repeat(120), 'open');

    expect(row.ok).toBe(false);
    expect(row.ok === false && row.humanReason).toContain('100');
  });
});

describe('threadName', () => {
  test('leads with the number so the thread list reads like the channel', () => {
    expect(threadName(view())).toBe('Suggestion #12 — Add a bot-commands channel.');
  });

  test('never exceeds the hundred characters Discord allows a channel name', () => {
    expect(threadName(view({ content: 'y'.repeat(400) }))).toHaveLength(100);
  });

  test('flattens newlines, which a channel name cannot carry', () => {
    expect(threadName(view({ content: 'one\n\ntwo' }))).toBe('Suggestion #12 — one two');
  });
});
