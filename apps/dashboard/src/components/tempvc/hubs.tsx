import type { DurationField, EntitlementTier } from '@proton/core';
import {
  blankHub,
  CATEGORY_CHANNEL_TYPE,
  OWNER_CONTROL_LABELS,
  OWNER_CONTROLS,
  OWNERLESS_LABELS,
  OWNERLESS_MODES,
  PERMISSION_SYNC_LABELS,
  PERMISSION_SYNC_MODES,
  PRIVACY_LABELS,
  PRIVACY_MODES,
  TEMP_ROLE_LABELS,
  TEMP_ROLE_MODES,
  type TempVcHub,
  tempVcHubsSchema,
  VOICE_CHANNEL_TYPE,
} from '@proton/module-tempvc/config';
import type { ReactElement } from 'react';
import { useId, useState } from 'react';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import { BooleanGroupFieldInput, DurationFieldInput } from '../form/fields.tsx';
import {
  channelIcon,
  channelOptions,
  type DiscordChannel,
  type DiscordRole,
  roleOptions,
  SinglePicker,
} from '../form/picker.tsx';
import { Icon } from '../shell/icon.tsx';

export interface HubsEditorProps {
  hubs: readonly Partial<TempVcHub>[];
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
  tier: EntitlementTier;
  onChange: (hubs: TempVcHub[]) => void;
}

const TABS = [
  { id: 'channel', title: 'Channel' },
  { id: 'access', title: 'Access' },
  { id: 'lifecycle', title: 'Lifecycle' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const EMPTY_DELETE_MAX_SECONDS = 300;

const CREATION_COOLDOWN_MAX_SECONDS = 600;

/**
 * A stored creator channel filled out to the current shape. The API parses config before it gets
 * here, but a v1 row that reaches the editor unparsed would otherwise crash on `hub.allow` — and a
 * settings page that throws is worse than one showing defaults it is about to save anyway.
 */
function complete(hub: Partial<TempVcHub>): TempVcHub {
  const defaults = blankHub();

  return {
    ...defaults,
    ...hub,
    allow: { ...defaults.allow, ...(hub.allow ?? {}) },
    channelId: hub.channelId ?? '',
  };
}

function nameOf(channels: readonly DiscordChannel[], channelId: string | undefined): string | null {
  if (!channelId) return null;

  return channels.find((channel) => channel.id === channelId)?.name ?? channelId;
}

function duration(path: string, label: string): DurationField {
  return { kind: 'duration', path, label, optional: false };
}

export function HubsEditor({
  hubs: stored,
  channels,
  roles,
  tier,
  onChange,
}: HubsEditorProps): ReactElement {
  const fieldId = useId();
  const ceiling = listCeiling(tier, 'tempVcHubs');
  const hubs = stored.map(complete);
  const parsed = tempVcHubsSchema.safeParse(hubs);

  const [picked, setPicked] = useState(0);
  const [tab, setTab] = useState<TabId>('channel');

  // Clamped rather than held: removing the last creator channel leaves the selection past the end of
  // the list, and the pane would then edit a hub that is no longer there.
  const index = Math.min(picked, hubs.length - 1);
  const hub = hubs[index];

  const voiceChoices = channelOptions(channels, [VOICE_CHANNEL_TYPE]);
  const categoryChoices = channelOptions(channels, [CATEGORY_CHANNEL_TYPE]);
  const roleChoices = roleOptions(roles);

  function update(patch: Partial<TempVcHub>): void {
    onChange(hubs.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }

  function add(): void {
    setPicked(hubs.length);
    setTab('channel');
    onChange([...hubs, blankHub()]);
  }

  function remove(): void {
    setPicked(0);
    onChange(hubs.filter((_, i) => i !== index));
  }

  const id = (part: string): string => `${fieldId}-${part}`;

  return (
    <div className="hub-split" data-path="hubs">
      <div className="hub-list">
        <p className="field-description">
          A member who joins a creator channel gets their own voice channel and is moved into it.
          The channel is removed once the last person leaves.
        </p>

        {hubs.length === 0 ? (
          <p className="field-empty">
            No creator channels. Members cannot get a temporary channel until at least one voice
            channel is a creator channel.
          </p>
        ) : (
          <ul className="hub-rows">
            {hubs.map((entry, position) => {
              const name = nameOf(channels, entry.channelId);
              const category = nameOf(channels, entry.categoryId);

              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own row
                  key={`hub-${position}`}
                >
                  <button
                    type="button"
                    className="hub-row"
                    aria-current={position === index ? 'true' : undefined}
                    onClick={() => setPicked(position)}
                  >
                    <span className="hub-row-name">
                      <Icon name={channelIcon(VOICE_CHANNEL_TYPE)} />
                      {name ?? 'No channel chosen yet'}
                    </span>
                    <span className="hub-row-meta">
                      {category === null ? 'No category' : `Into ${category}`} ·{' '}
                      {entry.userLimit === 0 ? 'No member limit' : `${entry.userLimit} members`}
                      {entry.enabled ? '' : ' · Out of service'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <button
          type="button"
          className="button button-quiet"
          onClick={add}
          disabled={hubs.length >= ceiling}
        >
          {hubs.length >= ceiling ? ceilingNote(tier, 'tempVcHubs') : 'Add creator channel'}
        </button>
      </div>

      {hub === undefined ? null : (
        <div className="hub-detail">
          <div className="hub-detail-head">
            <label className="tempvc-toggle">
              <input
                type="checkbox"
                role="switch"
                checked={hub.enabled}
                aria-checked={hub.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
              />
              <span>In service</span>
            </label>

            <fieldset className="segmented">
              <legend className="sr-only">Which settings of this creator channel</legend>
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={tab === entry.id ? 'segment is-active' : 'segment'}
                  aria-pressed={tab === entry.id}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.title}
                </button>
              ))}
            </fieldset>

            <button
              type="button"
              className="button button-ghost"
              aria-label={`Remove creator channel ${index + 1}`}
              onClick={remove}
            >
              Remove
            </button>
          </div>

          {tab === 'channel' ? (
            <div className="hub-fields">
              <div className="filter">
                <span>
                  <label htmlFor={id('hub')}>Creator channel</label>
                </span>
                <SinglePicker
                  id={id('hub')}
                  label="Creator channel"
                  options={voiceChoices}
                  value={hub.channelId === '' ? null : hub.channelId}
                  onChange={(next) => update({ channelId: next ?? '' })}
                  emptyLabel="Choose a voice channel…"
                  clearable={false}
                  invalid={hub.channelId === ''}
                />
              </div>

              <div className="filter">
                <span>
                  <label htmlFor={id('category')}>New channels go in</label>
                </span>
                <SinglePicker
                  id={id('category')}
                  label="New channels go in"
                  options={categoryChoices}
                  value={hub.categoryId ?? null}
                  onChange={(next) =>
                    update(next === null ? { categoryId: undefined } : { categoryId: next })
                  }
                  emptyLabel="No category"
                  clearable
                />
              </div>

              <label className="filter">
                <span>Named</span>
                <input
                  type="text"
                  value={hub.nameTemplate}
                  aria-invalid={!/\{(user|displayName|username|userId)\}/.test(hub.nameTemplate)}
                  onChange={(e) => update({ nameTemplate: e.target.value })}
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
                    update({ userLimit: e.target.value === '' ? 0 : e.target.valueAsNumber })
                  }
                />
              </label>

              <label className="filter">
                <span>Bitrate</span>
                <input
                  type="number"
                  min={8000}
                  max={384000}
                  step={1000}
                  placeholder="Discord’s default"
                  value={hub.bitrate ?? ''}
                  onChange={(e) =>
                    update({
                      bitrate: e.target.value === '' ? undefined : e.target.valueAsNumber,
                    })
                  }
                />
              </label>
            </div>
          ) : null}

          {tab === 'access' ? (
            <div className="hub-fields">
              <label className="filter">
                <span>Who may join</span>
                <select
                  value={hub.privacy}
                  onChange={(e) => update({ privacy: e.target.value as TempVcHub['privacy'] })}
                >
                  {PRIVACY_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {PRIVACY_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="filter">
                <span>Copy permissions from</span>
                <select
                  value={hub.permissionSync}
                  onChange={(e) =>
                    update({ permissionSync: e.target.value as TempVcHub['permissionSync'] })
                  }
                >
                  {PERMISSION_SYNC_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {PERMISSION_SYNC_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="filter">
                <span>When the owner leaves</span>
                <select
                  value={hub.ownerlessMode}
                  onChange={(e) =>
                    update({ ownerlessMode: e.target.value as TempVcHub['ownerlessMode'] })
                  }
                >
                  {OWNERLESS_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {OWNERLESS_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="filter">
                <span>Temporary role goes to</span>
                <select
                  value={hub.temporaryRoleMode}
                  onChange={(e) =>
                    update({
                      temporaryRoleMode: e.target.value as TempVcHub['temporaryRoleMode'],
                    })
                  }
                >
                  {TEMP_ROLE_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {TEMP_ROLE_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </label>

              {hub.temporaryRoleMode === 'off' ? null : (
                <div className="filter">
                  <span>
                    <label htmlFor={id('role')}>The role</label>
                  </span>
                  <SinglePicker
                    id={id('role')}
                    label="Temporary role"
                    options={roleChoices}
                    value={hub.temporaryRoleId ?? null}
                    onChange={(next) =>
                      update(
                        next === null ? { temporaryRoleId: undefined } : { temporaryRoleId: next },
                      )
                    }
                    emptyLabel="Choose a role…"
                    clearable
                    invalid={hub.temporaryRoleId === undefined}
                  />
                </div>
              )}

              <div className="hub-wide">
                <label className="tempvc-toggle">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={hub.interfaceEnabled}
                    aria-checked={hub.interfaceEnabled}
                    onChange={(e) => update({ interfaceEnabled: e.target.checked })}
                  />
                  <span>Post the control panel in the new channel</span>
                </label>

                <BooleanGroupFieldInput
                  label="What the owner may do"
                  description="Each one is a button on the control panel and a subcommand of /voice."
                  toggles={OWNER_CONTROLS.map((control) => ({
                    path: `hubs.${index}.allow.${control}`,
                    label: OWNER_CONTROL_LABELS[control],
                    value: hub.allow[control],
                    onChange: (next: boolean) =>
                      update({ allow: { ...hub.allow, [control]: next } }),
                  }))}
                />
              </div>
            </div>
          ) : null}

          {tab === 'lifecycle' ? (
            <div className="hub-fields">
              <label className="tempvc-toggle hub-wide">
                <input
                  type="checkbox"
                  role="switch"
                  checked={hub.autoDeleteEmpty}
                  aria-checked={hub.autoDeleteEmpty}
                  onChange={(e) => update({ autoDeleteEmpty: e.target.checked })}
                />
                <span>Delete the channel once it is empty</span>
              </label>

              <DurationFieldInput
                descriptor={duration(`hubs.${index}.emptyDeleteDelay`, 'Delete when empty after')}
                value={hub.emptyDeleteDelay}
                onChange={(next) =>
                  update({ emptyDeleteDelay: typeof next === 'string' ? next : '' })
                }
                bounds={{ maxSeconds: EMPTY_DELETE_MAX_SECONDS }}
                param={{ label: 'Delete when empty after' }}
              />

              <DurationFieldInput
                descriptor={duration(`hubs.${index}.creationCooldown`, 'Wait before another')}
                value={hub.creationCooldown}
                onChange={(next) =>
                  update({ creationCooldown: typeof next === 'string' ? next : '' })
                }
                bounds={{ maxSeconds: CREATION_COOLDOWN_MAX_SECONDS }}
                param={{ label: 'Wait before another' }}
              />

              <label className="filter">
                <span>Channels per member</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={hub.maxChannelsPerUser}
                  onChange={(e) =>
                    update({
                      maxChannelsPerUser: e.target.value === '' ? 1 : e.target.valueAsNumber,
                    })
                  }
                />
              </label>

              <p className="tempvc-hint hub-wide">
                The delay is re-checked before the channel goes, so somebody switching channels does
                not lose theirs. It only applies while “Delete the channel once it is empty” is on.
              </p>
            </div>
          ) : null}
        </div>
      )}

      {parsed.success ? null : (
        <ul className="ladder-errors hub-errors" role="alert">
          {parsed.error.issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
              {issue.path.length > 0 ? `Creator channel ${Number(issue.path[0]) + 1}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
