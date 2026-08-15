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

/**
 * Bespoke editor for the warn-escalation ladder.
 *
 * PLAN.md §9 caps the form generator at scalars, one level of nesting and flat
 * arrays, and rules out widening it until it half-renders a rule builder. The
 * ladder is an array of objects, so it sits outside that vocabulary by design —
 * `zodToDescriptors(casesConfigSchema)` still throws, and the cases module's
 * `formSchema` omits this field precisely so a hand-written editor can own it.
 *
 * Validation is the module's own `escalationLadderSchema`, not a re-statement of
 * it, so what this refuses and what a save refuses cannot drift apart.
 */
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
        // A kick cannot expire — there is no reversal for it (`REVERSAL_OF`), so
        // a duration left behind from a previous choice would be config that
        // reads as a temp-kick and silently does nothing.
        if (next.action === 'kick') delete next.duration;
        return next;
      }),
    );
  }

  function add(): void {
    const highest = rungs.reduce((max, rung) => Math.max(max, rung.atWarnings), 1);
    // Defaults to the mildest rung: anything irreversible has to be chosen
    // deliberately (PLAN.md §15 — Proton is itself an attack vector).
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
          // Index keys: `atWarnings` is the natural id but it is the value being
          // edited, so keying on it would remount the input mid-keystroke.
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
            <span className="field-description">A kick cannot be timed.</span>
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

      {/* The module's own message, verbatim — the admin reads here exactly what
          the save would have told them. */}
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
