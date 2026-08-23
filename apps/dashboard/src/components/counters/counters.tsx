import { COUNTER_SOURCES, type Counter, countersListSchema } from '@proton/module-counters/config';
import type { ReactElement } from 'react';
import { useId } from 'react';
import { channelOptions, type DiscordChannel, SinglePicker } from '../form/picker.tsx';

export interface CountersEditorProps {
  counters: readonly Counter[];
  channels: readonly DiscordChannel[];
  onChange: (counters: Counter[]) => void;
}

const MAX_SHOWN = 100;

const SOURCE_LABELS: Record<(typeof COUNTER_SOURCES)[number], string> = {
  members: 'Members in the server',
  roles: 'Roles in the server',
  channels: 'Channels in the server',
};

function blank(): Counter {
  return { channelId: '', template: 'Members: {count}', source: 'members' };
}

export function CountersEditor({
  counters,
  channels,
  onChange,
}: CountersEditorProps): ReactElement {
  const id = useId();
  const options = channelOptions(channels);
  const parsed = countersListSchema.safeParse(counters);

  function update(index: number, patch: Partial<Counter>): void {
    onChange(counters.map((counter, i) => (i === index ? { ...counter, ...patch } : counter)));
  }

  return (
    <div className="ladder" data-path="counters">
      <p className="field-description">
        Each counter renames one channel every ten minutes. That interval is Discord’s own limit on
        channel renames, not a Proton setting — a faster one would stall every other change Proton
        makes to that channel.
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
            <div className="filter">
              <span>
                <label htmlFor={channelControlId}>Channel</label>
              </span>
              <SinglePicker
                id={channelControlId}
                label="Channel"
                options={options}
                value={counter.channelId === '' ? null : counter.channelId}
                onChange={(next) => update(index, { channelId: next ?? '' })}
                emptyLabel="Choose a channel…"
                clearable={false}
                invalid={counter.channelId === ''}
              />
            </div>

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
              className="button button-quiet"
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
          No counters. Nothing is renamed until at least one channel is listed here.
        </p>
      ) : null}

      <button
        type="button"
        className="button button-quiet"
        onClick={() => onChange([...counters, blank()])}
        disabled={counters.length >= MAX_SHOWN}
      >
        {counters.length >= MAX_SHOWN ? `Limit of ${MAX_SHOWN} reached` : 'Add counter'}
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
