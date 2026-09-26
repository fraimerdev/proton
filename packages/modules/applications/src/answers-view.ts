import type { CheckedAnswer } from './questions.ts';

export const ANSWER_PAGE_BUDGET = 3500;

const PAGE_BUDGET_MIN = 200;
const CHUNK_MIN = 120;
const LABEL_SHOWN_MAX = 100;
const BREAK_WINDOW = 200;
const FENCE = '```';
const GAP = '\n\n';

// Swapping every backtick means an answer can never close the fence it's shown in.
export function neutralise(text: string): string {
  return text.replaceAll('`', "'");
}

export function fence(text: string): string {
  return [FENCE, text.length > 0 ? text : ' ', FENCE].join('\n');
}

function heading(label: string, continued: boolean): string {
  const shown = label.length > LABEL_SHOWN_MAX ? `${label.slice(0, LABEL_SHOWN_MAX - 1)}…` : label;
  return continued ? `**${shown}** (continued)` : `**${shown}**`;
}

function block(head: string, text: string): string {
  return `${head}\n${fence(text)}`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function splitPoint(text: string, space: number): number {
  let cut = Math.max(1, Math.min(space, text.length));
  if (cut >= text.length) return text.length;

  const floor = Math.max(1, cut - BREAK_WINDOW);
  const window = text.slice(floor, cut);
  const newline = window.lastIndexOf('\n');
  const blank = window.lastIndexOf(' ');
  const at = newline >= 0 ? newline : blank;
  if (at >= 0) cut = floor + at + 1;

  if (cut > 1 && isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
  return cut;
}

export function answerPages(
  answers: readonly CheckedAnswer[],
  budget: number = ANSWER_PAGE_BUDGET,
): string[] {
  const limit = Math.max(Math.floor(budget), PAGE_BUDGET_MIN);
  const pages: string[] = [];
  let page = '';

  const room = (): number => limit - (page === '' ? 0 : page.length + GAP.length);
  const add = (piece: string): void => {
    page = page === '' ? piece : `${page}${GAP}${piece}`;
  };
  const turn = (): void => {
    if (page !== '') pages.push(page);
    page = '';
  };

  for (const answer of answers) {
    let text = neutralise(answer.display);
    let continued = false;

    for (;;) {
      const head = heading(answer.label, continued);
      const whole = block(head, text);

      if (whole.length <= room()) {
        add(whole);
        break;
      }

      if (page !== '' && whole.length <= limit) {
        turn();
        continue;
      }

      const space = room() - block(head, '').length + 1;
      if (page !== '' && space < CHUNK_MIN) {
        turn();
        continue;
      }

      const cut = splitPoint(text, space);
      add(block(head, text.slice(0, cut)));
      turn();

      text = text.slice(cut);
      continued = true;
      if (text.length === 0) break;
    }
  }

  turn();
  return pages;
}
