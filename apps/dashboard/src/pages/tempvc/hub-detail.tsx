import {
  CHANNEL_NAME_MAX,
  OWNER_CONTROL_LABELS,
  OWNER_CONTROLS,
  OWNERLESS_LABELS,
  OWNERLESS_MODES,
  type OwnerlessMode,
  PERMISSION_SYNC_LABELS,
  PERMISSION_SYNC_MODES,
  type PermissionSyncMode,
  PRIVACY_LABELS,
  PRIVACY_MODES,
  type PrivacyMode,
  TEMP_ROLE_LABELS,
  TEMP_ROLE_MODES,
  type TempRoleMode,
  type TempVcHub,
} from '@proton/module-tempvc/config';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { CHANNEL_TYPE, ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { DurationInput } from '../../components/discord/inputs.tsx';
import { RolePicker } from '../../components/discord/role-picker.tsx';
import { ModuleLink } from '../../components/module/route.tsx';
import { Button, NumberStepper, Select, Switch, TextInput } from '../../components/ui/controls.tsx';
import { ActionRow, Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { ConfirmDialog } from '../../components/ui/overlay.tsx';
import { PANEL_GROUPS, setHubs, type TempVcForm, updateHub } from './shape.ts';

const PRIVACY_OPTIONS = PRIVACY_MODES.map((mode) => ({ value: mode, label: PRIVACY_LABELS[mode] }));

const SYNC_OPTIONS = PERMISSION_SYNC_MODES.map((mode) => ({
  value: mode,
  label: PERMISSION_SYNC_LABELS[mode],
}));

const OWNERLESS_OPTIONS = OWNERLESS_MODES.map((mode) => ({
  value: mode,
  label: OWNERLESS_LABELS[mode],
}));

const TEMP_ROLE_OPTIONS = TEMP_ROLE_MODES.map((mode) => ({
  value: mode,
  label: TEMP_ROLE_LABELS[mode],
}));

export function HubDetail({
  form,
  guildId,
  moduleId,
  index,
  hub,
  onRemoved,
}: {
  form: TempVcForm;
  guildId: string;
  moduleId: string;
  index: number;
  hub: TempVcHub;
  onRemoved: () => void;
}): ReactElement {
  const [removing, setRemoving] = useState(false);

  const at = (field: string): string | undefined => form.errorAt(`hubs.${index}.${field}`);
  const change = (next: (current: TempVcHub) => TempVcHub): void => updateHub(form, index, next);

  return (
    <>
      <Section label="Creation">
        <Rows>
          <SettingRow
            title="Creator channel"
            description="Members who join this channel get a voice channel of their own and are moved into it."
            error={at('channelId')}
          >
            <ChannelPicker
              guildId={guildId}
              label="Creator channel"
              placeholder="Choose a voice channel"
              types={[CHANNEL_TYPE.voice]}
              allowNone={false}
              invalid={at('channelId') !== undefined}
              value={hub.channelId}
              onChange={(next) => change((current) => ({ ...current, channelId: next ?? '' }))}
            />
          </SettingRow>

          <SettingRow
            title="Category"
            description="Where new channels are created. With no category, Discord places them outside every category."
            error={at('categoryId')}
          >
            <ChannelPicker
              guildId={guildId}
              label="Category"
              noneLabel="No category"
              placeholder="No category"
              types={[CHANNEL_TYPE.category]}
              value={hub.categoryId}
              onChange={(next) =>
                change((current) => ({ ...current, categoryId: next ?? undefined }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Enabled"
            description="If off, joining this channel creates nothing. Its settings are kept."
            error={at('enabled')}
          >
            <Switch
              label="Enabled"
              checked={hub.enabled}
              onChange={(next) => change((current) => ({ ...current, enabled: next }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="New channels">
        <Rows>
          <SettingRow
            title="Name template"
            description={
              <>
                <span className="mono">{'{user}'}</span> and{' '}
                <span className="mono">{'{displayName}'}</span> become the member’s display name,{' '}
                <span className="mono">{'{username}'}</span> their username and{' '}
                <span className="mono">{'{userId}'}</span> their ID.
              </>
            }
            error={at('nameTemplate')}
          >
            <TextInput
              width="lg"
              aria-label="Name template"
              maxLength={CHANNEL_NAME_MAX}
              invalid={at('nameTemplate') !== undefined}
              value={hub.nameTemplate}
              onChange={(event) =>
                change((current) => ({ ...current, nameTemplate: event.currentTarget.value }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Member limit"
            description="How many members can be in the channel, up to 99. 0 means no limit."
            error={at('userLimit')}
          >
            <NumberStepper
              label="Member limit"
              min={0}
              max={99}
              invalid={at('userLimit') !== undefined}
              value={hub.userLimit}
              onChange={(next) =>
                change((current) => ({ ...current, userLimit: next ?? current.userLimit }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Bitrate"
            description="Leave empty to use Discord’s default."
            error={at('bitrate')}
          >
            <NumberStepper
              label="Bitrate"
              min={8000}
              max={384000}
              step={1000}
              width={132}
              invalid={at('bitrate') !== undefined}
              value={hub.bitrate ?? null}
              onChange={(next) => change((current) => ({ ...current, bitrate: next ?? undefined }))}
            />
            {hub.bitrate !== undefined ? (
              <Button
                tone="ghost"
                size="sm"
                onClick={() => change((current) => ({ ...current, bitrate: undefined }))}
              >
                Clear
              </Button>
            ) : null}
          </SettingRow>

          <SettingRow
            title="Who can join"
            description="Set with channel permissions, so Discord enforces it."
            error={at('privacy')}
          >
            <Select
              className="tempvc-select"
              aria-label="Who can join"
              options={PRIVACY_OPTIONS}
              value={hub.privacy}
              onChange={(value) =>
                change((current) => ({
                  ...current,
                  privacy: value as PrivacyMode,
                }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Starting permissions"
            description="Where a new channel’s permission overwrites come from, before Proton adds its own."
            error={at('permissionSync')}
            note={
              hub.permissionSync === 'category' && hub.categoryId === undefined
                ? 'With no category set, this copies the creator channel’s overwrites instead.'
                : undefined
            }
          >
            <Select
              className="tempvc-select"
              aria-label="Starting permissions"
              options={SYNC_OPTIONS}
              value={hub.permissionSync}
              onChange={(value) =>
                change((current) => ({
                  ...current,
                  permissionSync: value as PermissionSyncMode,
                }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Limits">
        <Rows>
          <SettingRow
            title="Channels per member"
            description="How many channels one member can own at once. At the limit, joining moves them into the one they have."
            error={at('maxChannelsPerUser')}
          >
            <NumberStepper
              label="Channels per member"
              min={1}
              max={10}
              invalid={at('maxChannelsPerUser') !== undefined}
              value={hub.maxChannelsPerUser}
              onChange={(next) =>
                change((current) => ({
                  ...current,
                  maxChannelsPerUser: next ?? current.maxChannelsPerUser,
                }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Creation cooldown"
            description="How long a member must wait before creating another channel."
            error={at('creationCooldown')}
          >
            <DurationInput
              label="Creation cooldown"
              min={0}
              max={600_000}
              units={['s', 'm']}
              invalid={at('creationCooldown') !== undefined}
              value={hub.creationCooldown}
              onChange={(next) => change((current) => ({ ...current, creationCooldown: next }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Ownership">
        <Rows>
          <SettingRow
            title="When the owner leaves"
            description="Only applies if others are still in the channel."
            error={at('ownerlessMode')}
          >
            <Select
              className="tempvc-select"
              aria-label="When the owner leaves"
              options={OWNERLESS_OPTIONS}
              value={hub.ownerlessMode}
              onChange={(value) =>
                change((current) => ({
                  ...current,
                  ownerlessMode: value as OwnerlessMode,
                }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Temporary role">
        <Rows>
          <SettingRow
            title="Who gets the role"
            description="Proton gives the role while they are in the channel and removes it when they leave. Roles it did not give are never removed."
            error={at('temporaryRoleMode')}
          >
            <Select
              className="tempvc-select"
              aria-label="Who gets the role"
              options={TEMP_ROLE_OPTIONS}
              value={hub.temporaryRoleMode}
              onChange={(value) =>
                change((current) => ({
                  ...current,
                  temporaryRoleMode: value as TempRoleMode,
                }))
              }
            />
          </SettingRow>

          {hub.temporaryRoleMode !== 'off' ? (
            <SettingRow title="The role to hand out" error={at('temporaryRoleId')}>
              <RolePicker
                guildId={guildId}
                label="The role to hand out"
                invalid={at('temporaryRoleId') !== undefined}
                value={hub.temporaryRoleId}
                onChange={(next) =>
                  change((current) => ({ ...current, temporaryRoleId: next ?? undefined }))
                }
              />
            </SettingRow>
          ) : null}
        </Rows>
      </Section>

      {form.value.ownerCommands ? (
        <Section
          label="What owners can do"
          actions={
            <>
              <Button tone="ghost" size="sm" onClick={() => setAllow(form, index, true)}>
                All
              </Button>
              <Button tone="ghost" size="sm" onClick={() => setAllow(form, index, false)}>
                None
              </Button>
            </>
          }
        >
          <Rows>
            <SettingRow
              title="Post a control panel"
              description="Posted in the new channel’s text chat. Owners can still use /voice without it."
              error={at('interfaceEnabled')}
            >
              <Switch
                label="Post a control panel"
                checked={hub.interfaceEnabled}
                onChange={(next) => change((current) => ({ ...current, interfaceEnabled: next }))}
              />
            </SettingRow>
          </Rows>

          <div className="matrix tempvc-allow">
            {PANEL_GROUPS.map((group) => (
              <div className="matrix-group" key={group.label}>
                <div className="matrix-group-head">{group.label}</div>
                <div className="tempvc-allow-grid">
                  {group.controls.map((control) => (
                    <div className="tempvc-allow-cell" key={control}>
                      <span className="matrix-row-name">{OWNER_CONTROL_LABELS[control]}</span>
                      <Switch
                        label={`Allow ${OWNER_CONTROL_LABELS[control]}`}
                        checked={hub.allow[control]}
                        onChange={(next) =>
                          change((current) => ({
                            ...current,
                            allow: { ...current.allow, [control]: next },
                          }))
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      ) : (
        <Section
          label="What owners can do"
          intro={
            <>
              Owners cannot use /voice or the control panel, because “Let owners manage their own
              channel” is switched off.{' '}
              <ModuleLink guildId={guildId} moduleId={moduleId} search={{ area: 'settings' }}>
                Change it in Settings
              </ModuleLink>
            </>
          }
        >
          {null}
        </Section>
      )}

      <Section label="Cleanup">
        <Rows>
          <SettingRow title="Delete empty channels" error={at('autoDeleteEmpty')}>
            <Switch
              label="Delete empty channels"
              checked={hub.autoDeleteEmpty}
              onChange={(next) => change((current) => ({ ...current, autoDeleteEmpty: next }))}
            />
          </SettingRow>

          {hub.autoDeleteEmpty ? (
            <SettingRow
              title="Wait before deleting"
              description="How long a channel must stay empty before Proton deletes it. If a member rejoins in time, the channel is kept."
              error={at('emptyDeleteDelay')}
            >
              <DurationInput
                label="Wait before deleting"
                min={0}
                max={300_000}
                units={['s', 'm']}
                invalid={at('emptyDeleteDelay') !== undefined}
                value={hub.emptyDeleteDelay}
                onChange={(next) => change((current) => ({ ...current, emptyDeleteDelay: next }))}
              />
            </SettingRow>
          ) : null}
        </Rows>
      </Section>

      <Section>
        <Rows>
          <ActionRow
            title="Remove creator channel"
            description="Deletes its settings. Channels it already created keep running."
          >
            <Button tone="danger-quiet" icon="trash" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </ActionRow>
        </Rows>
      </Section>

      <ConfirmDialog
        open={removing}
        danger
        title="Remove creator channel?"
        confirmLabel="Remove"
        onClose={() => setRemoving(false)}
        onConfirm={() => {
          setHubs(
            form,
            form.value.hubs.filter((_, at2) => at2 !== index),
          );
          setRemoving(false);
          onRemoved();
        }}
      >
        Its settings are deleted. Channels it already created stay until they empty, and /voice in
        them replies that their creator channel was removed.
      </ConfirmDialog>
    </>
  );
}

function setAllow(form: TempVcForm, index: number, on: boolean): void {
  updateHub(form, index, (hub) => {
    const allow = { ...hub.allow };
    for (const control of OWNER_CONTROLS) allow[control] = on;
    return { ...hub, allow };
  });
}
