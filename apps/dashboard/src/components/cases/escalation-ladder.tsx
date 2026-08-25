import { tryParseDuration } from '@proton/core';
import {
  ESCALATION_ACTIONS,
  type EscalationAction,
  type EscalationRung,
  escalationLadderSchema,
} from '@proton/module-cases';
import type { ReactElement } from 'react';

export interface EscalationLadderEditorProps {
  rungs: readonly EscalationRung[];
  onChange: (rungs: EscalationRung[]) => void;
}

export function EscalationLadderEditor({
  rungs,
  onChange,
}: EscalationLadderEditorProps): ReactElement {
  const parsed = escalationLadderSchema.safeParse(rungs);

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
        >
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
                  {action}
                </option>
              ))}
            </select>
          </label>

          {rung.action === 'kick' ? (
            <span className="field-description ladder-rung-note">A kick cannot be timed.</span>
          ) : (
            <label className="filter">
              <span>{rung.action === 'timeout' ? 'For' : 'For (blank = permanent)'}</span>
              <input
                type="text"
                placeholder="1h"
                value={rung.duration ?? ''}
                aria-invalid={
                  rung.duration !== undefined && tryParseDuration(rung.duration) === null
                }
                onChange={(e) =>
                  update(index, {
                    duration: e.target.value === '' ? undefined : e.target.value,
                  })
                }
              />
            </label>
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
