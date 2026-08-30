import { type EntitlementTier, newId } from '@proton/core';
import { COUNTER_SOURCES, type Counter, countersListSchema } from '@proton/module-counters/config';
import type { ReactElement } from 'react';
import { useId } from 'react';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import { channelOptions, type DiscordChannel, SinglePicker } from '../form/picker.tsx';

export interface CountersEditorProps {
  counters: readonly Counter[];
  channels: readonly DiscordChannel[];
  tier: EntitlementTier;
  onChange: (counters: Counter[]) => void;
}

const SOURCE_LABELS: Record<(typeof COUNTER_SOURCES)[number], string> = {
  members: 'Members in the server',
  roles: 'Roles in the server',
  channels: 'Channels in the server',
};

function blank(): Counter {
  return { id: newId(), template: 'Members: {count}', source: 'members' };
}

// No channel means Proton makes one and owns it from then on, which is what the id is filed under
// — so the id survives the switch and the same channel is picked back up.
function withMode(counter: Counter, mode: 'proton' | 'existing'): Counter {
  const { channelId: _dropped, ...rest } = counter;

  return mode === 'proton' ? rest : { ...rest, channelId: '' };
}

export function CountersEditor({
  counters,
  channels,
  tier,
  onChange,
}: CountersEditorProps): ReactElement {
  const id = useId();
  const ceiling = listCeiling(tier, 'counters');
  const options = channelOptions(channels);
  const parsed = countersListSchema.safeParse(counters);

  function update(index: number, patch: Partial<Counter>): void {
    onChange(counters.map((counter, i) => (i === index ? { ...counter, ...patch } : counter)));
  }

  function replace(index: number, next: Counter): void {
    onChange(counters.map((counter, i) => (i === index ? next : counter)));
  }

  return (
    <div className="ladder" data-path="counters">
      <p className="field-description">
        Proton makes each counter its own voice channel, locked so nobody can join it, at the top of
        the channel list — it appears shortly after you save. Point one at a channel you already
        have instead if you would rather. Either way the number is refreshed every ten minutes, and
        that interval is fixed.
      </p>

      {counters.map((counter, index) => {
        // A wrapping label would forward option clicks to the trigger and reopen it.
        const channelControlId = `${id}-channel-${index}`;

        return (
          <div
            className="ladder-rung"
            // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own row
            key={`counter-${index}`}
          >
            <label className="filter">
              <span>Channel</span>
              <select
                value={counter.channelId === undefined ? 'proton' : 'existing'}
                onChange={(e) =>
                  replace(index, withMode(counter, e.target.value as 'proton' | 'existing'))
                }
              >
                <option value="proton">Proton makes it</option>
                <option value="existing">One I already have</option>
              </select>
            </label>

            {counter.channelId === undefined ? null : (
              <div className="filter">
                <span>
                  <label htmlFor={channelControlId}>Which</label>
                </span>
                <SinglePicker
                  id={channelControlId}
                  label="Which"
                  options={options}
                  value={counter.channelId === '' ? null : counter.channelId}
                  onChange={(next) => update(index, { channelId: next ?? '' })}
                  emptyLabel="Choose a channel…"
                  clearable={false}
                  invalid={counter.channelId === ''}
                />
              </div>
            )}

            <label className="filter">
              <span>Named</span>
              <input
                type="text"
                value={counter.template}
                aria-invalid={!counter.template.includes('{count}')}
                onChange={(e) => update(index, { template: e.target.value })}
              />
            </label>

            <label className="filter">
              <span>Counting</span>
              <select
                value={counter.source}
                onChange={(e) => update(index, { source: e.target.value as Counter['source'] })}
              >
                {COUNTER_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {SOURCE_LABELS[source]}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="button button-ghost"
              aria-label={`Remove counter ${index + 1}`}
              onClick={() => onChange(counters.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
        );
      })}

      {counters.length === 0 ? (
        <p className="field-empty">
          No counters. Nothing is made or renamed until one is added here.
        </p>
      ) : null}

      <button
        type="button"
        className="button button-quiet"
        onClick={() => onChange([...counters, blank()])}
        disabled={counters.length >= ceiling}
      >
        {counters.length >= ceiling ? ceilingNote(tier, 'counters') : 'Add counter'}
      </button>

      {parsed.success ? null : (
        <ul className="ladder-errors" role="alert">
          {parsed.error.issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
              {issue.path.length > 0 ? `Counter ${Number(issue.path[0]) + 1}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
