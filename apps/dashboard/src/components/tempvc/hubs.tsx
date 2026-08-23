import { type TempVcHub, tempVcHubsSchema } from '@proton/module-tempvc/config';
import type { ReactElement } from 'react';
import { useId } from 'react';
import { channelOptions, type DiscordChannel, SinglePicker } from '../form/picker.tsx';

export interface HubsEditorProps {
  hubs: readonly TempVcHub[];
  channels: readonly DiscordChannel[];
  onChange: (hubs: TempVcHub[]) => void;
}

const MAX_HUBS = 40;

const VOICE_CHANNEL_TYPE = 2;
const CATEGORY_CHANNEL_TYPE = 4;

function blank(): TempVcHub {
  return { channelId: '', nameTemplate: '{user}’s channel', userLimit: 0 };
}

export function HubsEditor({ hubs, channels, onChange }: HubsEditorProps): ReactElement {
  const fieldId = useId();
  const parsed = tempVcHubsSchema.safeParse(hubs);

  const voiceChoices = channelOptions(channels, [VOICE_CHANNEL_TYPE]);
  const categoryChoices = channelOptions(channels, [CATEGORY_CHANNEL_TYPE]);

  function update(index: number, patch: Partial<TempVcHub>): void {
    onChange(hubs.map((hub, i) => (i === index ? { ...hub, ...patch } : hub)));
  }

  return (
    <div className="ladder" data-path="hubs">
      <p className="field-description">
        A member who joins a hub gets their own voice channel and is moved into it. The channel is
        removed the moment the last person leaves.
      </p>

      {hubs.map((hub, index) => {
        // A label wrapping the picker would forward option clicks back to the trigger and reopen it.
        const hubControlId = `${fieldId}-hub-${index}`;
        const categoryControlId = `${fieldId}-category-${index}`;

        return (
          <div
            className="ladder-rung"
            // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own row
            key={`hub-${index}`}
          >
            <div className="filter">
              <span>
                <label htmlFor={hubControlId}>Hub channel</label>
              </span>
              <SinglePicker
                id={hubControlId}
                label="Hub channel"
                options={voiceChoices}
                value={hub.channelId === '' ? null : hub.channelId}
                onChange={(next) => update(index, { channelId: next ?? '' })}
                emptyLabel="Choose a voice channel…"
                clearable={false}
                invalid={hub.channelId === ''}
              />
            </div>

            <div className="filter">
              <span>
                <label htmlFor={categoryControlId}>New channels go in</label>
              </span>
              <SinglePicker
                id={categoryControlId}
                label="New channels go in"
                options={categoryChoices}
                value={hub.categoryId ?? null}
                onChange={(next) => update(index, next === null ? {} : { categoryId: next })}
                emptyLabel="No category"
                clearable
              />
            </div>

            <label className="filter">
              <span>Named</span>
              <input
                type="text"
                value={hub.nameTemplate}
                aria-invalid={!hub.nameTemplate.includes('{user}')}
                onChange={(e) => update(index, { nameTemplate: e.target.value })}
              />
            </label>

            <label className="filter">
              <span>Member limit</span>
              <input
                type="number"
                min={0}
                max={99}
                value={hub.userLimit}
                onChange={(e) =>
                  update(index, { userLimit: e.target.value === '' ? 0 : e.target.valueAsNumber })
                }
              />
            </label>

            <button
              type="button"
              className="button button-quiet"
              aria-label={`Remove hub ${index + 1}`}
              onClick={() => onChange(hubs.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
        );
      })}

      {hubs.length === 0 ? (
        <p className="field-empty">
          No hubs. Members cannot get a temporary channel until at least one voice channel is a hub.
        </p>
      ) : null}

      <button
        type="button"
        className="button button-quiet"
        onClick={() => onChange([...hubs, blank()])}
        disabled={hubs.length >= MAX_HUBS}
      >
        {hubs.length >= MAX_HUBS ? `Limit of ${MAX_HUBS} hubs reached` : 'Add hub'}
      </button>

      {parsed.success ? null : (
        <ul className="ladder-errors" role="alert">
          {parsed.error.issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
              {issue.path.length > 0 ? `Hub ${Number(issue.path[0]) + 1}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
