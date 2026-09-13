import { formatDuration, tryParseDuration } from '@proton/core';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { NumberStepper, Select, TextInput } from '../ui/controls.tsx';

/* ------------------------------------------------------------------ duration */

const UNITS = [
  { value: 's', label: 'seconds', ms: 1000 },
  { value: 'm', label: 'minutes', ms: 60_000 },
  { value: 'h', label: 'hours', ms: 3_600_000 },
  { value: 'd', label: 'days', ms: 86_400_000 },
  { value: 'w', label: 'weeks', ms: 604_800_000 },
] as const;

type Unit = (typeof UNITS)[number]['value'];

function split(value: string): { amount: number | null; unit: Unit } {
  const match = /^(\d+)\s*([smhdw])$/i.exec(value.trim());
  const amount = match?.[1];
  const unit = match?.[2]?.toLowerCase() as Unit | undefined;

  if (amount === undefined || unit === undefined) return { amount: null, unit: 'm' };
  return { amount: Number(amount), unit };
}

/**
 * Two human controls over Proton's duration string. An existing `30s` parses into 30 + seconds
 * rather than being shown as raw text, and every edit serialises back to the same format the
 * schema validates.
 */
export function DurationInput({
  value,
  onChange,
  min,
  max,
  disabled = false,
  invalid = false,
  label,
  units = UNITS.map((unit) => unit.value),
}: {
  value: string;
  onChange: (value: string) => void;
  /** Bounds in milliseconds, enforced across whichever unit is chosen. */
  min?: number | undefined;
  max?: number | undefined;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  label: string;
  units?: readonly Unit[] | undefined;
}): ReactElement {
  const parsed = useMemo(() => split(value), [value]);
  const [unit, setUnit] = useState<Unit>(parsed.unit);
  const [amount, setAmount] = useState<number | null>(parsed.amount);

  // A value replaced from outside — a reset, a different row selected — re-seeds both controls.
  useEffect(() => {
    setUnit(parsed.unit);
    setAmount(parsed.amount);
  }, [parsed.unit, parsed.amount]);

  const size = UNITS.find((candidate) => candidate.value === unit)?.ms ?? 60_000;

  const emit = (nextAmount: number | null, nextUnit: Unit): void => {
    if (nextAmount === null) return;
    onChange(`${nextAmount}${nextUnit}`);
  };

  const ceiling = max === undefined ? undefined : Math.floor(max / size);
  const floor = min === undefined ? undefined : Math.ceil(min / size);

  return (
    <span className="duration-input">
      <NumberStepper
        value={amount}
        min={Math.max(0, floor ?? 0)}
        max={ceiling}
        label={`${label} amount`}
        disabled={disabled}
        invalid={invalid}
        width={84}
        onChange={(next) => {
          setAmount(next);
          emit(next, unit);
        }}
      />
      <Select
        aria-label={`${label} unit`}
        className="control-w-sm"
        disabled={disabled}
        value={unit}
        options={UNITS.filter((candidate) => units.includes(candidate.value)).map((candidate) => ({
          value: candidate.value,
          label: candidate.label,
        }))}
        onChange={(value) => {
          const next = value as Unit;
          setUnit(next);
          emit(amount, next);
        }}
      />
    </span>
  );
}

export function humaniseDuration(value: string): string {
  const ms = tryParseDuration(value);
  if (ms === null) return value;

  const compact = formatDuration(ms);
  const unit = UNITS.find((candidate) => compact.endsWith(candidate.value));
  const amount = Number.parseInt(compact, 10);

  if (!unit || Number.isNaN(amount)) return value;
  return `${amount} ${amount === 1 ? unit.label.replace(/s$/, '') : unit.label}`;
}

/* -------------------------------------------------------------------- colour */

function toHex(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, value)).toString(16).padStart(6, '0').toUpperCase()}`;
}

const HEX = /^#?[0-9a-f]{6}$/i;

export const DEFAULT_EMBED_COLOUR = 0x2a8af7;

/**
 * Discord stores an embed colour as an integer; an admin thinks in hex. This shows the hex,
 * validates it as they type, and serialises the integer the schema expects.
 */
export function ColourPicker({
  value,
  onChange,
  disabled = false,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean | undefined;
  label: string;
}): ReactElement {
  const hex = toHex(value);
  const [text, setText] = useState(hex);

  useEffect(() => setText(toHex(value)), [value]);

  const invalid = !HEX.test(text);

  return (
    <span className="colour-input">
      <span
        className="colour-swatch"
        style={{ background: invalid ? hex : `#${text.replace('#', '')}` }}
      >
        <input
          type="color"
          value={hex}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onChange(Number.parseInt(event.currentTarget.value.slice(1), 16))}
        />
      </span>
      <TextInput
        value={text}
        disabled={disabled}
        invalid={invalid}
        aria-label={`${label} hex value`}
        spellCheck={false}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          if (HEX.test(next)) onChange(Number.parseInt(next.replace('#', ''), 16));
        }}
        onBlur={() => setText(toHex(value))}
      />
    </span>
  );
}
