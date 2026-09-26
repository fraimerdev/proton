import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { ANSWER_PAGE_BUDGET, answerPages, fence, neutralise } from '../src/answers-view.ts';
import type { CheckedAnswer } from '../src/questions.ts';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function answer(label: string, display: string): CheckedAnswer {
  return {
    questionId: label.toLowerCase().replace(/[^a-z0-9]/g, '') || 'q',
    sectionId: 'main',
    label,
    type: 'paragraph',
    value: display,
    display,
  };
}

function pieces(pages: readonly string[]): { label: string; continued: boolean; text: string }[] {
  const found: { label: string; continued: boolean; text: string }[] = [];
  const block = /\*\*(.+?)\*\*( \(continued\))?\n```\n([\s\S]*?)\n```/g;
  for (const page of pages) {
    for (const match of page.matchAll(block)) {
      found.push({
        label: match[1] ?? '',
        continued: match[2] !== undefined,
        text: match[3] ?? '',
      });
    }
  }
  return found;
}

function rebuilt(pages: readonly string[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const piece of pieces(pages)) {
    texts.set(piece.label, (texts.get(piece.label) ?? '') + piece.text);
  }
  return texts;
}

describe('answerPages', () => {
  test('no answers means no pages', () => {
    expect(answerPages([])).toEqual([]);
  });

  test('short answers share one page, each labelled and fenced', () => {
    const pages = answerPages([answer('Name', 'Ada'), answer('Why', 'I like it here.')]);

    expect(pages).toEqual(['**Name**\n```\nAda\n```\n\n**Why**\n```\nI like it here.\n```']);
  });

  test('applicant text cannot break out of its fence or become markdown', () => {
    const hostile = '```\n**bold** [link](https://x.y) <@1> @everyone\n```';
    const [page] = answerPages([answer('Why', hostile)]);

    expect(page).toBe(`**Why**\n${fence(neutralise(hostile))}`);
    expect((page ?? '').match(/```/g)).toHaveLength(2);
    expect(page).toContain("'''");
  });

  test('a 4000-character answer continues on the next page instead of being cut', () => {
    const long = 'word '.repeat(800).trim();
    const pages = answerPages([answer('Why', long)]);

    expect(pages.length).toBe(2);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(ANSWER_PAGE_BUDGET);
    expect(pages[1]).toStartWith('**Why** (continued)');
    expect(rebuilt(pages).get('Why')).toBe(long);
  });

  test('fifty 4000-character answers page cleanly with nothing lost', () => {
    const answers = Array.from({ length: 50 }, (_, index) =>
      answer(`Question ${index + 1}`, `${index}`.padEnd(4000, 'x')),
    );
    const pages = answerPages(answers);

    for (const page of pages) expect(page.length).toBeLessThanOrEqual(ANSWER_PAGE_BUDGET);
    const texts = rebuilt(pages);
    for (const item of answers) expect(texts.get(item.label)).toBe(item.display);
  });

  test('a split never lands between the halves of an emoji', () => {
    const pages = answerPages([answer('Mood', '😀'.repeat(3000))], 500);

    for (const page of pages) expect(LONE_SURROGATE.test(page)).toBe(false);
    expect(rebuilt(pages).get('Mood')).toBe('😀'.repeat(3000));
  });

  test('a tiny budget is raised to a workable minimum', () => {
    const pages = answerPages([answer('Why', 'x'.repeat(1000))], 10);

    for (const page of pages) expect(page.length).toBeLessThanOrEqual(200);
    expect(rebuilt(pages).get('Why')).toBe('x'.repeat(1000));
  });

  test('pages always fit the budget and give every answer back exactly', () => {
    const text = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 4000 });
    fc.assert(
      fc.property(
        fc.array(text, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 200, max: 4000 }),
        (displays, budget) => {
          const answers = displays.map((display, index) => answer(`Q${index}`, display));
          const pages = answerPages(answers, budget);

          for (const page of pages) expect(page.length).toBeLessThanOrEqual(budget);
          const texts = rebuilt(pages);
          for (const item of answers) expect(texts.get(item.label)).toBe(neutralise(item.display));
        },
      ),
      { numRuns: 150 },
    );
  });
});
