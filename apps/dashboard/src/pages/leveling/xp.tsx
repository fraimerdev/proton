import {
  type ChannelMultiplier,
  channelMultiplierSchema,
  type LevelingConfig,
  MULTIPLIER_CHANNEL_TYPES,
  type RoleMultiplier,
  roleMultiplierSchema,
  XP_MULTIPLIER_LIST_MAX,
  XP_MULTIPLIER_MAX,
  XP_MULTIPLIER_MIN,
  XP_MULTIPLIER_STEP,
} from '@proton/module-leveling/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
import {
  CHANNEL_TYPE,
  ChannelMultiPicker,
  ChannelPicker,
  channelIcon,
  useChannelIndex,
} from '../../components/discord/channel-picker.tsx';
import { DurationInput } from '../../components/discord/inputs.tsx';
import { RoleMultiPicker, RolePicker, roleColour } from '../../components/discord/role-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { CollectionHeader } from '../../components/ui/collection.tsx';
import { Button, cx, IconButton, NumberStepper } from '../../components/ui/controls.tsx';
import { EmptyState, Spinner, StatusBanner } from '../../components/ui/feedback.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { readFailure } from '../../lib/errors.ts';
import { rolesQuery } from '../../lib/queries.ts';
import { lookupState } from './rows.ts';

const XP_PER_MESSAGE_MAX = 1000;
const VOICE_XP_MAX = 100;
const EXCLUSION_MAX = 50;

const EARNING_CHANNEL_TYPES = [
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.announcement,
  CHANNEL_TYPE.publicThread,
  CHANNEL_TYPE.privateThread,
] as const;

const AFK_CHANNEL_TYPES = [CHANNEL_TYPE.voice, CHANNEL_TYPE.stage] as const;

const NO_MESSAGE_XP = 'Minimum and maximum are both 0, so messages earn no XP.';

const COOLDOWN_NOTE = 'Members earn XP for at most one message in each cooldown.';

const NO_VOICE_XP = 'Set to 0, so time in voice earns no XP and is not tracked.';

const AFK_NOTE =
  'Members do not earn voice XP in this channel, or while deafened, whether by themselves or a ' +
  'moderator.';

const EXCLUSIONS_INTRO =
  'Only ordinary messages and replies earn XP. Bot and webhook messages never do, in any channel.';

const CHANNELS_FULL = `You can add up to ${EXCLUSION_MAX} channels. Remove one to add another.`;

const MULTIPLIER_RULE =
  'When several multipliers apply, the highest wins. ×0 always wins, so it blocks XP.';

const MULTIPLIER_SCOPE =
  'Multipliers apply to message XP and voice XP. A running XP event counts as one more multiplier.';

const NO_ROLE_MULTIPLIERS = 'Give a role a multiplier to scale the XP its members earn.';

const NO_CHANNEL_MULTIPLIERS =
  'Give a channel or a category a multiplier to scale the XP earned in it.';

const ROLE_MULTIPLIERS_FULL = `You can add up to ${XP_MULTIPLIER_LIST_MAX} role multipliers. Remove one to add another.`;

const CHANNEL_MULTIPLIERS_FULL = `You can add up to ${XP_MULTIPLIER_LIST_MAX} channel multipliers. Remove one to add another.`;

const ROLE_TAKEN = 'That role already has a multiplier. Change it in its row instead.';

const CHANNEL_TAKEN = 'That channel already has a multiplier. Change it in its row instead.';

const ROLE_MISSING = 'Proton cannot find this role — it may have been deleted.';

const CHANNEL_MISSING = 'Proton cannot find this channel — it may have been deleted.';

const DEFAULT_MULTIPLIER = 2;

export function tidyMultiplier(value: number): number {
  const tenths = Math.round(value * 10);
  return Math.abs(value * 10 - tenths) < 1e-6 ? tenths / 10 : value;
}

export function MultiplierStepper({
  label,
  value,
  min = XP_MULTIPLIER_MIN,
  max = XP_MULTIPLIER_MAX,
  invalid = false,
  onChange,
}: {
  label: string;
  value: number;
  min?: number | undefined;
  max?: number | undefined;
  invalid?: boolean | undefined;
  onChange: (next: number) => void;
}): ReactElement {
  // A cleared field has to stay cleared while focused, or typing "1." snaps back to "1".
  const [blank, setBlank] = useState(false);

  return (
    <fieldset className="leveling-stepper" onBlur={() => setBlank(false)}>
      <NumberStepper
        label={label}
        value={blank ? null : value}
        min={min}
        max={max}
        step={XP_MULTIPLIER_STEP}
        unit="×"
        width={104}
        invalid={invalid}
        onChange={(next) => {
          setBlank(next === null);
          if (next !== null) onChange(tidyMultiplier(next));
        }}
      />
    </fieldset>
  );
}

function channelCoverage(type: number): string | undefined {
  if (type === CHANNEL_TYPE.category) {
    return 'Covers every channel in this category, and their threads.';
  }
  if (type === CHANNEL_TYPE.forum || type === CHANNEL_TYPE.media) return 'Covers every post in it.';
  if (type === CHANNEL_TYPE.voice || type === CHANNEL_TYPE.stage) {
    return 'Covers time in this channel and messages in its chat.';
  }
  if (type === CHANNEL_TYPE.text || type === CHANNEL_TYPE.announcement) {
    return 'Covers its threads too.';
  }
  return undefined;
}

function MultiplierRung({
  glyph,
  name,
  coverage,
  label,
  removeLabel,
  multiplier,
  idError,
  multiplierError,
  onChange,
  onRemove,
}: {
  glyph: ReactNode;
  name: ReactNode;
  coverage: string | undefined;
  label: string;
  removeLabel: string;
  multiplier: number;
  idError: string | undefined;
  multiplierError: string | undefined;
  onChange: (multiplier: number) => void;
  onRemove: () => void;
}): ReactElement {
  const error = idError ?? multiplierError;

  return (
    <div>
      <div className={cx('rung', error !== undefined && 'invalid')}>
        <span className="rung-index">{glyph}</span>
        <div className="rung-body">
          <span className="stack">
            <span>{name}</span>
            {coverage !== undefined ? <span className="text-muted text-sm">{coverage}</span> : null}
          </span>
        </div>
        <span className="rung-aside">
          <MultiplierStepper
            label={label}
            value={multiplier}
            invalid={multiplierError !== undefined}
            onChange={onChange}
          />
          <IconButton icon="x" tone="ghost" size="sm" label={removeLabel} onClick={onRemove} />
        </span>
      </div>

      {error !== undefined ? (
        <p className="rung-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ComposerRung({
  picker,
  multiplier,
  multiplierLabel,
  taken,
  takenNote,
  canAdd,
  onMultiplier,
  onCancel,
  onAdd,
}: {
  picker: ReactNode;
  multiplier: number;
  multiplierLabel: string;
  taken: boolean;
  takenNote: string;
  canAdd: boolean;
  onMultiplier: (multiplier: number) => void;
  onCancel: () => void;
  onAdd: () => void;
}): ReactElement {
  return (
    <div>
      <div className={cx('rung', taken && 'invalid')}>
        <span className="rung-index">+</span>
        <div className="rung-body">
          {picker}
          <span className="rung-connector">earns</span>
          <MultiplierStepper label={multiplierLabel} value={multiplier} onChange={onMultiplier} />
        </div>
        <span className="rung-aside">
          <Button tone="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button tone="primary" size="sm" disabled={!canAdd || taken} onClick={onAdd}>
            Add
          </Button>
        </span>
      </div>

      {taken ? (
        <p className="rung-error" role="alert">
          {takenNote}
        </p>
      ) : null}
    </div>
  );
}

function RoleComposer({
  guildId,
  taken,
  onCancel,
  onAdd,
}: {
  guildId: string;
  taken: ReadonlySet<string>;
  onCancel: () => void;
  onAdd: (entry: RoleMultiplier) => void;
}): ReactElement {
  const [roleId, setRoleId] = useState<string | null>(null);
  const [multiplier, setMultiplier] = useState(DEFAULT_MULTIPLIER);

  const candidate = roleMultiplierSchema.safeParse({ roleId, multiplier });

  return (
    <ComposerRung
      picker={
        <RolePicker
          guildId={guildId}
          label="New multiplier role"
          placeholder="Choose a role"
          allowNone={false}
          requireAssignable={false}
          includeEveryone
          width={236}
          value={roleId}
          onChange={setRoleId}
        />
      }
      multiplier={multiplier}
      multiplierLabel="New role multiplier"
      taken={roleId !== null && taken.has(roleId)}
      takenNote={ROLE_TAKEN}
      canAdd={candidate.success}
      onMultiplier={setMultiplier}
      onCancel={onCancel}
      onAdd={() => {
        if (candidate.success) onAdd(candidate.data);
      }}
    />
  );
}

function ChannelComposer({
  guildId,
  taken,
  onCancel,
  onAdd,
}: {
  guildId: string;
  taken: ReadonlySet<string>;
  onCancel: () => void;
  onAdd: (entry: ChannelMultiplier) => void;
}): ReactElement {
  const [channelId, setChannelId] = useState<string | null>(null);
  const [multiplier, setMultiplier] = useState(DEFAULT_MULTIPLIER);

  const candidate = channelMultiplierSchema.safeParse({ channelId, multiplier });

  return (
    <ComposerRung
      picker={
        <ChannelPicker
          guildId={guildId}
          label="New multiplier channel"
          placeholder="Choose a channel or category"
          allowNone={false}
          types={MULTIPLIER_CHANNEL_TYPES}
          width={236}
          value={channelId}
          onChange={setChannelId}
        />
      }
      multiplier={multiplier}
      multiplierLabel="New channel multiplier"
      taken={channelId !== null && taken.has(channelId)}
      takenNote={CHANNEL_TAKEN}
      canAdd={candidate.success}
      onMultiplier={setMultiplier}
      onCancel={onCancel}
      onAdd={() => {
        if (candidate.success) onAdd(candidate.data);
      }}
    />
  );
}

function RoleMultipliers({
  guildId,
  form,
}: {
  guildId: string;
  form: ModuleForm<LevelingConfig>;
}): ReactElement {
  const entries = form.value.roleMultipliers;
  const [composing, setComposing] = useState(false);

  const roles = useQuery({ ...rolesQuery(guildId), enabled: entries.length > 0 });
  const rolesPending = entries.length > 0 && roles.isPending && !roles.isError;
  const byId = new Map((roles.data ?? []).map((role) => [role.id, role]));

  const setEntries = (next: readonly RoleMultiplier[]): void =>
    form.setValue((current) => ({ ...current, roleMultipliers: [...next] }));

  const full = entries.length >= XP_MULTIPLIER_LIST_MAX;
  const listError = form.errorAt('roleMultipliers');

  const addButton = (
    <Button tone="primary" size="sm" icon="plus" onClick={() => setComposing(true)}>
      Add role
    </Button>
  );

  return (
    <div>
      <CollectionHeader
        title="Role multipliers"
        used={entries.length}
        ceiling={XP_MULTIPLIER_LIST_MAX}
        limitLabel="role multipliers"
        actions={entries.length > 0 && !full && !composing ? addButton : null}
      />

      {listError !== undefined ? (
        <p className="row-error" role="alert">
          {listError}
        </p>
      ) : null}

      {roles.isError ? (
        <StatusBanner tone="danger" live="polite">
          {readFailure(roles.error, 'this server’s roles')}
        </StatusBanner>
      ) : null}

      {entries.length === 0 && !composing ? (
        <EmptyState inset title="No role multipliers" actions={addButton}>
          {NO_ROLE_MULTIPLIERS}
        </EmptyState>
      ) : (
        <div className="ladder">
          {entries.map((entry, at) => {
            const role = byId.get(entry.roleId);
            const lookup = lookupState(role !== undefined, rolesPending, roles.isError);
            const everyone = entry.roleId === guildId;

            return (
              <MultiplierRung
                key={entry.roleId}
                glyph={<span className="role-swatch" style={{ background: roleColour(role) }} />}
                name={
                  role ? (
                    role.name
                  ) : lookup === 'loading' ? (
                    <Spinner label="Loading role" />
                  ) : (
                    <span className="mono text-muted">{entry.roleId}</span>
                  )
                }
                coverage={
                  lookup === 'missing'
                    ? ROLE_MISSING
                    : everyone
                      ? 'Every member has this role.'
                      : undefined
                }
                label={`${role?.name ?? 'Role'} multiplier`}
                removeLabel={`Remove ${role?.name ?? 'role'} multiplier`}
                multiplier={entry.multiplier}
                idError={form.errorAt(`roleMultipliers.${at}.roleId`)}
                multiplierError={form.errorAt(`roleMultipliers.${at}.multiplier`)}
                onChange={(multiplier) =>
                  setEntries(
                    entries.map((current, position) =>
                      position === at ? { ...current, multiplier } : current,
                    ),
                  )
                }
                onRemove={() => setEntries(entries.filter((_, position) => position !== at))}
              />
            );
          })}

          {composing ? (
            <RoleComposer
              guildId={guildId}
              taken={new Set(entries.map((entry) => entry.roleId))}
              onCancel={() => setComposing(false)}
              onAdd={(entry) => {
                setEntries([...entries, entry]);
                setComposing(false);
              }}
            />
          ) : null}
        </div>
      )}

      {full ? <p className="leveling-note">{ROLE_MULTIPLIERS_FULL}</p> : null}
    </div>
  );
}

function ChannelMultipliers({
  guildId,
  form,
}: {
  guildId: string;
  form: ModuleForm<LevelingConfig>;
}): ReactElement {
  const entries = form.value.channelMultipliers;
  const [composing, setComposing] = useState(false);
  const channels = useChannelIndex(guildId);

  const setEntries = (next: readonly ChannelMultiplier[]): void =>
    form.setValue((current) => ({ ...current, channelMultipliers: [...next] }));

  const full = entries.length >= XP_MULTIPLIER_LIST_MAX;
  const listError = form.errorAt('channelMultipliers');

  const addButton = (
    <Button tone="primary" size="sm" icon="plus" onClick={() => setComposing(true)}>
      Add channel
    </Button>
  );

  return (
    <div>
      <CollectionHeader
        title="Channel multipliers"
        used={entries.length}
        ceiling={XP_MULTIPLIER_LIST_MAX}
        limitLabel="channel multipliers"
        actions={entries.length > 0 && !full && !composing ? addButton : null}
      />

      {listError !== undefined ? (
        <p className="row-error" role="alert">
          {listError}
        </p>
      ) : null}

      {entries.length > 0 && channels.error !== null ? (
        <StatusBanner tone="danger" live="polite">
          {readFailure(channels.error, 'this server’s channels')}
        </StatusBanner>
      ) : null}

      {entries.length === 0 && !composing ? (
        <EmptyState inset title="No channel multipliers" actions={addButton}>
          {NO_CHANNEL_MULTIPLIERS}
        </EmptyState>
      ) : (
        <div className="ladder">
          {entries.map((entry, at) => {
            const channel = channels.byId.get(entry.channelId);
            const lookup = lookupState(
              channel !== undefined,
              channels.pending,
              channels.error !== null,
            );

            return (
              <MultiplierRung
                key={entry.channelId}
                glyph={<Icon name={channel ? channelIcon(channel.type) : 'hash'} size={13} />}
                name={
                  channel ? (
                    channel.name
                  ) : lookup === 'loading' ? (
                    <Spinner label="Loading channel" />
                  ) : (
                    <span className="mono text-muted">{entry.channelId}</span>
                  )
                }
                coverage={
                  channel
                    ? channelCoverage(channel.type)
                    : lookup === 'missing'
                      ? CHANNEL_MISSING
                      : undefined
                }
                label={`${channel?.name ?? 'Channel'} multiplier`}
                removeLabel={`Remove ${channel?.name ?? 'channel'} multiplier`}
                multiplier={entry.multiplier}
                idError={form.errorAt(`channelMultipliers.${at}.channelId`)}
                multiplierError={form.errorAt(`channelMultipliers.${at}.multiplier`)}
                onChange={(multiplier) =>
                  setEntries(
                    entries.map((current, position) =>
                      position === at ? { ...current, multiplier } : current,
                    ),
                  )
                }
                onRemove={() => setEntries(entries.filter((_, position) => position !== at))}
              />
            );
          })}

          {composing ? (
            <ChannelComposer
              guildId={guildId}
              taken={new Set(entries.map((entry) => entry.channelId))}
              onCancel={() => setComposing(false)}
              onAdd={(entry) => {
                setEntries([...entries, entry]);
                setComposing(false);
              }}
            />
          ) : null}
        </div>
      )}

      {full ? <p className="leveling-note">{CHANNEL_MULTIPLIERS_FULL}</p> : null}
    </div>
  );
}

function ExcludedChannels({
  guildId,
  value,
  onChange,
}: {
  guildId: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
}): ReactElement {
  return (
    <ChannelMultiPicker
      guildId={guildId}
      value={value}
      onChange={onChange}
      types={EARNING_CHANNEL_TYPES}
      max={EXCLUSION_MAX}
      label="Add excluded channel"
    />
  );
}

export function EarningArea({
  guildId,
  form,
}: {
  guildId: string;
  form: ModuleForm<LevelingConfig>;
}): ReactElement {
  const config = form.value;

  const minError = form.errorAt('xpPerMessageMin');
  const maxError = form.errorAt('xpPerMessageMax');
  const cooldownError = form.errorAt('messageCooldown');
  const voiceError = form.errorAt('voiceXpPerMinute');

  return (
    <>
      <Section
        label="Messages"
        note={
          config.xpPerMessageMin === 0 && config.xpPerMessageMax === 0 ? NO_MESSAGE_XP : undefined
        }
      >
        <Rows>
          <SettingRow
            title="Minimum XP per message"
            description="Each message earns a random amount of XP between the minimum and maximum."
            error={minError}
          >
            <NumberStepper
              label="Minimum XP per message"
              value={config.xpPerMessageMin}
              min={0}
              max={XP_PER_MESSAGE_MAX}
              invalid={minError !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({
                  ...current,
                  xpPerMessageMin: next ?? current.xpPerMessageMin,
                }))
              }
            />
          </SettingRow>

          <SettingRow title="Maximum XP per message" error={maxError}>
            <NumberStepper
              label="Maximum XP per message"
              value={config.xpPerMessageMax}
              min={0}
              max={XP_PER_MESSAGE_MAX}
              invalid={maxError !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({
                  ...current,
                  xpPerMessageMax: next ?? current.xpPerMessageMax,
                }))
              }
            />
          </SettingRow>

          <SettingRow title="Message cooldown" error={cooldownError} note={COOLDOWN_NOTE}>
            <DurationInput
              label="Message cooldown"
              value={config.messageCooldown}
              invalid={cooldownError !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, messageCooldown: next }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Voice">
        <Rows>
          <SettingRow
            title="Voice XP"
            description="XP earned for each minute in voice. Proton adds it when the member leaves the channel."
            error={voiceError}
            note={config.voiceXpPerMinute === 0 ? NO_VOICE_XP : undefined}
          >
            <NumberStepper
              label="Voice XP"
              value={config.voiceXpPerMinute}
              min={0}
              max={VOICE_XP_MAX}
              invalid={voiceError !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({
                  ...current,
                  voiceXpPerMinute: next ?? current.voiceXpPerMinute,
                }))
              }
            />
          </SettingRow>

          <SettingRow title="AFK channel" error={form.errorAt('afkChannelId')} note={AFK_NOTE}>
            <ChannelPicker
              guildId={guildId}
              label="AFK channel"
              placeholder="No AFK channel"
              noneLabel="No AFK channel"
              types={AFK_CHANNEL_TYPES}
              value={config.afkChannelId ?? null}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, afkChannelId: next ?? undefined }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Exclusions" intro={EXCLUSIONS_INTRO}>
        <Rows>
          <SettingRow
            title="Excluded channels"
            description="Messages in these channels earn no XP."
            stacked
            error={form.errorAt('excludedChannelIds')}
            note={config.excludedChannelIds.length >= EXCLUSION_MAX ? CHANNELS_FULL : undefined}
          >
            <ExcludedChannels
              guildId={guildId}
              value={config.excludedChannelIds}
              onChange={(excludedChannelIds) =>
                form.setValue((current) => ({ ...current, excludedChannelIds }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Excluded roles"
            description="Members with any of these roles earn no XP from messages."
            stacked
            error={form.errorAt('excludedRoleIds')}
          >
            <RoleMultiPicker
              guildId={guildId}
              label="Excluded roles"
              max={EXCLUSION_MAX}
              value={config.excludedRoleIds}
              onChange={(excludedRoleIds) =>
                form.setValue((current) => ({ ...current, excludedRoleIds }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Multipliers" intro={MULTIPLIER_RULE}>
        <div className="stack stack-20">
          <RoleMultipliers guildId={guildId} form={form} />
          <ChannelMultipliers guildId={guildId} form={form} />
        </div>

        <p className="leveling-note">{MULTIPLIER_SCOPE}</p>
      </Section>
    </>
  );
}
