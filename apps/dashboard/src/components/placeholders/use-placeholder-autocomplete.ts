import {
  type PlaceholderLookup,
  type PlaceholderSurface,
  SAMPLE_NOW,
  type Span,
  type TemplateFieldSpec,
} from '@proton/core/placeholders';
import type { RefCallback, RefObject } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type Dismissal,
  type DynamicPlaceholder,
  dismissalFor,
  type FragmentKind,
  fieldAria,
  groupSuggestions,
  interceptsKey,
  isListOpen,
  listKeyAction,
  modifierOptions,
  nextDismissal,
  type OpenPlaceholder,
  openPlaceholderAt,
  PLACEHOLDER_HINT,
  type PlaceholderFieldAria,
  pendingSpan,
  rankSuggestions,
  type SuggestionOption,
  suggestionDetail,
  suggestionOptions,
  suggestionReplacement,
  suggestionSample,
  wrapIndex,
} from './autocomplete.ts';

export type PlaceholderElement = HTMLInputElement | HTMLTextAreaElement;

export interface PlaceholderFieldProps extends PlaceholderFieldAria {
  ref: RefCallback<PlaceholderElement>;
  'aria-description'?: string | undefined;
}

export interface SuggestionRow {
  id: string;
  index: number;
  token: string;
  label: string;
  sample: string | undefined;
}

export interface SuggestionRowGroup {
  label: string;
  rows: readonly SuggestionRow[];
}

export interface PlaceholderAutocomplete {
  field: PlaceholderFieldProps;
  spec: TemplateFieldSpec;
  open: boolean;
  kind: FragmentKind;
  listId: string;
  label: string;
  groups: readonly SuggestionRowGroup[];
  rows: readonly SuggestionRow[];
  active: number;
  detail: readonly string[];
  fragment: OpenPlaceholder | null;
  pending: Span | null;
  hint: boolean;
  text: string;
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

interface SampleCache {
  lookup: PlaceholderLookup | undefined;
  spec: TemplateFieldSpec | undefined;
  values: Map<string, string>;
}

interface Typing {
  fragment: OpenPlaceholder | null;
  pending: Span | null;
  multiline: boolean;
  active: number;
  dismissal: Dismissal | null;
  focused: boolean;
  text: string;
}

const IDLE: Typing = {
  fragment: null,
  pending: null,
  multiline: false,
  active: 0,
  dismissal: null,
  focused: false,
  text: '',
};

const NO_OPTIONS: readonly SuggestionOption[] = [];

const NO_ROWS: readonly SuggestionRow[] = [];

const NO_GROUPS: readonly SuggestionRowGroup[] = [];

const NO_DETAIL: readonly string[] = [];

const READS = ['input', 'select', 'selectionchange', 'keyup', 'pointerup'] as const;

const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

function sameFragment(a: OpenPlaceholder | null, b: OpenPlaceholder | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.kind === b.kind &&
    a.start === b.start &&
    a.caret === b.caret &&
    a.end === b.end &&
    a.word === b.word &&
    a.closed === b.closed &&
    a.prefix === b.prefix
  );
}

function sameSpan(a: Span | null, b: Span | null): boolean {
  if (a === null || b === null) return a === b;
  return a.start === b.start && a.end === b.end;
}

function fragmentOf(node: PlaceholderElement): OpenPlaceholder | null {
  if (node.ownerDocument.activeElement !== node) return null;

  const { selectionStart, selectionEnd, value } = node;
  if (selectionStart === null || selectionStart !== selectionEnd) return null;

  return openPlaceholderAt(value, selectionStart);
}

function insertText(text: string): boolean {
  try {
    return document.execCommand('insertText', false, text);
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
  const composing = useRef(false);
  const [typing, setTyping] = useState<Typing>(IDLE);

  const spec = surface.fieldAt(path);
  const { fragment } = typing;
  const kind: FragmentKind = fragment?.kind ?? 'placeholder';
  const browsing = fragment !== null;
  const startsLink =
    spec?.kind === 'url' &&
    fragment?.kind === 'placeholder' &&
    typing.text.slice(0, fragment.start).trim() === '';

  const placeholders = useMemo(
    () =>
      browsing && spec !== undefined
        ? suggestionOptions(surface, spec, dynamic, startsLink)
        : NO_OPTIONS,
    [browsing, surface, spec, dynamic, startsLink],
  );

  const modifierKey = fragment?.kind === 'modifier' ? fragment.key : undefined;
  const modifierChain = fragment?.kind === 'modifier' ? fragment.previous.join(':') : undefined;

  const modifiers = useMemo(
    () =>
      modifierKey !== undefined && modifierChain !== undefined && spec !== undefined
        ? modifierOptions(surface, spec, {
            key: modifierKey,
            previous: modifierChain === '' ? [] : modifierChain.split(':'),
          })
        : NO_OPTIONS,
    [modifierKey, modifierChain, surface, spec],
  );

  const query = fragment?.query;
  const options = kind === 'modifier' ? modifiers : placeholders;

  const matches = useMemo(
    () => (query === undefined ? NO_OPTIONS : rankSuggestions(options, query)),
    [options, query],
  );

  const grouped = useMemo(() => groupSuggestions(matches), [matches]);

  const ordered = useMemo(() => grouped.flatMap((group) => group.options), [grouped]);

  const knownKey =
    fragment?.kind !== 'modifier' || surface.registry.resolve(fragment.key) !== undefined;

  const open = isListOpen(fragment, typing.dismissal) && knownKey;

  const lookup = useMemo(() => {
    const sample = surface.samples[0];
    return open && sample !== undefined
      ? surface.build(sample.facts, { now: SAMPLE_NOW })
      : undefined;
  }, [open, surface]);

  const samples = useRef<SampleCache>({ lookup: undefined, spec: undefined, values: new Map() });

  const prefix = fragment?.prefix ?? '';

  const rows = useMemo((): readonly SuggestionRow[] => {
    if (!open || spec === undefined) return NO_ROWS;

    if (samples.current.lookup !== lookup || samples.current.spec !== spec) {
      samples.current = { lookup, spec, values: new Map() };
    }
    const cached = samples.current.values;

    return ordered.map((option, index) => {
      const id = `${option.kind}|${prefix}|${option.insert}`;
      let sample: string | undefined;

      if (lookup !== undefined) {
        sample = cached.get(id);
        if (sample === undefined) {
          sample = suggestionSample(surface, spec, option, lookup, { prefix });
          cached.set(id, sample);
        }
      }

      return {
        id,
        index,
        token: option.token,
        label: option.description === '' ? option.label : option.description,
        sample,
      };
    });
  }, [open, spec, ordered, lookup, surface, prefix]);

  const groups = useMemo((): readonly SuggestionRowGroup[] => {
    if (rows.length === 0) return NO_GROUPS;

    let at = 0;
    return grouped.map((group) => {
      const slice = rows.slice(at, at + group.options.length);
      at += group.options.length;
      return { label: group.label, rows: slice };
    });
  }, [grouped, rows]);

  const active = Math.min(typing.active, Math.max(0, rows.length - 1));

  const detail = useMemo(() => {
    const option = ordered[active];
    return open && option !== undefined && spec !== undefined
      ? suggestionDetail(option, spec)
      : NO_DETAIL;
  }, [open, ordered, active, spec]);

  const latest = useRef({ open, ordered, rows, active, onChange });
  useIsomorphicLayoutEffect(() => {
    latest.current = { open, ordered, rows, active, onChange };
  });

  const read = useCallback((node: PlaceholderElement) => {
    if (composing.current) return;

    const next = fragmentOf(node);
    const multiline = node.tagName === 'TEXTAREA';
    const focused = node.ownerDocument.activeElement === node;
    const text = node.value;
    const pending = focused && next !== null ? pendingSpan(text, next) : null;

    setTyping((current) => {
      const dismissal = nextDismissal(current.dismissal, next);

      if (
        sameFragment(current.fragment, next) &&
        sameSpan(current.pending, pending) &&
        dismissal === current.dismissal &&
        multiline === current.multiline &&
        focused === current.focused &&
        text === current.text
      ) {
        return current;
      }

      const kept =
        current.fragment !== null &&
        next !== null &&
        current.fragment.kind === next.kind &&
        current.fragment.start === next.start &&
        current.fragment.query === next.query;

      return {
        fragment: next,
        pending,
        multiline,
        active: kept ? current.active : 0,
        dismissal,
        focused,
        text,
      };
    });
  }, []);

  // A controlled field can change without an input event (Reset, a draft reloading underneath).
  useIsomorphicLayoutEffect(() => {
    const node = element.current;
    if (node !== null) read(node);
  });

  const highlight = useCallback((index: number) => {
    latest.current.active = index;
    setTyping((current) => (current.active === index ? current : { ...current, active: index }));
  }, []);

  const choose = useCallback(
    (index: number) => {
      const node = element.current;
      const option = latest.current.ordered[index];
      if (node === null || option === undefined) return;

      if (node.ownerDocument.activeElement !== node) node.focus({ preventScroll: true });

      const before = node.value;
      const current = fragmentOf(node);
      const replacement =
        current === null ? null : suggestionReplacement(before, current, option, node.maxLength);
      if (replacement === null) return;

      node.setSelectionRange(replacement.start, replacement.end);
      if (!insertText(replacement.text) || node.value === before) {
        node.setRangeText(replacement.text, replacement.start, replacement.end, 'end');
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
      if (action === undefined || !interceptsKey(action, shown.length)) return;

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
      const compose = (): void => {
        composing.current = true;
      };
      const composed = (): void => {
        composing.current = false;
        read(node);
      };
      const blur = (): void =>
        setTyping((current) =>
          current.fragment === null && !current.focused && current.pending === null
            ? current
            : { ...current, fragment: null, pending: null, active: 0, focused: false },
        );

      for (const name of READS) node.addEventListener(name, sync);
      node.addEventListener('focus', sync);
      node.addEventListener('blur', blur);
      node.addEventListener('keydown', key);
      node.addEventListener('compositionstart', compose);
      node.addEventListener('compositionend', composed);
      sync();

      return () => {
        for (const name of READS) node.removeEventListener(name, sync);
        node.removeEventListener('focus', sync);
        node.removeEventListener('blur', blur);
        node.removeEventListener('keydown', key);
        node.removeEventListener('compositionstart', compose);
        node.removeEventListener('compositionend', composed);
        if (element.current === node) element.current = null;
      };
    },
    [read, keydown],
  );

  const listed = open && rows.length > 0;
  const empty = typing.text === '';

  const field = useMemo(
    (): PlaceholderFieldProps => ({
      ref,
      ...fieldAria({ multiline: typing.multiline, open: listed, listId, active }),
      'aria-description': empty ? PLACEHOLDER_HINT : undefined,
    }),
    [ref, typing.multiline, listed, listId, active, empty],
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
    kind,
    listId,
    label:
      kind === 'modifier'
        ? `Modifiers for ${fragment?.key ?? 'this placeholder'}`
        : `Placeholders for ${spec.label.toLowerCase()}`,
    groups,
    rows,
    active,
    detail,
    fragment,
    pending: typing.pending,
    hint: typing.focused && typing.text === '' && !open,
    text: typing.text,
    element,
    choose,
    highlight,
  };
}
