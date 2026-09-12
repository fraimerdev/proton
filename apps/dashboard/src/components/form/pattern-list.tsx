import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useId,
  useState,
} from 'react';
import { Icon } from '../shell/icon.tsx';

export type PatternSyntax = 'regex' | 'phrase';

/**
 * The string lists whose entries are code rather than words, and the ones whose entries are phrases
 * a comma can sit inside. Nothing in a FieldDescriptor distinguishes them — `kind: 'string'` with
 * `array: true` is all any of them is — so the fact is recorded here until a descriptor can carry
 * it. A path missing from this table gets the chip input, which is what it had before.
 */
const PATTERN_PATHS: Readonly<Record<string, PatternSyntax>> = {
  regexPatterns: 'regex',
  blockedWords: 'phrase',
  allowedWords: 'phrase',
};

export function patternSyntaxFor(path: string): PatternSyntax | null {
  return PATTERN_PATHS[path] ?? null;
}

// Past this the list is long enough that finding one entry by eye stops working, and a filter is
// cheaper than scrolling 400 rows of blocked words.
const FILTER_FROM = 12;

export interface PatternFault {
  message: string;
  at: number | null;
}

const ENGINE_PREFIX = /^Invalid regular expression:?\s*(\/.*\/:\s*)?/;

/**
 * What is wrong with a pattern, and where. The structural scan runs first because it is the only
 * part that can name a position: neither engine reports one, and their wording differs — V8 says
 * "Unterminated group", JavaScriptCore says "missing )" — so the scan is also what makes the
 * message the same in the browser and in a test.
 */
export function regexFault(pattern: string): PatternFault | null {
  const structural = structuralFault(pattern);
  if (structural) return structural;

  try {
    new RegExp(pattern);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return { message: raw.replace(ENGINE_PREFIX, ''), at: null };
  }

  return null;
}

function structuralFault(pattern: string): PatternFault | null {
  const groups: number[] = [];
  let classAt: number | null = null;

  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at];

    if (char === '\\') {
      at += 1;
      continue;
    }

    if (classAt !== null) {
      if (char === ']') classAt = null;
      continue;
    }

    if (char === '[') classAt = at;
    else if (char === '(') groups.push(at);
    else if (char === ')') {
      if (groups.pop() === undefined) {
        return { message: 'a closing bracket with nothing to close', at };
      }
    }
  }

  if (classAt !== null) {
    return { message: 'a character class that is never closed', at: classAt };
  }

  const unclosed = groups.at(-1);
  if (unclosed !== undefined) return { message: 'a group that is never closed', at: unclosed };

  return null;
}

function faultLine(fault: PatternFault): string {
  return fault.at === null
    ? `Not a regular expression: ${fault.message}.`
    : `Not a regular expression: ${fault.message}, at character ${fault.at + 1}.`;
}

function matches(pattern: string, syntax: PatternSyntax, sample: string): boolean | null {
  if (sample === '' || pattern === '') return null;
  if (syntax !== 'regex') return null;
  if (regexFault(pattern) !== null) return null;

  try {
    return new RegExp(pattern, 'i').test(sample);
  } catch {
    return null;
  }
}

export interface PatternListProps {
  id: string;
  label: string;
  values: readonly string[];
  onChange: (next: string[]) => void;
  syntax: PatternSyntax;
  max?: number | undefined;
  maxLength?: number | undefined;
  describedBy?: string | undefined;
}

/**
 * One row per entry, committed on Enter and editable where it sits. The chip input this replaces
 * committed on Enter *or comma*, so `a{2,5}` became two chips — `a{2` and `5}` — neither of them a
 * pattern, with no validation anywhere to say so and Discord silently enforcing nothing.
 */
export function PatternList({
  id,
  label,
  values,
  onChange,
  syntax,
  max,
  maxLength,
  describedBy,
}: PatternListProps): ReactElement {
  const base = useId();
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [sample, setSample] = useState('');
  const [duplicate, setDuplicate] = useState<string | null>(null);

  const atCapacity = max !== undefined && values.length >= max;
  const needle = filter.trim().toLowerCase();

  const shown = values
    .map((value, index) => ({ value, index }))
    .filter((row) => needle === '' || row.value.toLowerCase().includes(needle));

  function add(): void {
    const text = draft.trim();
    if (text === '' || atCapacity) return;

    if (values.includes(text)) {
      setDuplicate(text);
      return;
    }

    setDraft('');
    setDuplicate(null);
    onChange([...values, text]);
  }

  function edit(index: number, next: string): void {
    onChange(values.map((held, at) => (at === index ? next : held)));
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    // Enter alone. A comma is a quantifier's own punctuation, and committing on it is the bug.
    if (event.key !== 'Enter') return;

    event.preventDefault();
    add();
  }

  return (
    <div className="pattern-field">
      {values.length >= FILTER_FROM ? (
        <div className="pattern-filter">
          <Icon name="magnifying-glass" />
          <input
            type="text"
            value={filter}
            aria-label={`Filter ${label}`}
            placeholder="Filter this list…"
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      ) : null}

      <div className="pattern-list">
        {shown.map((row) => {
          const fault = syntax === 'regex' ? regexFault(row.value) : null;
          const hit = matches(row.value, syntax, sample);
          const errorId = `${base}-${row.index}-error`;

          return (
            <div
              className="pattern-row"
              // Keyed on position, not on the text: the text is what is being edited, so keying on
              // it remounted the box on every keystroke and dropped the cursor.
              key={row.index}
              data-bad={fault ? 'true' : undefined}
            >
              <input
                className="pattern-entry"
                type="text"
                value={row.value}
                spellCheck={false}
                autoComplete="off"
                maxLength={maxLength}
                aria-label={`${label} ${row.index + 1}`}
                aria-invalid={fault !== null || undefined}
                aria-describedby={fault ? errorId : undefined}
                onChange={(event) => edit(row.index, event.target.value)}
              />

              {hit === null ? null : (
                <span className="pattern-hit" data-hit={hit ? 'true' : undefined}>
                  {hit ? 'matches' : 'no match'}
                </span>
              )}

              <button
                type="button"
                className="pattern-remove"
                aria-label={`Remove ${row.value}`}
                onClick={() => onChange(values.filter((_, at) => at !== row.index))}
              >
                <Icon name="x" />
              </button>

              {fault ? (
                <p className="pattern-error" id={errorId} role="alert">
                  {faultLine(fault)}
                </p>
              ) : null}
            </div>
          );
        })}

        {values.length === 0 ? <p className="pattern-empty">None yet.</p> : null}

        {values.length > 0 && shown.length === 0 ? (
          <p className="pattern-empty">Nothing in this list matches “{filter.trim()}”.</p>
        ) : null}
      </div>

      <div className="pattern-add">
        <input
          id={id}
          className="pattern-entry"
          type="text"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          maxLength={maxLength}
          aria-label={`Add ${label}`}
          aria-describedby={describedBy}
          placeholder={syntax === 'regex' ? 'One pattern, then Enter' : 'One entry, then Enter'}
          disabled={atCapacity}
          onChange={(event) => {
            setDraft(event.target.value);
            setDuplicate(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={add}
        />
        <span className="pattern-count">
          {max === undefined ? `${values.length}` : `${values.length} of ${max}`}
        </span>
      </div>

      {duplicate === null ? null : (
        <p className="pattern-note" role="alert">
          “{duplicate}” is already in this list.
        </p>
      )}

      {atCapacity ? <p className="pattern-note">Limit of {max} reached</p> : null}

      {syntax === 'regex' ? (
        <div className="pattern-try">
          <label className="pattern-try-label" htmlFor={`${base}-sample`}>
            Try it against a message
          </label>
          <input
            id={`${base}-sample`}
            type="text"
            value={sample}
            spellCheck={false}
            placeholder="Paste something a member might post"
            onChange={(event) => setSample(event.target.value)}
          />
          {sample === '' ? null : (
            <p className="pattern-try-result">
              {/* Case-insensitive, because that is how the automod check runs them. */}
              {values.filter((value) => matches(value, syntax, sample) === true).length} of{' '}
              {values.length} match this.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
