import {
  DEFAULT_CLAIM_WINDOW_SECONDS,
  type GiveawaysConfig,
  giveawaysConfigSchema,
  ROLE_LIST_MAX,
  WINNER_COUNT_MAX,
} from '@proton/module-giveaways/config';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { ChannelPicker } from '../components/discord/channel-picker.tsx';
import { ColourPicker } from '../components/discord/inputs.tsx';
import { RoleMultiPicker } from '../components/discord/role-picker.tsx';
import type { ModuleForm } from '../components/module/form.ts';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { LimitCounter } from '../components/ui/collection.tsx';
import { NumberStepper, SegmentedControl, Switch } from '../components/ui/controls.tsx';
import { EmptyState, LoadingBoundary, StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { AreaTabs } from '../components/ui/tabs.tsx';

type Form = ModuleForm<GiveawaysConfig>;

type ClaimUnit = 'minutes' | 'hours' | 'days';

const CLAIM_UNIT_SECONDS: Record<ClaimUnit, number> = {
  minutes: 60,
  hours: 60 * 60,
  days: 24 * 60 * 60,
};

const CLAIM_UNITS: readonly { value: ClaimUnit; label: string }[] = [
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
  { value: 'days', label: 'Days' },
];

const CLAIM_MIN_SECONDS = 60;
const CLAIM_MAX_SECONDS = 7 * 24 * 60 * 60;

const ACCESS_INTRO = 'These roles apply to every giveaway, including ones already running.';

const NEW_GIVEAWAYS_ONLY = 'Applies to giveaways started after you change it.';

const CLAIM_HELP =
  'Off by default, because a timed reroll can take a prize from a winner who was asleep. ' +
  NEW_GIVEAWAYS_ONLY;

const WARNING_HELP =
  'Proton posts here, mentioning the host, when a draw skips a requirement because its module ' +
  'is off, when it can’t check every entrant, or when a winner can’t be given the reward role.';

function claimUnitFor(seconds: number): ClaimUnit {
  if (seconds % CLAIM_UNIT_SECONDS.days === 0) return 'days';
  if (seconds % CLAIM_UNIT_SECONDS.hours === 0) return 'hours';
  return 'minutes';
}

function claimUnitFits(seconds: number, unit: ClaimUnit): boolean {
  const size = CLAIM_UNIT_SECONDS[unit];
  if (seconds % size !== 0) return false;

  const amount = seconds / size;
  return (
    amount >= Math.ceil(CLAIM_MIN_SECONDS / size) && amount <= Math.floor(CLAIM_MAX_SECONDS / size)
  );
}

function claimBoundsError(seconds: number): string | undefined {
  if (!Number.isInteger(seconds)) return 'Use a whole number.';
  if (seconds < CLAIM_MIN_SECONDS) return 'At least 1 minute.';
  if (seconds > CLAIM_MAX_SECONDS) return 'At most 7 days.';
  return undefined;
}

function GiveawayList(): ReactElement {
  return (
    <div className="giveaways-empty">
      <EmptyState icon="gift" title="Giveaways run in Discord">
        Start one with <code className="mono">/giveaway create</code>.{' '}
        <code className="mono">/giveaway list</code> shows what’s running, and{' '}
        <code className="mono">/giveaway info</code> shows one in detail.
      </EmptyState>
    </div>
  );
}

function ClaimWindowRows({ form }: { form: Form }): ReactElement {
  const seconds = form.value.claimWindowSeconds;
  const on = seconds !== undefined;

  const [unit, setUnit] = useState<ClaimUnit>(() =>
    claimUnitFor(seconds ?? DEFAULT_CLAIM_WINDOW_SECONDS),
  );

  const size = CLAIM_UNIT_SECONDS[unit];
  const minAmount = Math.ceil(CLAIM_MIN_SECONDS / size);
  const maxAmount = Math.floor(CLAIM_MAX_SECONDS / size);

  const write = (next: number | undefined): void =>
    form.setValue((current) => ({ ...current, claimWindowSeconds: next }));

  const error = on
    ? (form.errorAt('claimWindowSeconds') ?? claimBoundsError(seconds))
    : form.errorAt('claimWindowSeconds');

  return (
    <>
      <SettingRow
        title="Claim window"
        description="Winners must claim in time. Unclaimed wins are forfeited and rerolled."
        help={CLAIM_HELP}
      >
        <Switch
          checked={on}
          label="Require winners to claim their prize"
          onChange={(checked) => {
            if (!checked) {
              write(undefined);
              return;
            }
            setUnit(claimUnitFor(DEFAULT_CLAIM_WINDOW_SECONDS));
            write(DEFAULT_CLAIM_WINDOW_SECONDS);
          }}
        />
      </SettingRow>

      {on ? (
        <SettingRow title="Time to claim" note="Between 1 minute and 7 days." error={error}>
          <div className="inline inline-8 inline-wrap">
            <NumberStepper
              label="Time to claim"
              value={Math.round(seconds / size)}
              min={minAmount}
              max={maxAmount}
              invalid={error !== undefined}
              onChange={(next) => {
                if (next === null) return;
                write(next * size);
              }}
            />
            <SegmentedControl
              label="Time to claim unit"
              options={CLAIM_UNITS.map((option) => ({
                ...option,
                disabled: option.value !== unit && !claimUnitFits(seconds, option.value),
              }))}
              value={unit}
              onChange={setUnit}
            />
          </div>
        </SettingRow>
      ) : null}
    </>
  );
}

function Defaults({ form, guildId }: { form: Form; guildId: string }): ReactElement {
  const winnersError = form.errorAt('defaultWinnerCount');

  return (
    <>
      <Section label="Defaults">
        <Rows>
          <SettingRow
            title="Default number of winners"
            help="Used by /giveaway start when no number of winners is given, and as the starting number in /giveaway create."
            error={winnersError}
          >
            <NumberStepper
              label="Default number of winners"
              value={form.value.defaultWinnerCount}
              min={1}
              max={WINNER_COUNT_MAX}
              invalid={winnersError !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({
                  ...current,
                  defaultWinnerCount: next ?? current.defaultWinnerCount,
                }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Accent colour"
            description="The stripe colour on giveaway messages."
            help="Giveaways given their own colour in /giveaway create or /giveaway edit keep it."
            error={form.errorAt('embedColor')}
          >
            <ColourPicker
              label="Accent colour"
              value={form.value.embedColor}
              onChange={(next) => form.setValue((current) => ({ ...current, embedColor: next }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Results">
        <Rows>
          <SettingRow
            title="Announce winners"
            description="Post the result in the giveaway’s channel and ping the winners."
            help="With a claim window on, winners claim from this message, so turning it off leaves them no way to claim."
            error={form.errorAt('announceInChannel')}
          >
            <Switch
              checked={form.value.announceInChannel}
              label="Announce winners"
              onChange={(checked) =>
                form.setValue((current) => ({ ...current, announceInChannel: checked }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Send winners a DM"
            help={`${NEW_GIVEAWAYS_ONLY} Winners with DMs closed are skipped.`}
            error={form.errorAt('dmWinners')}
          >
            <Switch
              checked={form.value.dmWinners}
              label="Send winners a DM"
              onChange={(checked) =>
                form.setValue((current) => ({ ...current, dmWinners: checked }))
              }
            />
          </SettingRow>

          <ClaimWindowRows form={form} />
        </Rows>
      </Section>

      <Section label="Warnings">
        <Rows>
          <SettingRow
            title="Warning channel"
            description="Where Proton warns hosts about problems with a draw. With no channel set, these warnings aren’t sent."
            help={WARNING_HELP}
            error={form.errorAt('logChannelId')}
          >
            <ChannelPicker
              guildId={guildId}
              label="Warning channel"
              noneLabel="No warning channel"
              placeholder="No warning channel"
              invalid={form.errorAt('logChannelId') !== undefined}
              value={form.value.logChannelId}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, logChannelId: next ?? undefined }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>
    </>
  );
}

function RoleListRow({
  form,
  guildId,
  path,
  title,
  description,
  help,
}: {
  form: Form;
  guildId: string;
  path: 'managerRoleIds' | 'bypassRoleIds' | 'blacklistRoleIds';
  title: string;
  description: string;
  help?: string | undefined;
}): ReactElement {
  const value = form.value[path];
  const error = form.errorAt(path);

  return (
    <SettingRow
      title={title}
      description={description}
      help={help}
      error={error}
      badge={
        value.length > 0 ? (
          <LimitCounter used={value.length} ceiling={ROLE_LIST_MAX} label="roles" />
        ) : undefined
      }
      stacked
    >
      <RoleMultiPicker
        guildId={guildId}
        label={title}
        value={value}
        max={ROLE_LIST_MAX}
        invalid={error !== undefined}
        onChange={(next) => form.setValue((current) => ({ ...current, [path]: next }))}
      />
    </SettingRow>
  );
}

function Access({ form, guildId }: { form: Form; guildId: string }): ReactElement {
  return (
    <Section label="Roles" intro={ACCESS_INTRO}>
      <Rows>
        <RoleListRow
          form={form}
          guildId={guildId}
          path="managerRoleIds"
          title="Manager roles"
          description="Can pause, edit, end, cancel and reroll any giveaway, not only their own."
          help="Who can use /giveaway at all is set under Permissions."
        />
        <RoleListRow
          form={form}
          guildId={guildId}
          path="bypassRoleIds"
          title="Bypass roles"
          description="Skip requirements when entering a giveaway. Bonus entries still apply."
        />
        <RoleListRow
          form={form}
          guildId={guildId}
          path="blacklistRoleIds"
          title="Blacklisted roles"
          description="Can’t enter any giveaway, even with a bypass role."
        />
      </Rows>
    </Section>
  );
}

export default function GiveawaysPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: giveawaysConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;

  return (
    <>
      <ModuleHeader
        meta={meta}
        actions={
          <ModuleSwitch
            name={meta.label}
            enabled={enabled}
            state={summary ? moduleState(summary) : 'off'}
            busy={toggle.busy}
            onToggle={toggle.toggle}
          />
        }
      />

      <AreaTabs guildId={guildId} moduleId={meta.id} areas={meta.areas ?? []} current={area} />

      <ModuleBanners
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        offNote="Settings are saved, but nobody can start or enter giveaways until you turn it on. Giveaways that end in the meantime are drawn shortly after you turn it back on."
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      <LoadingBoundary key={area} label={`Loading ${meta.label}`} minHeight={280}>
        {area === 'list' ? <GiveawayList /> : null}
        {area === 'defaults' ? <Defaults form={form} guildId={guildId} /> : null}
        {area === 'access' ? <Access form={form} guildId={guildId} /> : null}
      </LoadingBoundary>

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        failures={form.failures}
        onSave={form.save}
        onReset={form.reset}
      />
    </>
  );
}
