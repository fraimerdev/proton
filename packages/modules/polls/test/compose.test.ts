import { describe, expect, test } from 'bun:test';
import {
  POLL_MAX_ANSWER_LENGTH,
  POLL_MAX_ANSWERS,
  POLL_MAX_DURATION_HOURS,
  POLL_MAX_QUESTION_LENGTH,
} from '@proton/core';
import { renderAnnouncement } from '../src/announce.ts';
import { POLL_LIST_MAX, renderRunning } from '../src/commands.ts';
import {
  ANSWER_SEPARATOR,
  closesAt,
  composePoll,
  POLL_MIN_ANSWERS,
  splitAnswers,
} from '../src/compose.ts';
import {
  POLL_DEFAULT_DURATION_HOURS,
  POLL_MIN_DURATION_HOURS,
  pollLink,
  pollsConfigSchema,
  pollsDefaultConfig,
  unixSeconds,
} from '../src/config.ts';
import type { PollRecord } from '../src/store.ts';

function ok(
  question = 'Best topping?',
  answers = `Pineapple ${ANSWER_SEPARATOR} Anchovy`,
  durationHours = POLL_DEFAULT_DURATION_HOURS,
  multiselect = false,
) {
  return composePoll({ question, answers, durationHours, multiselect });
}

function reasonOf(result: ReturnType<typeof composePoll>): string {
  return result.ok ? '' : result.humanReason;
}

describe('splitAnswers', () => {
  test(`splits on ${ANSWER_SEPARATOR} and trims each answer`, () => {
    expect(splitAnswers(' Yes | No |  Ask me later ')).toEqual(['Yes', 'No', 'Ask me later']);
  });

  test('drops the empty runs a trailing or doubled separator leaves behind', () => {
    expect(splitAnswers('Yes ||No |')).toEqual(['Yes', 'No']);
  });

  test('a string with no separator is one answer, not zero', () => {
    expect(splitAnswers('Yes')).toEqual(['Yes']);
  });

  test('whitespace alone splits to nothing', () => {
    expect(splitAnswers('   |  |  ')).toEqual([]);
  });
});

describe('composePoll', () => {
  test('builds the poll object Discord documents', () => {
    const result = composePoll({
      question: '  Best topping?  ',
      answers: 'Pineapple | Anchovy | Neither',
      durationHours: 6,
      multiselect: true,
    });

    expect(result).toEqual({
      ok: true,
      poll: {
        question: { text: 'Best topping?' },
        answers: [
          { poll_media: { text: 'Pineapple' } },
          { poll_media: { text: 'Anchovy' } },
          { poll_media: { text: 'Neither' } },
        ],
        duration: 6,
        allow_multiselect: true,
      },
    });
  });

  test('accepts the maximum answer count, question length and duration', () => {
    const answers = Array.from({ length: POLL_MAX_ANSWERS }, (_, i) => `answer ${i}`);

    const result = composePoll({
      question: 'q'.repeat(POLL_MAX_QUESTION_LENGTH),
      answers: answers.join(ANSWER_SEPARATOR),
      durationHours: POLL_MAX_DURATION_HOURS,
      multiselect: false,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.poll.answers).toHaveLength(POLL_MAX_ANSWERS);
  });

  test('refuses an empty question', () => {
    expect(reasonOf(ok('   '))).toContain('needs a question');
  });

  test('refuses a question over the cap, naming the cap and the actual length', () => {
    const question = 'q'.repeat(POLL_MAX_QUESTION_LENGTH + 12);
    const reason = reasonOf(ok(question));

    expect(reason).toContain(String(POLL_MAX_QUESTION_LENGTH));
    expect(reason).toContain(String(POLL_MAX_QUESTION_LENGTH + 12));
    expect(reason).toContain('12');
  });

  test('refuses too many answers, naming the cap and how many to remove', () => {
    const answers = Array.from({ length: POLL_MAX_ANSWERS + 3 }, (_, i) => `a${i}`);
    const reason = reasonOf(ok('q', answers.join(ANSWER_SEPARATOR)));

    expect(reason).toContain(String(POLL_MAX_ANSWERS));
    expect(reason).toContain(String(POLL_MAX_ANSWERS + 3));
    expect(reason).toContain('Remove 3');
  });

  test('refuses an answer over the cap, naming which one it is', () => {
    const answers = ['fine', 'also fine', 'x'.repeat(POLL_MAX_ANSWER_LENGTH + 7)];
    const reason = reasonOf(ok('q', answers.join(ANSWER_SEPARATOR)));

    expect(reason).toContain('Answer 3');
    expect(reason).toContain(String(POLL_MAX_ANSWER_LENGTH));
    expect(reason).toContain(String(POLL_MAX_ANSWER_LENGTH + 7));
  });

  test('accepts an answer exactly at the cap', () => {
    const answers = ['ok', 'x'.repeat(POLL_MAX_ANSWER_LENGTH)];
    expect(ok('q', answers.join(ANSWER_SEPARATOR)).ok).toBe(true);
  });

  test('refuses a single answer and shows the separator', () => {
    const reason = reasonOf(ok('q', 'Only this one'));

    expect(reason).toContain(String(POLL_MIN_ANSWERS));
    expect(reason).toContain(ANSWER_SEPARATOR);
  });

  test('refuses answers that split to nothing', () => {
    const reason = reasonOf(ok('q', ' | | '));

    expect(reason).toContain('I found 0');
    expect(reason).toContain(ANSWER_SEPARATOR);
  });

  test('refuses a duration over the cap, naming the cap and what was asked for', () => {
    const reason = reasonOf(ok('q', 'a|b', POLL_MAX_DURATION_HOURS + 1));

    expect(reason).toContain(String(POLL_MAX_DURATION_HOURS));
    expect(reason).toContain(String(POLL_MAX_DURATION_HOURS + 1));
    expect(reason).toContain('32 days');
  });

  test('refuses a duration under an hour and a fractional one', () => {
    expect(reasonOf(ok('q', 'a|b', 0))).toContain(String(POLL_MIN_DURATION_HOURS));
    expect(reasonOf(ok('q', 'a|b', -4))).toContain('-4');
    expect(reasonOf(ok('q', 'a|b', 1.5))).toContain('1.5');
  });

  test('checks the question before the answers, so the first fault named is the first one', () => {
    const reason = reasonOf(ok('q'.repeat(POLL_MAX_QUESTION_LENGTH + 1), 'only-one'));

    expect(reason).toContain('question');
  });
});

describe('closesAt', () => {
  test('adds whole hours to the start', () => {
    const started = new Date('2026-08-17T10:00:00.000Z');

    expect(closesAt(started, 24).toISOString()).toBe('2026-08-18T10:00:00.000Z');
  });
});

describe('pollLink', () => {
  test('is the message link Discord clients understand', () => {
    expect(pollLink('1', '2', '3')).toBe('https://discord.com/channels/1/2/3');
  });
});

function record(overrides: Partial<PollRecord> = {}): PollRecord {
  return {
    guildId: '900000000000000001',
    channelId: '500000000000000001',
    messageId: '700000000000000001',
    createdBy: '100000000000000001',
    question: 'Best topping?',
    endsAt: new Date('2026-08-18T10:00:00.000Z'),
    endedAt: null,
    announceChannelId: null,
    createdAt: new Date('2026-08-17T10:00:00.000Z'),
    ...overrides,
  };
}

describe('renderAnnouncement', () => {
  test('links the poll and says plainly that Proton cannot read the counts', () => {
    const text = renderAnnouncement(record());

    expect(text).toContain('Best topping?');
    expect(text).toContain(
      pollLink('900000000000000001', '500000000000000001', '700000000000000001'),
    );
    expect(text).toContain('cannot read it back');
  });

  test('stays inside a Discord message even with the longest possible question', () => {
    expect(
      renderAnnouncement(record({ question: 'q'.repeat(POLL_MAX_QUESTION_LENGTH) })).length,
    ).toBeLessThan(2000);
  });
});

describe('renderRunning', () => {
  test('says the server has none rather than showing an empty list', () => {
    expect(renderRunning([], '900000000000000001')).toContain('No polls are running');
  });

  test('shows the id members need for /poll end', () => {
    const text = renderRunning([record()], '900000000000000001');

    expect(text).toContain('700000000000000001');
    expect(text).toContain(`<t:${unixSeconds(new Date('2026-08-18T10:00:00.000Z'))}:R>`);
  });

  test('caps the list and says how many were left out', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      record({
        messageId: `70000000000000${String(i).padStart(4, '0')}`,
        question: 'q'.repeat(POLL_MAX_QUESTION_LENGTH),
      }),
    );

    const text = renderRunning(many, '900000000000000001');

    expect(text).toContain(`…and ${20 - POLL_LIST_MAX} more.`);
    expect(text.length).toBeLessThan(2000);
  });
});

describe('the config schema', () => {
  test('the shipped default satisfies it', () => {
    expect(pollsConfigSchema.safeParse(pollsDefaultConfig).success).toBe(true);
  });

  test('is off until a server turns it on', () => {
    expect(pollsDefaultConfig.enabled).toBe(false);
  });

  test('refuses a default duration outside what Discord allows', () => {
    expect(
      pollsConfigSchema.safeParse({ defaultDurationHours: POLL_MAX_DURATION_HOURS + 1 }).success,
    ).toBe(false);
    expect(
      pollsConfigSchema.safeParse({ defaultDurationHours: POLL_MIN_DURATION_HOURS - 1 }).success,
    ).toBe(false);
  });

  test('refuses an announce channel that is not a snowflake', () => {
    expect(pollsConfigSchema.safeParse({ announceChannelId: 'general' }).success).toBe(false);
  });
});
