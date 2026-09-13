import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  Ref,
  RefObject,
  TextareaHTMLAttributes,
} from 'react';
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './icon.tsx';
import { Popover } from './overlay.tsx';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type IndicatorWrite = () => HTMLElement | null;
type IndicatorMeasure = () => IndicatorWrite | null;

const pendingIndicators = new Set<IndicatorMeasure>();

function flushIndicators(): void {
  const measures = Array.from(pendingIndicators);
  pendingIndicators.clear();

  const writes = measures.map((measure) => measure());
  const jumped: HTMLElement[] = [];
  for (const write of writes) {
    const mark = write?.();
    if (mark) jumped.push(mark);
  }

  // Restyles while transitions are off; restoring them first would animate the jump anyway.
  for (const mark of jumped) void getComputedStyle(mark).transitionProperty;
  for (const mark of jumped) mark.style.transition = '';
}

function scheduleIndicator(measure: IndicatorMeasure): void {
  if (pendingIndicators.size === 0) queueMicrotask(flushIndicators);
  pendingIndicators.add(measure);
}

export function useSlidingIndicator<T extends HTMLElement>(
  index: number,
  layout: string,
): { track: RefObject<T | null>; indicator: RefObject<HTMLSpanElement | null> } {
  const track = useRef<T>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const placed = useRef('');

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new option list is the trigger to re-observe, not an input
  useLayoutEffect(() => {
    const container = track.current;
    const mark = indicator.current;
    if (!container || !mark) return;

    const items = Array.from(container.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child !== mark,
    );
    const selected = items[index];
    if (!selected) {
      placed.current = '';
      container.removeAttribute('data-indicator');
      return;
    }

    let first = true;
    const measure: IndicatorMeasure = () => {
      const glide = first;
      first = false;

      const width = Number.parseFloat(getComputedStyle(container).width);
      const box = container.getBoundingClientRect();
      if (!(width > 0) || box.width === 0) return null;
      // Rects, not offsetLeft: offsets round to whole pixels, and this ratio undoes a scaling dialog.
      const scale = box.width / width;
      const rect = selected.getBoundingClientRect();
      const x = (rect.left - box.left) / scale - container.clientLeft + container.scrollLeft;
      const y = (rect.top - box.top) / scale - container.clientTop + container.scrollTop;
      const w = rect.width / scale;
      const h = rect.height / scale;
      const next = [x, y, w, h].map((value) => value.toFixed(2)).join(' ');
      if (next === placed.current && container.hasAttribute('data-indicator')) return null;

      return () => {
        const jump = !glide && placed.current !== '';
        placed.current = next;
        if (jump) mark.style.transition = 'none';
        mark.style.setProperty('--indicator-x', `${x}px`);
        mark.style.setProperty('--indicator-y', `${y}px`);
        mark.style.setProperty('--indicator-width', `${w}px`);
        mark.style.setProperty('--indicator-height', `${h}px`);
        container.setAttribute('data-indicator', '');
        return jump ? mark : null;
      };
    };

    scheduleIndicator(measure);
    const observer = new ResizeObserver(() => scheduleIndicator(measure));
    observer.observe(container);
    for (const item of items) observer.observe(item);
    return () => {
      pendingIndicators.delete(measure);
      observer.disconnect();
    };
  }, [index, layout]);

  return { track, indicator };
}

/* -------------------------------------------------------------------- button */

type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-quiet';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  tone?: ButtonTone;
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName | undefined;
  trailingIcon?: IconName | undefined;
  busy?: boolean | undefined;
  block?: boolean | undefined;
  className?: string | undefined;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  tone = 'secondary',
  size = 'md',
  icon,
  trailingIcon,
  busy = false,
  block = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      disabled={disabled === true || busy}
      className={cx(
        'button',
        `button-${tone}`,
        size !== 'md' && `button-${size}`,
        children === undefined && 'button-icon',
        block && 'button-block',
        className,
      )}
      {...rest}
    >
      {busy ? (
        <Icon name="circle-notch" size={15} className="button-spin" />
      ) : icon ? (
        <Icon name={icon} size={15} className={icon === 'plus' ? 'button-plus' : undefined} />
      ) : null}
      {children}
      {trailingIcon ? <Icon name={trailingIcon} size={15} className="button-trailing" /> : null}
    </button>
  );
}

interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon'> {
  icon: IconName;
  label: string;
}

export function IconButton({ icon, label, ...rest }: IconButtonProps): ReactElement {
  return (
    <Button aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={15} />
    </Button>
  );
}

/* -------------------------------------------------------------------- switch */

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  label: string;
  describedBy?: string | undefined;
}

export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  describedBy,
}: SwitchProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      className="switch"
      onClick={() => onChange(!checked)}
    />
  );
}

/* ------------------------------------------------------------------ checkbox */

interface CheckboxProps {
  checked: boolean | 'mixed';
  onChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  label: string;
}

export function Checkbox({ checked, onChange, disabled, label }: CheckboxProps): ReactElement {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled === true}
      className="checkbox"
      onClick={() => onChange(checked !== true)}
    >
      <Icon name={checked === 'mixed' ? 'minus' : 'check'} size={12} weight="fill" />
    </button>
  );
}

/* --------------------------------------------------------------------- input */

interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size'> {
  invalid?: boolean | undefined;
  width?: 'xs' | 'sm' | 'md' | 'lg' | 'full' | undefined;
  className?: string | undefined;
  ref?: Ref<HTMLInputElement>;
}

export function TextInput({ invalid, width, className, ...rest }: TextInputProps): ReactElement {
  return (
    <input
      className={cx('input', width && width !== 'full' && `control-w-${width}`, className)}
      aria-invalid={invalid === true ? true : undefined}
      {...rest}
    />
  );
}

interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  invalid?: boolean | undefined;
  className?: string | undefined;
  ref?: Ref<HTMLTextAreaElement>;
}

export function TextArea({ invalid, className, ...rest }: TextAreaProps): ReactElement {
  return (
    <textarea
      className={cx('textarea', className)}
      aria-invalid={invalid === true ? true : undefined}
      {...rest}
    />
  );
}

/* ------------------------------------------------------------------- stepper */

interface NumberStepperProps {
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  unit?: string | undefined;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  label: string;
  width?: number | undefined;
}

export function NumberStepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  disabled = false,
  invalid = false,
  label,
  width = 116,
}: NumberStepperProps): ReactElement {
  const clamp = (next: number): number => {
    const low = min === undefined ? next : Math.max(min, next);
    return max === undefined ? low : Math.min(max, low);
  };

  const nudge = (delta: number): void => onChange(clamp((value ?? min ?? 0) + delta));

  const atMin = min !== undefined && value !== null && value <= min;
  const atMax = max !== undefined && value !== null && value >= max;

  return (
    <div className="stepper" style={{ width }} data-invalid={invalid ? 'true' : undefined}>
      <input
        className="input"
        type="number"
        inputMode="numeric"
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          onChange(raw === '' ? null : Number(raw));
        }}
        onBlur={(event) => {
          const raw = event.currentTarget.value;
          if (raw !== '') onChange(clamp(Number(raw)));
        }}
      />
      {unit ? (
        <span className="field-unit" style={{ paddingRight: 8 }}>
          {unit}
        </span>
      ) : null}
      <div className="stepper-buttons">
        <button
          type="button"
          className="stepper-button"
          tabIndex={-1}
          aria-hidden
          disabled={disabled || atMax}
          onClick={() => nudge(step)}
        >
          <Icon name="caret-up" size={11} weight="fill" />
        </button>
        <button
          type="button"
          className="stepper-button"
          tabIndex={-1}
          aria-hidden
          disabled={disabled || atMin}
          onClick={() => nudge(-step)}
        >
          <Icon name="caret-down" size={11} weight="fill" />
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- select */

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean | undefined;
  group?: string | undefined;
}

interface SelectProps {
  options: readonly SelectOption[];
  value: string | undefined;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
  width?: 'xs' | 'sm' | 'md' | 'lg' | 'full' | undefined;
  className?: string | undefined;
  id?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
}

function enabledOptions(list: HTMLElement | null): HTMLButtonElement[] {
  return [...(list?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
}

function optionFor(items: HTMLButtonElement[], key: string): HTMLButtonElement | undefined {
  const current = items.indexOf(document.activeElement as HTMLButtonElement);

  if (key === 'ArrowDown') return items[Math.min(items.length - 1, current + 1)];
  if (key === 'ArrowUp') return items[Math.max(0, current - 1)];
  if (key === 'Home') return items[0];
  if (key === 'End') return items[items.length - 1];
  if (key.length !== 1 || key.trim() === '') return undefined;

  const needle = key.toLowerCase();
  return [...items.slice(current + 1), ...items.slice(0, current + 1)].find((item) =>
    item.textContent?.trim().toLowerCase().startsWith(needle),
  );
}

export function Select({
  options,
  value,
  onChange,
  placeholder,
  invalid,
  disabled,
  width,
  className,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
}: SelectProps): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [minWidth, setMinWidth] = useState<number | undefined>(undefined);

  const current = value ?? '';
  const selected = options.find((option) => option.value === current);

  const show = (): void => {
    setMinWidth(anchor.current?.offsetWidth);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;

    const items = enabledOptions(list.current);
    const target = items.find((item) => item.getAttribute('aria-selected') === 'true') ?? items[0];
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        id={id}
        className={cx(
          'select-trigger',
          width && width !== 'full' && `control-w-${width}`,
          className,
        )}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid === true ? true : undefined}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          show();
        }}
      >
        <span className={cx('select-value', selected === undefined && 'select-placeholder')}>
          {selected?.label ?? placeholder}
        </span>
        <Icon name="caret-down" size={12} weight="fill" className="select-chevron" />
      </button>

      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={minWidth}
        maxWidth={360}
      >
        <div
          ref={list}
          className="popover-scroll"
          role="listbox"
          aria-label={ariaLabel}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              event.preventDefault();
              setOpen(false);
              return;
            }

            const target = optionFor(enabledOptions(list.current), event.key);
            if (!target) return;
            event.preventDefault();
            target.focus();
          }}
        >
          {options.length === 0 ? <p className="picker-note">Nothing to choose from</p> : null}
          {options.map((option, index) => (
            <Fragment key={option.value}>
              {option.group !== undefined && option.group !== options[index - 1]?.group ? (
                <p className="menu-label">{option.group}</p>
              ) : null}
              <button
                type="button"
                role="option"
                aria-selected={option.value === current}
                disabled={option.disabled === true}
                className="menu-item select-option"
                onClick={() => {
                  setOpen(false);
                  if (option.value !== current) onChange(option.value);
                }}
              >
                <span className="truncate">{option.label}</span>
                {option.value === current ? (
                  <Icon name="check" size={14} weight="fill" className="menu-item-check" />
                ) : null}
              </button>
            </Fragment>
          ))}
        </div>
      </Popover>
    </>
  );
}

/* ---------------------------------------------------------------- segmented */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName | undefined;
  /** Colours the selected end of a scale: 'off' stays neutral, 'warning'/'danger' escalate. */
  tone?: 'off' | 'warning' | 'danger' | undefined;
  disabled?: boolean | undefined;
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  /** Paints a toned selected option in its tone rather than a neutral raised surface. */
  accent?: boolean | undefined;
  block?: boolean | undefined;
  disabled?: boolean | undefined;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  accent = false,
  block = false,
  disabled = false,
}: SegmentedControlProps<T>): ReactElement {
  const index = options.findIndex((option) => option.value === value);
  const selected = options[index];
  const { track, indicator } = useSlidingIndicator<HTMLDivElement>(
    index,
    options.map((option) => option.value).join(' '),
  );

  return (
    <div
      ref={track}
      role="radiogroup"
      aria-label={label}
      className={cx('segmented', accent && 'accent', block && 'block')}
    >
      <span
        ref={indicator}
        className="segmented-thumb"
        aria-hidden
        data-tone={selected?.tone}
        data-disabled={disabled || selected?.disabled === true ? true : undefined}
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          data-tone={option.tone}
          disabled={disabled || option.disabled === true}
          className="segmented-option"
          onClick={() => onChange(option.value)}
        >
          {option.icon ? <Icon name={option.icon} size={14} /> : null}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- search field */

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  label?: string | undefined;
  autoFocus?: boolean | undefined;
  className?: string | undefined;
  ref?: Ref<HTMLInputElement>;
  onKeyDown?: InputHTMLAttributes<HTMLInputElement>['onKeyDown'];
}

export function SearchField({
  value,
  onChange,
  placeholder = 'Search…',
  label,
  autoFocus,
  className,
  ref,
  onKeyDown,
}: SearchFieldProps): ReactElement {
  return (
    <div className={cx('search-field', className)}>
      <Icon name="magnifying-glass" size={15} className="search-field-icon" />
      <input
        ref={ref}
        type="search"
        className="input"
        value={value}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        // biome-ignore lint/a11y/noAutofocus: only ever set inside a popover the user just opened
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      {value !== '' ? (
        <button
          type="button"
          className="search-field-clear"
          aria-label="Clear search"
          onClick={() => onChange('')}
        >
          <Icon name="x" size={12} weight="fill" />
        </button>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- chip/badge */

interface ChipProps {
  children: ReactNode;
  onRemove?: (() => void) | undefined;
  removeLabel?: string | undefined;
  colour?: string | undefined;
  className?: string | undefined;
}

export function Chip({
  children,
  onRemove,
  removeLabel = 'Remove',
  colour,
  className,
}: ChipProps): ReactElement {
  return (
    <span className={cx('chip', className)}>
      {colour ? <span className="chip-dot" style={{ background: colour }} /> : null}
      <span className="truncate">{children}</span>
      {onRemove ? (
        <button type="button" className="chip-remove" aria-label={removeLabel} onClick={onRemove}>
          <Icon name="x" size={10} weight="fill" />
        </button>
      ) : null}
    </span>
  );
}

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'primary';

export function Badge({
  tone = 'neutral',
  icon,
  children,
}: {
  tone?: BadgeTone;
  icon?: IconName | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <span className={`badge badge-${tone}`}>
      {icon ? <Icon name={icon} size={11} weight="fill" /> : null}
      {children}
    </span>
  );
}

/* --------------------------------------------------------------------- field */

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: (props: { id: string; 'aria-describedby': string | undefined }) => ReactNode;
}

/** A labelled control for dialogs and detail editors, where the row layout does not apply. */
export function Field({ label, hint, error, children }: FieldProps): ReactElement {
  const id = useId();
  const hintId = hint !== undefined || error !== undefined ? `${id}-hint` : undefined;

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children({ id, 'aria-describedby': hintId })}
      {error !== undefined ? (
        <span className="field-error" id={hintId}>
          {error}
        </span>
      ) : hint !== undefined ? (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
