import { describe, expect, test } from 'bun:test';
import { type ApplicationStatus, MAX_CUSTOM_ID_LENGTH, toRestCall } from '@proton/core';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import {
  buildReviewCard,
  CARD_COMPONENTS_MAX,
  CARD_TEXT_MAX,
  cardComponentCount,
  cardMessage,
  cardTextLength,
  type ReviewCardInput,
  STATUS_ACCENTS,
} from '../src/card.ts';
import { customId, MORE_CHOICES, STAFF_ACTION } from '../src/interface.ts';
import type { CheckedAnswer } from '../src/questions.ts';
import type { ApplicationRecord } from '../src/store.ts';
import { applicationRecord } from './memory-store.ts';
import {
  APP_ID,
  APPLICANT,
  answers,
  buttonLabels,
  customIds,
  DASHBOARD,
  formConfig,
  GUILD,
  NOW,
  REVIEWER,
  SECOND,
  selectValues,
  textOf,
  walk,
} from './staff-harness.ts';

type Component = Record<string, unknown>;

function record(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return applicationRecord({
    id: APP_ID,
    guildId: GUILD,
    number: 12,
    applicantId: APPLICANT,
    applicantName: 'Applicant',
    answers: answers(),
    submittedAt: NOW - 3_600_000,
    ...overrides,
  });
}

function input(overrides: Partial<ReviewCardInput> = {}): ReviewCardInput {
  return {
    application: record(),
    form: formConfig(),
    formName: 'Moderator Application',
    votes: { accept: 0, reject: 0 },
    problems: [],
    dashboardUrl: DASHBOARD,
    mode: 'summary',
    now: NOW,
    ...overrides,
  };
}

function built(overrides: Partial<ReviewCardInput> = {}): Component[] {
  const card = buildReviewCard(input(overrides));
  if (!card.ok) throw new Error(card.humanReason);
  return card.components;
}

function many(count: number, length: number): CheckedAnswer[] {
  return Array.from({ length: count }, (_, index) => ({
    questionId: `q${index}`,
    sectionId: 'about',
    label: `Question ${index + 1}`,
    type: 'paragraph' as const,
    value: 'x'.repeat(length),
    display: `${index}`.padEnd(length, 'x'),
  }));
}

function links(components: readonly Component[]): string[] {
  const urls: string[] = [];
  walk(components, (component) => {
    if (component.style === ButtonStyle.Link && typeof component.url === 'string') {
      urls.push(component.url);
    }
  });
  return urls;
}

describe('buildReviewCard', () => {
  test('one container, accented by status, with the heading, applicant and timing', () => {
    const components = built();

    expect(components).toHaveLength(1);
    expect(components[0]?.type).toBe(ComponentType.Container);
    expect(components[0]?.accent_color).toBe(STATUS_ACCENTS.submitted);

    const text = textOf(components);
    expect(text).toStartWith('## Moderator Application #12');
    expect(text).toContain(`<@${APPLICANT}> · Applicant`);
    expect(text).toContain('**Submitted**');
    expect(text).toContain(`Submitted <t:${Math.floor((NOW - 3_600_000) / 1000)}:R>`);
  });

  test.each([
    'submitted',
    'in_review',
    'needs_info',
    'waitlisted',
    'accepted',
    'rejected',
    'withdrawn',
    'expired',
  ] satisfies ApplicationStatus[])('the %s accent comes from the status', (status) => {
    const components = built({ application: record({ status, decidedBy: REVIEWER }) });

    expect(components[0]?.accent_color).toBe(STATUS_ACCENTS[status]);
  });

  test('the status line names the claimant and the vote tally', () => {
    const text = textOf(
      built({
        application: record({ status: 'in_review', assigneeId: REVIEWER }),
        votes: { accept: 2, reject: 1 },
      }),
    );

    expect(text).toContain(
      `**In review** · claimed by <@${REVIEWER}> · Votes: 2 accept · 1 reject`,
    );
  });

  test('a decided card says who decided and when', () => {
    const text = textOf(
      built({
        application: record({ status: 'accepted', decidedBy: SECOND, decidedAt: NOW }),
      }),
    );

    expect(text).toContain(`**Accepted** by <@${SECOND}> <t:${Math.floor(NOW / 1000)}:R>`);
  });

  test('a display name the applicant chose cannot become markdown or a mention', () => {
    const text = textOf(built({ application: record({ applicantName: '**big** <@1> [x](y)' }) }));

    expect(text).toContain('\\*\\*big\\*\\* \\<@1\\> \\[x\\](y)');
  });

  test('problems show as text labels', () => {
    const text = textOf(
      built({
        problems: [
          { effectId: 'e1', kind: 'add_role', label: 'Role update failed' },
          { effectId: 'e2', kind: 'dm', label: 'DM not delivered' },
        ],
      }),
    );

    expect(text).toContain(
      '**Needs attention:** Role update failed · DM not delivered. Retry from the dashboard.',
    );
  });

  test('none shows no answers and points to where they are', () => {
    const text = textOf(built({ mode: 'none' }));

    expect(text).not.toContain('I like keeping');
    expect(text).toContain('The 3 answers aren’t shown on this card.');
    expect(text).toContain('Read all answers');
  });

  test('summary shows the first three answers, clipped, and counts the rest', () => {
    const text = textOf(
      built({ mode: 'summary', application: record({ answers: many(5, 1000) }) }),
    );

    expect(text).toContain('**Question 3**');
    expect(text).not.toContain('**Question 4**');
    expect(text).toContain('…and 2 more answers.');
    expect(text).toContain('Long answers are cut short here.');
    expect(text).not.toContain('x'.repeat(300));
  });

  test('applicant text is fenced with its backticks neutralised', () => {
    const text = textOf(built({ mode: 'full' }));

    expect(text).toContain("```\nI like keeping **places** tidy. 'rm -rf' @everyone <@1>\n```");
  });

  test('full mode with fifty 4000-character answers stays inside Discord’s limits', () => {
    const components = built({ mode: 'full', application: record({ answers: many(50, 4000) }) });

    expect(cardTextLength(components)).toBeLessThanOrEqual(CARD_TEXT_MAX);
    expect(cardComponentCount(components)).toBeLessThanOrEqual(CARD_COMPONENTS_MAX);
    expect(textOf(components)).toContain('more answers.');
  });

  test('full mode with fifty short answers packs them under 40 components', () => {
    const components = built({ mode: 'full', application: record({ answers: many(50, 10) }) });

    expect(cardComponentCount(components)).toBeLessThanOrEqual(CARD_COMPONENTS_MAX);
    expect(cardTextLength(components)).toBeLessThanOrEqual(CARD_TEXT_MAX);
    expect(textOf(components)).toContain('**Question 50**');
  });

  test.each(['none', 'summary', 'full'] as const)(
    'the %s card fits with the longest name, reason and problems',
    (mode) => {
      const components = built({
        mode,
        formName: 'F'.repeat(80),
        application: record({
          applicantName: '*'.repeat(100),
          status: 'waitlisted',
          decisionReason: 'r'.repeat(1000),
          answers: many(50, 4000),
        }),
        problems: [
          { effectId: 'a', kind: 'add_role', label: 'Role update failed' },
          { effectId: 'b', kind: 'dm', label: 'DM not delivered' },
          { effectId: 'c', kind: 'ticket', label: 'Ticket not opened' },
        ],
      });

      expect(cardTextLength(components)).toBeLessThanOrEqual(CARD_TEXT_MAX);
      expect(cardComponentCount(components)).toBeLessThanOrEqual(CARD_COMPONENTS_MAX);
    },
  );

  test('an open card has Claim, Accept, Reject, a dashboard link and More actions', () => {
    const components = built();

    expect(buttonLabels(components)).toEqual(['Claim', 'Accept…', 'Reject…', 'Open in dashboard']);
    expect(links(components)).toEqual([`${DASHBOARD}/review/${GUILD}/${APP_ID}`]);
    expect(customIds(components)).toEqual([
      customId(STAFF_ACTION.claim, APP_ID),
      customId(STAFF_ACTION.accept, APP_ID),
      customId(STAFF_ACTION.reject, APP_ID),
      customId(STAFF_ACTION.more, APP_ID),
    ]);
    expect(selectValues(components)).toEqual([
      MORE_CHOICES.info,
      MORE_CHOICES.waitlist,
      MORE_CHOICES.note,
      MORE_CHOICES.read,
    ]);
  });

  test('a claimed card offers Unclaim instead of Claim', () => {
    const components = built({
      application: record({ status: 'in_review', assigneeId: REVIEWER }),
    });

    expect(buttonLabels(components)[0]).toBe('Unclaim');
  });

  test('votes are offered only when scoring or two reviewers is on', () => {
    for (const review of [{ scoring: true }, { requireTwoReviewers: true }]) {
      const values = selectValues(built({ form: formConfig({ review }) }));
      expect(values).toContain(MORE_CHOICES.voteAccept);
      expect(values).toContain(MORE_CHOICES.voteReject);
    }
    expect(selectValues(built())).not.toContain(MORE_CHOICES.voteAccept);
  });

  test('an interview ticket is offered only when the form names a ticket type', () => {
    expect(selectValues(built())).not.toContain(MORE_CHOICES.ticket);
    expect(
      selectValues(built({ form: formConfig({ interview: { ticketTypeId: 'interview' } }) })),
    ).toContain(MORE_CHOICES.ticket);
  });

  test('without a dashboard address there is no dashboard link', () => {
    const components = built({ dashboardUrl: null });

    expect(links(components)).toEqual([]);
    expect(textOf(components)).not.toContain('Retry from the dashboard');
  });

  test.each(['accepted', 'rejected', 'withdrawn', 'expired'] satisfies ApplicationStatus[])(
    'a %s card keeps only Read all answers and the dashboard link',
    (status) => {
      const components = built({ application: record({ status, decidedBy: REVIEWER }) });

      expect(buttonLabels(components)).toEqual(['Read all answers', 'Open in dashboard']);
      expect(customIds(components)).toEqual([customId(STAFF_ACTION.read, APP_ID)]);
      expect(selectValues(components)).toEqual([]);
    },
  );

  test('a read-only card has no decision buttons even while open', () => {
    const components = built({ readOnly: true });

    expect(buttonLabels(components)).toEqual(['Read all answers', 'Open in dashboard']);
  });

  test('purged answers are explained, and there is nothing to read', () => {
    const components = built({
      application: record({ status: 'accepted', answers: null, contentPurgedAt: NOW }),
    });

    expect(textOf(components)).toContain('The answers were removed');
    expect(buttonLabels(components)).toEqual(['Open in dashboard']);
  });

  test('every custom id fits Discord’s 100 characters', () => {
    const components = built({
      form: formConfig({ review: { scoring: true }, interview: { ticketTypeId: 'interview' } }),
    });

    for (const id of customIds(components)) {
      expect(id.length).toBeLessThanOrEqual(MAX_CUSTOM_ID_LENGTH);
    }
  });

  test('drafts and deleted applications have no card', () => {
    expect(
      buildReviewCard(input({ application: record({ status: 'draft', number: null }) })),
    ).toEqual({
      ok: false,
      humanReason: 'This application hasn’t been sent yet, so there’s no card to show.',
    });
    expect(buildReviewCard(input({ application: record({ deletedAt: NOW }) })).ok).toBe(false);
  });

  test('a notice line shows under the heading', () => {
    expect(textOf(built({ notice: 'The form was removed.' }))).toContain(
      '-# The form was removed.',
    );
  });

  test('the card is a V2 message that pings nobody and Discord accepts as a post', () => {
    const message = cardMessage(
      built({ mode: 'full', application: record({ answers: many(50, 4000) }) }),
    );

    expect(message.flags).toBe(32768);
    expect(message.allowedMentions).toEqual({ parse: [] });
    expect(message.content).toBeUndefined();
    expect(message.embeds).toBeUndefined();

    const mapped = toRestCall({
      guildId: GUILD,
      moduleId: 'applications',
      kind: 'send',
      actorId: 'proton:applications',
      idempotencyKey: 'test',
      dryRun: false,
      record: false,
      payload: {
        channelId: '500000000000000001',
        components: message.components,
        flags: message.flags,
        allowedMentions: message.allowedMentions,
      },
    });
    expect('error' in mapped ? mapped.error : null).toBe(null);
  });
});
