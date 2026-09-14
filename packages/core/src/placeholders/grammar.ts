import type { PlaceholderRegistry } from './definitions.ts';
import {
  createReporter,
  type DiagnosticCode,
  type Span,
  type TemplateDiagnostic,
} from './diagnostics.ts';
import { BRACE_ESCAPE_HELP, PLACEHOLDER_LIMITS } from './limits.ts';
import type { ModifierArgument, ParsedModifier } from './modifiers.ts';

export interface TextToken {
  kind: 'text';
  text: string;
  span: Span;
}

export interface PlaceholderToken {
  kind: 'placeholder';
  raw: string;
  key: string;
  canonical: string | null;
  modifiers: readonly ParsedModifier[];
  span: Span;
}

export type TemplateToken = TextToken | PlaceholderToken;

export interface ParsedTemplate {
  source: string;
  tokens: readonly TemplateToken[];
  diagnostics: readonly TemplateDiagnostic[];
}

const KEY = /[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/y;

const NAME = /[a-z][a-z0-9_]*/y;

const NUMBER = /-?\d+(?:\.\d+)?/y;

const BRACE = /[{}]/g;

const LONE_CLOSE = `this } does not close a placeholder, so it is posted as written. ${BRACE_ESCAPE_HELP}`;

interface Failure {
  ok: false;
  code: DiagnosticCode;
  message: string;
  end: number;
}

type Attempt = { ok: true; key: string; modifiers: ParsedModifier[]; end: number } | Failure;

type ArgumentRead = { ok: true; value: ModifierArgument; end: number } | Failure;

function fail(code: DiagnosticCode, message: string, end: number): Failure {
  return { ok: false, code, message, end };
}

function stickyMatch(pattern: RegExp, source: string, at: number): string | undefined {
  pattern.lastIndex = at;
  return pattern.exec(source)?.[0];
}

function loneOpen(next: string): string {
  const spaced = /\s/.test(next) ? ' Placeholders cannot contain spaces.' : '';
  return `this { does not start a placeholder, so it is posted as written.${spaced} ${BRACE_ESCAPE_HELP}`;
}

function readArgument(source: string, at: number, name: string): ArgumentRead {
  const max = PLACEHOLDER_LIMITS.argumentLength;

  if (source.charAt(at) === '"') {
    let value = '';
    let index = at + 1;

    while (index < source.length) {
      const character = source.charAt(index);
      if (character === '"') return { ok: true, value, end: index + 1 };

      if (character === '\\') {
        const escaped = source.charAt(index + 1);
        if (escaped !== '"' && escaped !== '\\') {
          return fail(
            'malformed_placeholder',
            `inside quoted text for :${name}, a backslash can only come before " or another backslash`,
            index + 1,
          );
        }
        value += escaped;
        index += 2;
      } else {
        value += character;
        index += 1;
      }

      if (value.length > max) {
        return fail(
          'argument_too_long',
          `an argument to :${name} is longer than ${max} characters`,
          index,
        );
      }
    }

    return fail('malformed_placeholder', `quoted text for :${name} is never closed with "`, index);
  }

  const number = stickyMatch(NUMBER, source, at);

  if (number === undefined) {
    return fail(
      'malformed_placeholder',
      `an argument to :${name} must be a number or text in double quotes`,
      at + 1,
    );
  }

  if (number.length > max) {
    return fail(
      'argument_too_long',
      `an argument to :${name} is longer than ${max} characters`,
      at + max,
    );
  }

  return { ok: true, value: Number(number), end: at + number.length };
}

function attempt(source: string, start: number): Attempt {
  let at = start + 1;

  const key = stickyMatch(KEY, source, at);
  if (key === undefined) return fail('lone_brace', loneOpen(source.charAt(at)), at);

  if (key.length > PLACEHOLDER_LIMITS.keyLength) {
    return fail(
      'key_too_long',
      `a placeholder name is at most ${PLACEHOLDER_LIMITS.keyLength} characters and this one is ${key.length}, so it is posted as written`,
      at + key.length,
    );
  }
  at += key.length;

  const modifiers: ParsedModifier[] = [];

  while (source.charAt(at) === ':') {
    const modifierStart = at;

    if (modifiers.length === PLACEHOLDER_LIMITS.modifiers) {
      return fail(
        'too_many_modifiers',
        `{${key}} has more than ${PLACEHOLDER_LIMITS.modifiers} modifiers, the most a placeholder takes`,
        at + 1,
      );
    }
    at += 1;

    const name = stickyMatch(NAME, source, at);
    if (name === undefined) {
      return fail('malformed_placeholder', `expected a modifier name after : in {${key}`, at + 1);
    }
    at += name.length;

    const args: ModifierArgument[] = [];

    if (source.charAt(at) === '(') {
      at += 1;

      for (;;) {
        if (args.length === PLACEHOLDER_LIMITS.arguments) {
          return fail(
            'too_many_arguments',
            `:${name} is given more than ${PLACEHOLDER_LIMITS.arguments} arguments`,
            at + 1,
          );
        }

        const arg = readArgument(source, at, name);
        if (!arg.ok) return arg;

        args.push(arg.value);
        at = arg.end;

        const next = source.charAt(at);
        if (next === ',') {
          at += 1;
          continue;
        }
        if (next === ')') {
          at += 1;
          break;
        }

        const spaced = /\s/.test(next) ? '; spaces are not allowed between arguments' : '';
        return fail(
          'malformed_placeholder',
          `expected , or ) after an argument to :${name}${spaced}`,
          at + 1,
        );
      }
    }

    modifiers.push({ name, args, span: { start: modifierStart, end: at } });
  }

  if (source.charAt(at) === '}') return { ok: true, key, modifiers, end: at + 1 };

  if (modifiers.length === 0) return fail('lone_brace', loneOpen(source.charAt(at)), at + 1);

  return fail('malformed_placeholder', `expected } to close {${key}`, at + 1);
}

export function parseTemplate(source: string, registry?: PlaceholderRegistry): ParsedTemplate {
  const reporter = createReporter();
  const max = PLACEHOLDER_LIMITS.templateLength;

  if (source.length > max) {
    reporter.report(
      'template_too_long',
      `this template is ${source.length} characters long; a template holds at most ${max}, so nothing in it is filled in`,
      { start: max, end: source.length },
    );

    return {
      source,
      tokens: [{ kind: 'text', text: source, span: { start: 0, end: source.length } }],
      diagnostics: reporter.diagnostics,
    };
  }

  const tokens: TemplateToken[] = [];
  let text = '';
  let textStart = 0;
  let placeholders = 0;
  let overflowReported = false;
  let rejectedOpen = false;
  let index = 0;

  const literal = (value: string, at: number): void => {
    if (text === '') textStart = at;
    text += value;
  };

  const flush = (at: number): void => {
    if (text !== '') tokens.push({ kind: 'text', text, span: { start: textStart, end: at } });
    text = '';
  };

  while (index < source.length) {
    const character = source.charAt(index);

    if (character !== '{' && character !== '}') {
      BRACE.lastIndex = index;
      const next = BRACE.exec(source)?.index ?? source.length;
      literal(source.slice(index, next), index);
      index = next;
      continue;
    }

    const closesRejected = rejectedOpen;
    rejectedOpen = false;

    if (source.charAt(index + 1) === character) {
      literal(character, index);
      index += 2;
      continue;
    }

    if (character === '}') {
      if (!closesRejected) {
        reporter.report('lone_brace', LONE_CLOSE, { start: index, end: index + 1 });
      }
      literal('}', index);
      index += 1;
      continue;
    }

    const result = attempt(source, index);

    if (!result.ok) {
      const end = Math.min(Math.max(result.end, index + 1), source.length);
      reporter.report(result.code, result.message, { start: index, end });
      rejectedOpen = result.code !== 'lone_brace';
      literal('{', index);
      index += 1;
      continue;
    }

    const raw = source.slice(index, result.end);
    const span = { start: index, end: result.end };

    if (placeholders === PLACEHOLDER_LIMITS.placeholders) {
      if (!overflowReported) {
        reporter.report(
          'too_many_placeholders',
          `a template fills in at most ${PLACEHOLDER_LIMITS.placeholders} placeholders, so ${raw} and every placeholder after it are posted as written`,
          span,
        );
        overflowReported = true;
      }

      literal(raw, index);
      index = result.end;
      continue;
    }

    placeholders += 1;
    flush(index);
    tokens.push({
      kind: 'placeholder',
      raw,
      key: result.key,
      canonical: registry?.resolve(result.key)?.canonical ?? null,
      modifiers: result.modifiers,
      span,
    });
    index = result.end;
  }

  flush(source.length);

  return { source, tokens, diagnostics: reporter.diagnostics };
}
