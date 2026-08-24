import {
  blankHub,
  CATEGORY_CHANNEL_TYPE,
  HUBS_CEILING,
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
import { useId } from 'react';
import {
  channelOptions,
  type DiscordChannel,
  type DiscordRole,
  roleOptions,
  SinglePicker,
} from '../form/picker.tsx';

export interface HubsEditorProps {
  hubs: readonly Partial<TempVcHub>[];
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
  onChange: (hubs: TempVcHub[]) => void;
}

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

export function HubsEditor({
  hubs: stored,
  channels,
  roles,
  onChange,
}: HubsEditorProps): ReactElement {
  const fieldId = useId();
  const hubs = stored.map(complete);
  const parsed = tempVcHubsSchema.safeParse(hubs);

  const voiceChoices = channelOptions(channels, [VOICE_CHANNEL_TYPE]);
  const categoryChoices = channelOptions(channels, [CATEGORY_CHANNEL_TYPE]);
  const roleChoices = roleOptions(roles);

  function update(index: number, patch: Partial<TempVcHub>): void {
    onChange(hubs.map((hub, i) => (i === index ? { ...hub, ...patch } : hub)));
  }

  return (
    <div className="ladder" data-path="hubs">
      <p className="field-description">
        A member who joins a creator channel gets their own voice channel and is moved into it. The
        channel is removed once the last person leaves.
      </p>

      {hubs.map((hub, index) => {
        // A label wrapping a picker would forward option clicks back to the trigger and reopen it.
        const id = (part: string): string => `${fieldId}-${part}-${index}`;

        return (
          <div
            className="ladder-rung tempvc-hub"
            // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own row
            key={`hub-${index}`}
          >
            <div className="filter">
              <span>
                <label htmlFor={id('hub')}>Creator channel</label>
              </span>
              <SinglePicker
                id={id('hub')}
                label="Creator channel"
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
                <label htmlFor={id('category')}>New channels go in</label>
              </span>
              <SinglePicker
                id={id('category')}
                label="New channels go in"
                options={categoryChoices}
                value={hub.categoryId ?? null}
                onChange={(next) =>
                  update(index, next === null ? { categoryId: undefined } : { categoryId: next })
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
                  update(index, {
                    bitrate: e.target.value === '' ? undefined : e.target.valueAsNumber,
                  })
                }
              />
            </label>

            <label className="filter">
              <span>Who may join</span>
              <select
                value={hub.privacy}
                onChange={(e) => update(index, { privacy: e.target.value as TempVcHub['privacy'] })}
              >
                {PRIVACY_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {PRIVACY_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>

            <label className="filter">
              <span>When the owner leaves</span>
              <select
                value={hub.ownerlessMode}
                onChange={(e) =>
                  update(index, { ownerlessMode: e.target.value as TempVcHub['ownerlessMode'] })
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
              <span>Delete when empty after</span>
              <input
                type="text"
                value={hub.emptyDeleteDelay}
                disabled={!hub.autoDeleteEmpty}
                onChange={(e) => update(index, { emptyDeleteDelay: e.target.value })}
              />
            </label>

            <label className="filter">
              <span>Wait before another</span>
              <input
                type="text"
                value={hub.creationCooldown}
                onChange={(e) => update(index, { creationCooldown: e.target.value })}
              />
            </label>

            <label className="filter">
              <span>Channels per member</span>
              <input
                type="number"
                min={1}
                max={10}
                value={hub.maxChannelsPerUser}
                onChange={(e) =>
                  update(index, {
                    maxChannelsPerUser: e.target.value === '' ? 1 : e.target.valueAsNumber,
                  })
                }
              />
            </label>

            <label className="filter">
              <span>Copy permissions from</span>
              <select
                value={hub.permissionSync}
                onChange={(e) =>
                  update(index, { permissionSync: e.target.value as TempVcHub['permissionSync'] })
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
              <span>Temporary role goes to</span>
              <select
                value={hub.temporaryRoleMode}
                onChange={(e) =>
                  update(index, {
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
                      index,
                      next === null ? { temporaryRoleId: undefined } : { temporaryRoleId: next },
                    )
                  }
                  emptyLabel="Choose a role…"
                  clearable
                  invalid={hub.temporaryRoleId === undefined}
                />
              </div>
            )}

            <div className="tempvc-toggles">
              <label className="tempvc-toggle">
                <input
                  type="checkbox"
                  role="switch"
                  checked={hub.enabled}
                  aria-checked={hub.enabled}
                  onChange={(e) => update(index, { enabled: e.target.checked })}
                />
                <span>In service</span>
              </label>

              <label className="tempvc-toggle">
                <input
                  type="checkbox"
                  role="switch"
                  checked={hub.autoDeleteEmpty}
                  aria-checked={hub.autoDeleteEmpty}
                  onChange={(e) => update(index, { autoDeleteEmpty: e.target.checked })}
                />
                <span>Delete when empty</span>
              </label>

              <label className="tempvc-toggle">
                <input
                  type="checkbox"
                  role="switch"
                  checked={hub.interfaceEnabled}
                  aria-checked={hub.interfaceEnabled}
                  onChange={(e) => update(index, { interfaceEnabled: e.target.checked })}
                />
                <span>Post the control panel</span>
              </label>
            </div>

            <fieldset className="tempvc-controls">
              <legend>What the owner may do</legend>

              {OWNER_CONTROLS.map((control) => (
                <label className="tempvc-toggle" key={control}>
                  <input
                    type="checkbox"
                    checked={hub.allow[control]}
                    onChange={(e) =>
                      update(index, { allow: { ...hub.allow, [control]: e.target.checked } })
                    }
                  />
                  <span>{OWNER_CONTROL_LABELS[control]}</span>
                </label>
              ))}
            </fieldset>

            <button
              type="button"
              className="button button-quiet"
              aria-label={`Remove creator channel ${index + 1}`}
              onClick={() => onChange(hubs.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
        );
      })}

      {hubs.length === 0 ? (
        <p className="field-empty">
          No creator channels. Members cannot get a temporary channel until at least one voice
          channel is a creator channel.
        </p>
      ) : null}

      <button
        type="button"
        className="button button-quiet"
        onClick={() => onChange([...hubs, blankHub()])}
        disabled={hubs.length >= HUBS_CEILING}
      >
        {hubs.length >= HUBS_CEILING
          ? `Limit of ${HUBS_CEILING} creator channels reached`
          : 'Add creator channel'}
      </button>

      {parsed.success ? null : (
        <ul className="ladder-errors" role="alert">
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
