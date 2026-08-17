import {
  LOG_CATEGORIES,
  LOG_EVENT_KEYS,
  LOG_EVENTS,
  LOG_TEXT_CHANNEL_TYPES,
  type LogCategory,
  type LogEventOverride,
} from '@proton/module-serverlog';
import type { ReactElement } from 'react';
import type { DiscordChannel } from '../form/fields.tsx';

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

export function LogEventMatrix({
  events,
  channels,
  defaultChannelId,
  categoryChannels,
  categories,
  onChange,
}: LogEventMatrixProps): ReactElement {
  const textChannels = channels.filter((channel) => LOG_TEXT_CHANNEL_TYPES.includes(channel.type));

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

  return (
    <div className="log-matrix" data-path="events">
      <p className="field-description">
        Each log follows its category unless you override it here. Turning a single log <em>on</em>{' '}
        overrides a category that is off, so you can log one thing and nothing else.
      </p>

      {LOG_CATEGORIES.map((category) => {
        const keys = keysIn(category);
        if (keys.length === 0) return null;

        const on = keys.filter((key) => isOn(key, category)).length;
        const inherited = inheritedChannel(category);

        return (
          <details className="log-category" key={category}>
            <summary>
              <span className="log-category-title">{CATEGORY_TITLES[category]}</span>
              <span className="log-category-summary">
                {on} of {keys.length} on → {channelName(inherited)}
              </span>
            </summary>

            <div className="filters">
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
            </div>

            {keys.map((key) => {
              const override = events[key];
              const spec = LOG_EVENTS[key];

              return (
                <div className="ladder-rung" key={key}>
                  <span className="log-event-label" title={key}>
                    {spec?.label ?? key}
                  </span>

                  <label className="filter">
                    <span>State</span>
                    <select
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
                  </label>

                  <label className="filter">
                    <span>Channel</span>
                    <select
                      value={override?.channelId ?? ''}
                      aria-label={`${spec?.label ?? key} channel`}
                      onChange={(e) => setChannel(key, e.target.value)}
                    >
                      <option value="">Inherit — {channelName(inherited)}</option>
                      {textChannels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          #{channel.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              );
            })}
          </details>
        );
      })}

      {LOG_EVENT_KEYS.length === 0 ? (
        <p className="field-empty">No logs are available in this build.</p>
      ) : null}
    </div>
  );
}
