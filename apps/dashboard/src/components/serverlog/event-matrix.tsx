import { EMPTY_MESSAGE, type ProtonMessage } from '@proton/core';
import {
  LOG_CATEGORIES,
  LOG_EVENT_KEYS,
  LOG_EVENTS,
  type LogCategory,
} from '@proton/module-serverlog/catalogue';
import { LOG_TEXT_CHANNEL_TYPES, type LogEventOverride } from '@proton/module-serverlog/config';
import type { ReactElement } from 'react';
import { useId, useState } from 'react';
import { channelOptions, type DiscordChannel, SinglePicker } from '../form/picker.tsx';
import { MessagePreview } from '../message/preview.tsx';

export interface LogEventMatrixProps {
  events: Readonly<Record<string, LogEventOverride>>;
  channels: readonly DiscordChannel[];
  defaultChannelId: string;
  categoryChannels: Readonly<Record<string, string>>;
  categories: Readonly<Record<string, boolean>>;
  onChange: (events: Record<string, LogEventOverride>) => void;
}

const CATEGORY_TITLES: Record<LogCategory, string> = {
  server: 'Server',
  channels: 'Channels',
  roles: 'Roles',
  members: 'Members',
  messages: 'Messages',
  voice: 'Voice',
  moderation: 'Moderation',
  invites: 'Invites',
  integrations: 'Integrations',
  expressions: 'Emoji & stickers',
  events: 'Events & stages',
  automod: 'AutoMod',
  proton: 'Proton',
};

type Toggle = 'inherit' | 'on' | 'off';

function toggleOf(override: LogEventOverride | undefined): Toggle {
  if (override?.enabled === true) return 'on';
  if (override?.enabled === false) return 'off';
  return 'inherit';
}

function keysIn(category: LogCategory): string[] {
  return LOG_EVENT_KEYS.filter((key) => LOG_EVENTS[key]?.category === category);
}

/**
 * The title and the accent Proton really sends for this log, and nothing it would have to invent:
 * the lines under the title are written from the member, channel or role the event carried, which
 * does not exist until the event does.
 */
function sampleOf(key: string): ProtonMessage {
  const spec = LOG_EVENTS[key];

  return {
    ...EMPTY_MESSAGE,
    embeds: [{ title: spec?.label ?? key, color: spec?.colour }],
  };
}

export function LogEventMatrix({
  events,
  channels,
  defaultChannelId,
  categoryChannels,
  categories,
  onChange,
}: LogEventMatrixProps): ReactElement {
  const fieldId = useId();
  const hintId = `${fieldId}-pick`;
  const textChannels = channels.filter((channel) => LOG_TEXT_CHANNEL_TYPES.includes(channel.type));
  const options = channelOptions(textChannels);

  const [shown, setShown] = useState(LOG_EVENT_KEYS[0] ?? '');

  function channelName(channelId: string): string {
    if (!channelId) return 'nowhere';
    const found = textChannels.find((channel) => channel.id === channelId);
    return found ? `#${found.name}` : `#${channelId}`;
  }

  function inheritedChannel(category: LogCategory): string {
    return categoryChannels[category] || defaultChannelId || '';
  }

  function isOn(key: string, category: LogCategory): boolean {
    const toggle = toggleOf(events[key]);
    if (toggle === 'on') return true;
    if (toggle === 'off') return false;
    return categories[category] === true;
  }

  // Writing a row back to "inherit" deletes its key rather than storing an empty override, so a
  // guild that never touched the matrix stores {} and Reset is trivially correct.
  function patch(key: string, next: LogEventOverride): void {
    const merged = { ...events };

    if (next.enabled === undefined && !next.channelId) delete merged[key];
    else merged[key] = next;

    onChange(merged);
  }

  function setToggle(key: string, toggle: Toggle): void {
    const current = events[key] ?? {};
    patch(key, {
      ...(toggle === 'inherit' ? {} : { enabled: toggle === 'on' }),
      ...(current.channelId ? { channelId: current.channelId } : {}),
    });
  }

  function setChannel(key: string, channelId: string): void {
    const current = events[key] ?? {};
    patch(key, {
      ...(current.enabled === undefined ? {} : { enabled: current.enabled }),
      ...(channelId ? { channelId } : {}),
    });
  }

  function setCategory(category: LogCategory, toggle: Toggle): void {
    const merged = { ...events };

    for (const key of keysIn(category)) {
      const current = merged[key] ?? {};

      if (toggle === 'inherit') {
        if (current.channelId) merged[key] = { channelId: current.channelId };
        else delete merged[key];
        continue;
      }

      merged[key] = {
        enabled: toggle === 'on',
        ...(current.channelId ? { channelId: current.channelId } : {}),
      };
    }

    onChange(merged);
  }

  function resetCategory(category: LogCategory): void {
    const merged = { ...events };
    for (const key of keysIn(category)) delete merged[key];
    onChange(merged);
  }

  const chosen = LOG_EVENTS[shown];
  const chosenCategory = chosen?.category;
  const chosenChannel = chosenCategory
    ? events[shown]?.channelId || inheritedChannel(chosenCategory)
    : '';

  return (
    <div className="log-matrix" data-path="events">
      <p className="field-description">
        Each log follows its category unless you override it here. Turning a single log <em>on</em>{' '}
        overrides a category that is off, so you can log one thing and nothing else.
      </p>

      <div className="log-matrix-split">
        <div className="log-matrix-scroll">
          <table className="matrix log-events">
            <thead>
              <tr>
                <th className="log-head" scope="col">
                  Log
                </th>
                <th className="log-head" scope="col">
                  State
                </th>
                <th className="log-head" scope="col">
                  Channel
                </th>
              </tr>
            </thead>

            {LOG_CATEGORIES.map((category) => {
              const keys = keysIn(category);
              if (keys.length === 0) return null;

              const on = keys.filter((key) => isOn(key, category)).length;
              const inherited = inheritedChannel(category);

              return (
                <tbody key={category}>
                  <tr className="log-group">
                    {/* The flex line is a span inside the cell: laying out the `th` itself takes it
                        out of the table, and its colspan with it. */}
                    <th scope="rowgroup" colSpan={3}>
                      <span className="log-group-line">
                        <span className="log-group-title">{CATEGORY_TITLES[category]}</span>
                        <span className="log-group-count">
                          {on} of {keys.length} on → {channelName(inherited)}
                        </span>

                        {/* The best bulk control in the product, kept as it was: thirteen groups is
                            thirteen clicks, and eighty-nine rows is not. */}
                        <span className="log-group-bulk">
                          <button
                            type="button"
                            className="button button-quiet"
                            onClick={() => setCategory(category, 'on')}
                          >
                            All on
                          </button>
                          <button
                            type="button"
                            className="button button-quiet"
                            onClick={() => setCategory(category, 'off')}
                          >
                            All off
                          </button>
                          <button
                            type="button"
                            className="button button-quiet"
                            onClick={() => resetCategory(category)}
                          >
                            Reset
                          </button>
                        </span>
                      </span>
                    </th>
                  </tr>

                  {keys.map((key) => {
                    const override = events[key];
                    const spec = LOG_EVENTS[key];
                    // A wrapping label would forward option clicks to the trigger and reopen it.
                    const channelControlId = `${fieldId}-channel-${key}`;

                    return (
                      <tr
                        className="log-row"
                        key={key}
                        data-shown={key === shown ? 'true' : undefined}
                      >
                        <th scope="row">
                          <button
                            type="button"
                            className="log-event"
                            aria-pressed={key === shown}
                            aria-describedby={hintId}
                            title={key}
                            onClick={() => setShown(key)}
                          >
                            {spec?.label ?? key}
                          </button>
                        </th>

                        <td data-kind="state" data-label="State">
                          <select
                            className="log-state"
                            value={toggleOf(override)}
                            aria-label={`${spec?.label ?? key} state`}
                            onChange={(e) => setToggle(key, e.target.value as Toggle)}
                          >
                            <option value="inherit">
                              Inherit — {categories[category] ? 'on' : 'off'}
                            </option>
                            <option value="on">On</option>
                            <option value="off">Off</option>
                          </select>
                        </td>

                        <td data-kind="channel-id" data-label="Channel">
                          <SinglePicker
                            id={channelControlId}
                            label={`${spec?.label ?? key} channel`}
                            options={options}
                            value={override?.channelId ?? null}
                            onChange={(next) => setChannel(key, next ?? '')}
                            emptyLabel={`Inherit — ${channelName(inherited)}`}
                            clearable
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
          </table>
        </div>

        <aside className="log-sample">
          <h3 className="log-sample-head">What arrives in the channel</h3>
          <p className="sr-only" id={hintId}>
            Shows what this log looks like where it lands.
          </p>

          <MessagePreview message={sampleOf(shown)} channels={channels} roles={[]} head={null} />

          <p className="field-description">
            The title and the colour are the real ones. Proton writes the lines under them as the
            event happens, from whoever did it and whatever it touched.
          </p>

          <dl className="log-sample-facts">
            <dt>Logged</dt>
            <dd>
              {chosenCategory === undefined
                ? 'Unknown log'
                : isOn(shown, chosenCategory)
                  ? 'Yes'
                  : 'No'}
            </dd>
            <dt>Lands in</dt>
            <dd>{channelName(chosenChannel)}</dd>
          </dl>
        </aside>
      </div>

      {LOG_EVENT_KEYS.length === 0 ? <p className="field-empty">No logs to configure.</p> : null}
    </div>
  );
}
