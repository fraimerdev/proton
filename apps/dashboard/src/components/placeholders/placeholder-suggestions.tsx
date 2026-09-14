import type { CSSProperties, ReactElement, Ref, SyntheticEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  optionId,
  placeSuggestions,
  SUGGESTION_LIST_MAX,
  type SuggestionAnchor,
  type SuggestionPlacement,
  suggestionAnnouncement,
} from './autocomplete.ts';
import type {
  PlaceholderAutocomplete,
  PlaceholderElement,
  SuggestionRow,
} from './use-placeholder-autocomplete.ts';

const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

const OFFSCREEN: SuggestionPlacement = {
  top: -9999,
  left: -9999,
  width: undefined,
  maxHeight: SUGGESTION_LIST_MAX,
};

const EMPTY_SAMPLE = 'Empty in the sample';

const MIRRORED = [
  'direction',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textIndent',
  'textTransform',
  'tabSize',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'wordBreak',
  'overflowWrap',
] as const;

export interface SuggestionListProps {
  id: string;
  label: string;
  rows: readonly SuggestionRow[];
  active: number;
  onChoose: (index: number) => void;
  onHighlight: (index: number) => void;
  style?: CSSProperties | undefined;
  ref?: Ref<HTMLDivElement> | undefined;
}

function keepFocus(event: SyntheticEvent): void {
  event.preventDefault();
}

export function SuggestionList({
  id,
  label,
  rows,
  active,
  onChoose,
  onHighlight,
  style,
  ref,
}: SuggestionListProps): ReactElement {
  return (
    <div
      ref={ref}
      id={id}
      role="listbox"
      aria-label={label}
      className="placeholder-suggestions"
      style={style}
    >
      {rows.map((row, index) => (
        <button
          key={row.key}
          id={optionId(id, index)}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={index === active}
          className="placeholder-suggestion"
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onPointerMove={() => {
            if (index !== active) onHighlight(index);
          }}
          onClick={() => onChoose(index)}
        >
          <span className="placeholder-suggestion-token mono">{`{${row.key}}`}</span>
          {row.sample === undefined ? null : (
            <span className="placeholder-suggestion-sample">
              {row.sample === '' ? EMPTY_SAMPLE : row.sample}
            </span>
          )}
          <span className="placeholder-suggestion-label">{row.label}</span>
        </button>
      ))}
    </div>
  );
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function textareaLine(
  node: HTMLTextAreaElement,
  start: number,
  caret: number,
): { top: number; bottom: number; left: number } {
  const style = getComputedStyle(node);
  const mirror = document.createElement('div');

  for (const property of MIRRORED) mirror.style[property] = style[property];

  const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  Object.assign(mirror.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    visibility: 'hidden',
    overflow: 'hidden',
    boxSizing: 'content-box',
    border: '0',
    whiteSpace: 'pre-wrap',
    width: `${Math.max(0, node.clientWidth - (padding || 0))}px`,
  });

  const brace = document.createElement('span');
  brace.textContent = '{';
  const marker = document.createElement('span');
  marker.textContent = '​';

  mirror.append(node.value.slice(0, start), brace, node.value.slice(start + 1, caret), marker);
  document.body.append(mirror);

  const top = (Number.parseFloat(style.borderTopWidth) || 0) + marker.offsetTop - node.scrollTop;
  const line = {
    top,
    bottom: top + marker.offsetHeight,
    left: (Number.parseFloat(style.borderLeftWidth) || 0) + brace.offsetLeft - node.scrollLeft,
  };

  mirror.remove();
  return line;
}

function anchorFor(node: PlaceholderElement, start: number, caret: number): SuggestionAnchor {
  const rect = node.getBoundingClientRect();
  const field = { fieldLeft: rect.left, fieldWidth: rect.width };

  if (!(node instanceof HTMLTextAreaElement)) {
    return { top: rect.top, bottom: rect.bottom, left: rect.left, ...field };
  }

  const line = textareaLine(node, start, caret);

  return {
    top: clamp(rect.top + line.top, rect.top, rect.bottom),
    bottom: clamp(rect.top + line.bottom, rect.top, rect.bottom),
    left: clamp(rect.left + line.left, rect.left, rect.right),
    ...field,
  };
}

function FloatingSuggestions({
  autocomplete,
}: {
  autocomplete: PlaceholderAutocomplete;
}): ReactElement {
  const panel = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<SuggestionPlacement>(OFFSCREEN);

  const { element, fragment, rows, active, listId, label, choose, highlight } = autocomplete;
  const start = fragment?.start;
  const caret = fragment?.caret;

  const place = useCallback(() => {
    const node = element.current;
    const list = panel.current;
    if (node === null || list === null || start === undefined || caret === undefined) return;

    const viewport = document.documentElement;
    const next = placeSuggestions(
      anchorFor(node, start, caret),
      { width: list.offsetWidth, height: list.scrollHeight },
      { width: viewport.clientWidth, height: viewport.clientHeight },
    );

    setPlacement((current) =>
      current.top === next.top &&
      current.left === next.left &&
      current.width === next.width &&
      current.maxHeight === next.maxHeight
        ? current
        : next,
    );
  }, [element, start, caret]);

  useIsomorphicLayoutEffect(() => {
    place();
  }, [place, rows]);

  useEffect(() => {
    const follow = (event: Event): void => {
      if (event.target !== panel.current) place();
    };

    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);

    return () => {
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [place]);

  useEffect(() => {
    const list = panel.current;
    const row = document.getElementById(optionId(listId, active));
    if (list === null || row === null) return;

    if (row.offsetTop < list.scrollTop) {
      list.scrollTop = row.offsetTop;
    } else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }, [listId, active]);

  return (
    <SuggestionList
      ref={panel}
      id={listId}
      label={label}
      rows={rows}
      active={active}
      onChoose={choose}
      onHighlight={highlight}
      style={{
        top: placement.top,
        left: placement.left,
        width: placement.width,
        maxHeight: placement.maxHeight,
      }}
    />
  );
}

export function PlaceholderSuggestions({
  autocomplete,
}: {
  autocomplete: PlaceholderAutocomplete;
}): ReactElement {
  const { open, rows } = autocomplete;

  return (
    <>
      <span className="visually-hidden" aria-live="polite">
        {open ? suggestionAnnouncement(rows.length) : ''}
      </span>
      {open && typeof document !== 'undefined'
        ? createPortal(<FloatingSuggestions autocomplete={autocomplete} />, document.body)
        : null}
    </>
  );
}
