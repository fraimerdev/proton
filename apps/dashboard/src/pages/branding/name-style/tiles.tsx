import type { ReactElement, ReactNode } from 'react';
import { useRef } from 'react';
import { cx } from '../../../components/ui/controls.tsx';
import { tileMove } from './shape.ts';

export function RadioTiles<T extends string | number>({
  labelledBy,
  options,
  value,
  onChange,
  columns = 1,
  className,
  tileClassName,
  label,
  disabled,
  note,
  children,
}: {
  labelledBy: string;
  options: readonly T[];
  value: T | null;
  onChange: (next: T) => void;
  columns?: number | undefined;
  className?: string | undefined;
  tileClassName?: string | undefined;
  label?: ((option: T) => string) | undefined;
  disabled?: ((option: T) => boolean) | undefined;
  note?: ((option: T) => string | undefined) | undefined;
  children: (option: T) => ReactNode;
}): ReactElement {
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);

  const blocked = (index: number): boolean => {
    const option = options[index];
    return option === undefined || disabled?.(option) === true;
  };

  const checked = value === null ? -1 : options.indexOf(value);
  const open = options.findIndex((_, index) => !blocked(index));
  const stop = checked === -1 ? Math.max(open, 0) : checked;

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className={className}>
      {options.map((option, index) => {
        const off = blocked(index);
        const hint = note?.(option);

        return (
          // biome-ignore lint/a11y/useSemanticElements: a native radio cannot hold a name drawn in its own face and effect
          <button
            key={option}
            ref={(node) => {
              tiles.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={index === checked}
            aria-disabled={off || undefined}
            aria-label={label?.(option)}
            tabIndex={index === stop ? 0 : -1}
            className={cx('name-style-tile', tileClassName)}
            onClick={() => {
              if (!off) onChange(option);
            }}
            onKeyDown={(event) => {
              const next = tileMove(index, event.key, options.length, columns, blocked);
              const target = next === null ? undefined : options[next];
              if (next === null || target === undefined) return;

              event.preventDefault();
              onChange(target);
              tiles.current[next]?.focus();
            }}
          >
            {children(option)}
            {hint !== undefined ? <span className="name-style-tile-note">{hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
