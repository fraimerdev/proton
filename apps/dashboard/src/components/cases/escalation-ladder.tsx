import { MAX_TIMEOUT_MS } from '@proton/core';
import {
  ESCALATION_ACTIONS,
  type EscalationAction,
  type EscalationRung,
  escalationLadderSchema,
} from '@proton/module-cases';
import type { CSSProperties, ReactElement } from 'react';
import { useId } from 'react';
import { DurationControl } from '../form/fields.tsx';

// Discord refuses a timeout past 28 days, so the control refuses it here rather than letting the
// save come back with it.
const TIMEOUT_BOUNDS = { maxSeconds: MAX_TIMEOUT_MS / 1000 };

export interface EscalationLadderEditorProps {
  rungs: readonly EscalationRung[];
  onChange: (rungs: EscalationRung[]) => void;
}

const ACTION_LABELS: Record<EscalationAction, string> = {
  timeout: 'Timeout',
  kick: 'Kick',
  ban: 'Ban',
};

export function EscalationLadderEditor({
  rungs,
  onChange,
}: EscalationLadderEditorProps): ReactElement {
  const parsed = escalationLadderSchema.safeParse(rungs);
  const baseId = useId();

  function update(index: number, patch: Partial<EscalationRung>): void {
    onChange(
      rungs.map((rung, i) => {
        if (i !== index) return rung;

        const next = { ...rung, ...patch };

        if (next.action === 'kick') delete next.duration;
        return next;
      }),
    );
  }

  function add(): void {
    const highest = rungs.reduce((max, rung) => Math.max(max, rung.atWarnings), 1);

    onChange([...rungs, { atWarnings: highest + 1, action: 'timeout', duration: '1h' }]);
  }

  return (
    <div className="ladder" data-path="escalationLadder">
      <p className="field-description">
        When a member reaches a rung’s warning count inside the escalation window, Proton takes that
        action. Counts must increase down the ladder.
      </p>

      {rungs.map((rung, index) => (
        <div
          className="ladder-rung"
          // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own row
          key={`rung-${index}`}
          style={{ '--rung': index } as CSSProperties}
        >
          {/* The rows are identical otherwise, so the one thing the ladder is for — consequence
              climbing — was legible only by reading every warning count in order. Tone carries the
              severity, never alone: the action's own name is in the select beside it. */}
          <span className="ladder-step" data-action={rung.action} aria-hidden="true">
            {index + 1}
          </span>

          <label className="filter">
            <span>At warning</span>
            <input
              type="number"
              min={2}
              max={100}
              value={rung.atWarnings}
              onChange={(e) =>
                update(index, {
                  atWarnings: e.target.value === '' ? 0 : e.target.valueAsNumber,
                })
              }
            />
          </label>

          <label className="filter">
            <span>Action</span>
            <select
              value={rung.action}
              onChange={(e) => update(index, { action: e.target.value as EscalationAction })}
            >
              {ESCALATION_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABELS[action]}
                </option>
              ))}
            </select>
          </label>

          {rung.action === 'kick' ? (
            <span className="field-description ladder-rung-note">A kick cannot be timed.</span>
          ) : (
            // A duration is four characters. Left to grow with the rung it took a third of the
            // row, which put the action it qualifies in the middle of a line instead of at its end.
            // Not a <label>: the control is an amount and a unit, and one label over two of them
            // names neither.
            <span className="filter filter-brief">
              <label htmlFor={`${baseId}-for-${index}`}>
                {rung.action === 'timeout' ? 'For' : 'For (blank = permanent)'}
              </label>
              <DurationControl
                controlId={`${baseId}-for-${index}`}
                value={rung.duration ?? ''}
                onChange={(next) => update(index, { duration: next })}
                label={`Duration at ${rung.atWarnings} warnings`}
                bounds={rung.action === 'timeout' ? TIMEOUT_BOUNDS : undefined}
              />
            </span>
          )}

          <button
            type="button"
            className="button button-quiet"
            aria-label={`Remove rung at ${rung.atWarnings} warnings`}
            onClick={() => onChange(rungs.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}

      {rungs.length === 0 ? (
        <p className="field-empty">
          No rungs. Warnings are still recorded as cases; nothing escalates automatically.
        </p>
      ) : null}

      <button
        type="button"
        className="button button-quiet"
        onClick={add}
        disabled={rungs.length >= 20}
      >
        {rungs.length >= 20 ? 'Limit of 20 rungs reached' : 'Add rung'}
      </button>

      {parsed.success ? null : (
        <ul className="ladder-errors" role="alert">
          {parsed.error.issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
              {issue.path.length > 0 ? `Rung ${Number(issue.path[0]) + 1}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
