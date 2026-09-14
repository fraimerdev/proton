import {
  type PlaceholderSurface,
  SAMPLE_NOW,
  type TemplateFieldSpec,
} from '@proton/core/placeholders';
import type { RefCallback, RefObject } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type Dismissal,
  type DynamicPlaceholder,
  dismissalFor,
  fieldAria,
  isListOpen,
  listKeyAction,
  nextDismissal,
  type OpenPlaceholder,
  openPlaceholderAt,
  type PlaceholderFieldAria,
  placeholderReplacement,
  rankSuggestions,
  type SuggestionOption,
  suggestionOptions,
  suggestionSample,
  wrapIndex,
} from './autocomplete.ts';

export type PlaceholderElement = HTMLInputElement | HTMLTextAreaElement;

export interface PlaceholderFieldProps extends PlaceholderFieldAria {
  ref: RefCallback<PlaceholderElement>;
}

export interface SuggestionRow {
  key: string;
  label: string;
  sample: string | undefined;
}

export interface PlaceholderAutocomplete {
  field: PlaceholderFieldProps;
  spec: TemplateFieldSpec;
  open: boolean;
  listId: string;
  label: string;
  rows: readonly SuggestionRow[];
  active: number;
  fragment: OpenPlaceholder | null;
  element: RefObject<PlaceholderElement | null>;
  choose: (index: number) => void;
  highlight: (index: number) => void;
}

export interface PlaceholderAutocompleteOptions {
  surface: PlaceholderSurface<unknown>;
  path: string;
  onChange: (next: string) => void;
  dynamic?: readonly DynamicPlaceholder[] | undefined;
}

interface Typing {
  fragment: OpenPlaceholder | null;
  multiline: boolean;
  active: number;
  dismissal: Dismissal | null;
}

const IDLE: Typing = { fragment: null, multiline: false, active: 0, dismissal: null };

const NO_OPTIONS: readonly SuggestionOption[] = [];

const NO_ROWS: readonly SuggestionRow[] = [];

const READS = ['input', 'select', 'selectionchange', 'keyup', 'pointerup', 'focus'] as const;

const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

function sameFragment(a: OpenPlaceholder | null, b: OpenPlaceholder | null): boolean {
  if (a === null || b === null) return a === b;
  return a.start === b.start && a.caret === b.caret && a.end === b.end && a.word === b.word;
}

function fragmentOf(node: PlaceholderElement): OpenPlaceholder | null {
  if (node.ownerDocument.activeElement !== node) return null;

  const { selectionStart, selectionEnd, value } = node;
  if (selectionStart === null || selectionStart !== selectionEnd) return null;

  return openPlaceholderAt(value, selectionStart);
}

function insertText(token: string): boolean {
  try {
    return document.execCommand('insertText', false, token);
  } catch {
    return false;
  }
}

function settle(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

export function usePlaceholderAutocomplete({
  surface,
  path,
  onChange,
  dynamic,
}: PlaceholderAutocompleteOptions): PlaceholderAutocomplete {
  const listId = useId();
  const element = useRef<PlaceholderElement | null>(null);
  const [typing, setTyping] = useState<Typing>(IDLE);

  const spec = surface.fieldAt(path);
  const { fragment } = typing;
  const typingPlaceholder = fragment !== null;

  const options = useMemo(
    () =>
      typingPlaceholder && spec !== undefined
        ? suggestionOptions(surface, spec, dynamic)
        : NO_OPTIONS,
    [typingPlaceholder, surface, spec, dynamic],
  );

  const query = fragment?.query;
  const matches = useMemo(
    () => (query === undefined ? NO_OPTIONS : rankSuggestions(options, query)),
    [options, query],
  );

  const open = isListOpen(fragment, typing.dismissal, matches.length);

  const lookup = useMemo(() => {
    const sample = surface.samples[0];
    return open && sample !== undefined
      ? surface.build(sample.facts, { now: SAMPLE_NOW })
      : undefined;
  }, [open, surface]);

  const rows = useMemo((): readonly SuggestionRow[] => {
    if (!open || spec === undefined) return NO_ROWS;

    return matches.map((option) => ({
      key: option.key,
      label: option.label,
      sample: lookup === undefined ? undefined : suggestionSample(surface, spec, option, lookup),
    }));
  }, [open, spec, matches, lookup, surface]);

  const active = Math.min(typing.active, Math.max(0, rows.length - 1));

  const latest = useRef({ open, rows, active, onChange });
  useIsomorphicLayoutEffect(() => {
    latest.current = { open, rows, active, onChange };
  });

  const read = useCallback((node: PlaceholderElement) => {
    const next = fragmentOf(node);
    const multiline = node.tagName === 'TEXTAREA';

    setTyping((current) => {
      const dismissal = nextDismissal(current.dismissal, next);

      if (
        sameFragment(current.fragment, next) &&
        dismissal === current.dismissal &&
        multiline === current.multiline
      ) {
        return current;
      }

      const kept =
        current.fragment !== null &&
        next !== null &&
        current.fragment.start === next.start &&
        current.fragment.query === next.query;

      return { fragment: next, multiline, active: kept ? current.active : 0, dismissal };
    });
  }, []);

  const highlight = useCallback((index: number) => {
    latest.current.active = index;
    setTyping((current) => (current.active === index ? current : { ...current, active: index }));
  }, []);

  const choose = useCallback(
    (index: number) => {
      const node = element.current;
      const row = latest.current.rows[index];
      if (node === null || row === undefined) return;

      if (node.ownerDocument.activeElement !== node) node.focus({ preventScroll: true });

      const before = node.value;
      const current = fragmentOf(node);
      const replacement =
        current === null ? null : placeholderReplacement(before, current, row.key, node.maxLength);
      if (replacement === null) return;

      node.setSelectionRange(replacement.start, replacement.end);
      if (!insertText(replacement.token) || node.value === before) {
        node.setRangeText(replacement.token, replacement.start, replacement.end, 'end');
        latest.current.onChange(node.value);
      }
      node.setSelectionRange(replacement.caret, replacement.caret);

      latest.current.open = false;
      read(node);
    },
    [read],
  );

  const keydown = useCallback(
    (event: KeyboardEvent) => {
      const { open: listed, rows: shown, active: at } = latest.current;
      if (!listed) return;

      const action = listKeyAction(event);
      if (action === undefined) return;

      settle(event);

      if (action === 'accept') {
        choose(at);
        return;
      }

      if (action === 'dismiss') {
        latest.current.open = false;
        setTyping((current) =>
          current.fragment === null
            ? current
            : { ...current, dismissal: dismissalFor(current.fragment) },
        );
        return;
      }

      highlight(wrapIndex(at + (action === 'next' ? 1 : -1), shown.length));
    },
    [choose, highlight],
  );

  const ref = useCallback<RefCallback<PlaceholderElement>>(
    (node) => {
      element.current = node;
      if (node === null) return;

      const sync = (): void => read(node);
      const key = (event: Event): void => {
        if (event instanceof KeyboardEvent) keydown(event);
      };
      const blur = (): void =>
        setTyping((current) =>
          current.fragment === null ? current : { ...current, fragment: null, active: 0 },
        );

      for (const name of READS) node.addEventListener(name, sync);
      node.addEventListener('blur', blur);
      node.addEventListener('keydown', key);

      return () => {
        for (const name of READS) node.removeEventListener(name, sync);
        node.removeEventListener('blur', blur);
        node.removeEventListener('keydown', key);
        if (element.current === node) element.current = null;
      };
    },
    [read, keydown],
  );

  const field = useMemo(
    (): PlaceholderFieldProps => ({
      ref,
      ...fieldAria({ multiline: typing.multiline, open, listId, active }),
    }),
    [ref, typing.multiline, open, listId, active],
  );

  if (spec === undefined) {
    throw new Error(
      `The ${surface.label} placeholders have no field at ${path}, so this field cannot suggest placeholders.`,
    );
  }

  return {
    field,
    spec,
    open,
    listId,
    label: `Placeholders for ${spec.label.toLowerCase()}`,
    rows,
    active,
    fragment,
    element,
    choose,
    highlight,
  };
}
