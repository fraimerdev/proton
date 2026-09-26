import type { CSSProperties, ReactElement, Ref, SyntheticEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHydrated } from '../ui/overlay.tsx';
import {
  emptyMessage,
  type FragmentKind,
  optionId,
  placeSuggestions,
  SUGGESTION_LIST_MAX,
  type SuggestionAnchor,
  type SuggestionPlacement,
  type SuggestionViewport,
  suggestionAnnouncement,
} from './autocomplete.ts';
import type {
  PlaceholderAutocomplete,
  PlaceholderElement,
  SuggestionRowGroup,
} from './use-placeholder-autocomplete.ts';

const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

const OFFSCREEN: SuggestionPlacement = {
  top: -9999,
  left: -9999,
  width: undefined,
  maxHeight: SUGGESTION_LIST_MAX,
};

const EMPTY_SAMPLE = 'Empty in the sample';

const HINT_GAP = 4;

const CLIPPING = /(auto|scroll|hidden|clip)/;

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
  kind: FragmentKind;
  groups: readonly SuggestionRowGroup[];
  active: number;
  detail: readonly string[];
  onChoose: (index: number) => void;
  onHighlight: (index: number) => void;
  hidden?: boolean | undefined;
  style?: CSSProperties | undefined;
  listRef?: Ref<HTMLDivElement> | undefined;
  ref?: Ref<HTMLDivElement> | undefined;
}

function keepFocus(event: SyntheticEvent): void {
  event.preventDefault();
}

export function SuggestionList({
  id,
  label,
  kind,
  groups,
  active,
  detail,
  onChoose,
  onHighlight,
  hidden = false,
  style,
  listRef,
  ref,
}: SuggestionListProps): ReactElement {
  const detailId = `${id}-detail`;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pressing the list must not move focus out of the field
    <div
      ref={ref}
      className="placeholder-suggestions"
      data-hidden={hidden ? '' : undefined}
      style={style}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
    >
      {groups.length === 0 ? (
        <p className="placeholder-suggestions-empty">{emptyMessage(kind)}</p>
      ) : (
        <>
          <div
            ref={listRef}
            id={id}
            role="listbox"
            aria-label={label}
            className="placeholder-suggestions-list"
          >
            {groups.map((group, at) => (
              // biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role=group, a fieldset groups form controls
              <div
                key={group.label}
                role="group"
                aria-labelledby={`${id}-group-${at}`}
                className="placeholder-suggestions-group"
              >
                <div
                  id={`${id}-group-${at}`}
                  role="presentation"
                  className="placeholder-suggestions-heading"
                >
                  {group.label}
                </div>
                {group.rows.map((row) => (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: keys stay in the field, which moves aria-activedescendant
                  <div
                    key={row.id}
                    id={optionId(id, row.index)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={row.index === active}
                    aria-describedby={
                      row.index === active && detail.length > 0 ? detailId : undefined
                    }
                    className="placeholder-suggestion"
                    onPointerMove={() => {
                      if (row.index !== active) onHighlight(row.index);
                    }}
                    onClick={() => onChoose(row.index)}
                  >
                    <span className="placeholder-suggestion-token mono">{row.token}</span>
                    {row.sample === undefined ? null : (
                      <span className="placeholder-suggestion-sample">
                        <span className="visually-hidden">Sample: </span>
                        {row.sample === '' ? EMPTY_SAMPLE : row.sample}
                      </span>
                    )}
                    <span className="placeholder-suggestion-label">{row.label}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {detail.length > 0 ? (
            <div id={detailId} className="placeholder-suggestions-detail">
              {detail.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          ) : null}
        </>
      )}
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
  brace.textContent = node.value.charAt(start) || '{';
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

function visibleViewport(): SuggestionViewport {
  const root = document.documentElement;
  const visual = window.visualViewport;

  return {
    width: root.clientWidth,
    height: visual === null ? root.clientHeight : Math.min(root.clientHeight, visual.height),
    top: visual === null ? 0 : visual.offsetTop,
  };
}

function clippedOut(node: Element, top: number, bottom: number): boolean {
  const middle = (top + bottom) / 2;

  for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
    if (parent === document.body || parent === document.documentElement) return false;

    const style = getComputedStyle(parent);
    if (!CLIPPING.test(`${style.overflowY} ${style.overflowX}`)) continue;

    const rect = parent.getBoundingClientRect();
    if (middle < rect.top || middle > rect.bottom) return true;
  }

  return false;
}

function useFollow(place: () => void): void {
  useEffect(() => {
    const follow = (): void => place();
    const visual = window.visualViewport;

    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    visual?.addEventListener('resize', follow);
    visual?.addEventListener('scroll', follow);

    return () => {
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
      visual?.removeEventListener('resize', follow);
      visual?.removeEventListener('scroll', follow);
    };
  }, [place]);
}

function FloatingSuggestions({
  autocomplete,
}: {
  autocomplete: PlaceholderAutocomplete;
}): ReactElement {
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<SuggestionPlacement>(OFFSCREEN);
  const [hidden, setHidden] = useState(false);

  const { element, fragment, groups, active, detail, listId, label, kind, choose, highlight } =
    autocomplete;
  const start = fragment?.start;
  const caret = fragment?.caret;

  const place = useCallback(() => {
    const node = element.current;
    const box = panel.current;
    if (node === null || box === null || start === undefined || caret === undefined) return;

    const anchor = anchorFor(node, start, caret);
    const next = placeSuggestions(
      anchor,
      { width: box.offsetWidth, height: box.scrollHeight },
      visibleViewport(),
    );

    setHidden(clippedOut(node, anchor.top, anchor.bottom));
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
  }, [place, groups, detail]);

  useFollow(place);

  useEffect(() => {
    const scroller = list.current;
    const row = document.getElementById(optionId(listId, active));
    if (scroller === null || row === null) return;

    if (row.offsetTop < scroller.scrollTop) {
      scroller.scrollTop = row.offsetTop;
    } else if (row.offsetTop + row.offsetHeight > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = row.offsetTop + row.offsetHeight - scroller.clientHeight;
    }
  }, [listId, active]);

  return (
    <SuggestionList
      ref={panel}
      listRef={list}
      id={listId}
      label={label}
      kind={kind}
      groups={groups}
      active={active}
      detail={detail}
      onChoose={choose}
      onHighlight={highlight}
      hidden={hidden}
      style={{
        top: placement.top,
        left: placement.left,
        width: placement.width,
        maxHeight: placement.maxHeight,
      }}
    />
  );
}

function FloatingHint({ autocomplete }: { autocomplete: PlaceholderAutocomplete }): ReactElement {
  const [spot, setSpot] = useState<{ top: number; left: number; hidden: boolean } | null>(null);
  const { element } = autocomplete;

  const place = useCallback(() => {
    const node = element.current;
    if (node === null) return;

    const rect = node.getBoundingClientRect();
    const top = rect.bottom + HINT_GAP;
    const next = { top, left: rect.left, hidden: clippedOut(node, rect.top, rect.bottom) };

    setSpot((current) =>
      current !== null &&
      current.top === next.top &&
      current.left === next.left &&
      current.hidden === next.hidden
        ? current
        : next,
    );
  }, [element]);

  useIsomorphicLayoutEffect(() => {
    place();
  }, [place]);

  useFollow(place);

  return (
    <div
      className="placeholder-hint"
      aria-hidden="true"
      data-hidden={spot === null || spot.hidden ? '' : undefined}
      style={spot === null ? { top: -9999, left: -9999 } : { top: spot.top, left: spot.left }}
    >
      Type <kbd>{'{'}</kbd> to insert a placeholder
    </div>
  );
}

export function PlaceholderSuggestions({
  autocomplete,
}: {
  autocomplete: PlaceholderAutocomplete;
}): ReactElement {
  const hydrated = useHydrated();
  const { open, rows, kind, hint } = autocomplete;

  return (
    <>
      <span className="visually-hidden" aria-live="polite">
        {open ? suggestionAnnouncement(rows.length, kind) : ''}
      </span>
      {hydrated && open
        ? createPortal(<FloatingSuggestions autocomplete={autocomplete} />, document.body)
        : null}
      {hydrated && hint
        ? createPortal(<FloatingHint autocomplete={autocomplete} />, document.body)
        : null}
    </>
  );
}
