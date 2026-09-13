import {
  AFTER_STRIP_ACTIONS,
  type AfterStripAction,
  type AntinukeConfig,
  antinukeConfigSchema,
} from '@proton/module-antinuke/config';
import type { ReactElement } from 'react';
import { CHANNEL_TYPE, ChannelPicker } from '../components/discord/channel-picker.tsx';
import { DurationInput, humaniseDuration } from '../components/discord/inputs.tsx';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { NumberStepper, Select } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { ACTION_LABELS } from '../lib/enum-labels.ts';
import { ProtectionState } from './antinuke/protection.tsx';

const LIMIT_MIN = 2;
const LIMIT_MAX = 100;

type LimitPath = Extract<keyof AntinukeConfig, `${string}Limit`>;
type WindowPath = Extract<keyof AntinukeConfig, `${string}Window`>;

interface Threshold {
  readonly name: string;
  readonly limit: LimitPath;
  readonly window: WindowPath;
  readonly windowLabel: string;
}

// NUKE_CLASSES order, transcribed: the module's ./classes subpath is not exported and its barrel
// drags ioredis into the browser bundle.
const THRESHOLDS: readonly Threshold[] = [
  {
    name: 'Channel deletions',
    limit: 'channelDeleteLimit',
    window: 'channelDeleteWindow',
    windowLabel: 'Channel deletion window',
  },
  {
    name: 'Role deletions',
    limit: 'roleDeleteLimit',
    window: 'roleDeleteWindow',
    windowLabel: 'Role deletion window',
  },
  {
    name: 'Webhook deletions',
    limit: 'webhookDeleteLimit',
    window: 'webhookDeleteWindow',
    windowLabel: 'Webhook deletion window',
  },
  {
    name: 'Emoji deletions',
    limit: 'emojiDeleteLimit',
    window: 'emojiDeleteWindow',
    windowLabel: 'Emoji deletion window',
  },
  {
    name: 'Bans and kicks',
    limit: 'memberRemoveLimit',
    window: 'memberRemoveWindow',
    windowLabel: 'Ban and kick window',
  },
];

// ACTION_LABELS.none would contradict the row above it: the roles come off either way.
const AFTER_STRIP_LABELS: Record<AfterStripAction, string> = {
  none: 'Nothing further',
  kick: ACTION_LABELS.kick,
  ban: ACTION_LABELS.ban,
};

const AFTER_STRIP_OPTIONS = AFTER_STRIP_ACTIONS.map((value) => ({
  value,
  label: AFTER_STRIP_LABELS[value],
}));

const AFTER_STRIP_OUTCOME: Record<AfterStripAction, string> = {
  none: 'Roles are removed and moderators are alerted. Nothing irreversible happens.',
  kick: 'Roles are removed, then the member is kicked.',
  ban: 'Roles are removed, then the member is banned.',
};

const MAINTENANCE_COMMANDS: readonly { name: string; description: string }[] = [
  {
    name: '/antinuke maintenance',
    description: 'Start maintenance mode for a set time.',
  },
  { name: '/antinuke resume', description: 'End maintenance mode now.' },
  {
    name: '/antinuke status',
    description: 'Show whether protection is on, and the current limits.',
  },
];

export default function AntinukePage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: antinukeConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;
  const config = form.value;

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

      <ModuleBanners
        guildId={guildId}
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}

        {!enabled ? (
          <StatusBanner tone="neutral">
            {meta.label} is switched off. Settings are saved, but nothing runs until you switch it
            on.
          </StatusBanner>
        ) : null}

        <ProtectionState guildId={guildId} enabled={enabled} />
      </ModuleBanners>

      <Section
        label="Maintenance mode"
        intro="Maintenance mode pauses Anti-Nuke for a set time during bulk changes. End it early from the banner above."
      >
        <Rows>
          <SettingRow
            title="Longest maintenance window"
            description="Maintenance mode leaves the server unprotected for up to this long."
            error={form.errorAt('maintenanceMaxDuration')}
            note={`Requests longer than ${humaniseDuration(config.maintenanceMaxDuration)} are refused. While protection is paused, nothing stops a compromised account from emptying the server.`}
          >
            <DurationInput
              label="Longest maintenance window"
              value={config.maintenanceMaxDuration}
              invalid={form.errorAt('maintenanceMaxDuration') !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, maintenanceMaxDuration: next }))
              }
            />
          </SettingRow>
        </Rows>

        <div className="antinuke-commands">
          {MAINTENANCE_COMMANDS.map((command) => (
            <p className="antinuke-command" key={command.name}>
              <span className="mono">{command.name}</span>
              <span>{command.description}</span>
            </p>
          ))}
        </div>

        <p className="antinuke-help">All three need Manage Server.</p>
      </Section>

      <Section
        label="Thresholds"
        intro="Proton reads the audit log and acts when one member reaches any of these limits within its window. Actions Proton takes are never counted."
      >
        <div className="matrix">
          <div className="antinuke-threshold antinuke-threshold-head" aria-hidden="true">
            <span className="antinuke-threshold-name" />
            <div className="antinuke-threshold-controls">
              <span className="antinuke-threshold-cap">Limit</span>
              <span className="antinuke-threshold-per" />
              <span className="antinuke-threshold-cap antinuke-threshold-cap-window">Window</span>
            </div>
          </div>

          {THRESHOLDS.map((threshold) => {
            const limitError = form.errorAt(threshold.limit);
            const windowError = form.errorAt(threshold.window);

            return (
              <div className="antinuke-threshold" key={threshold.limit}>
                <span className="antinuke-threshold-name">{threshold.name}</span>

                <div className="antinuke-threshold-controls">
                  <div className="antinuke-threshold-cell">
                    <NumberStepper
                      label={threshold.name}
                      value={config[threshold.limit]}
                      min={LIMIT_MIN}
                      max={LIMIT_MAX}
                      width={96}
                      invalid={limitError !== undefined}
                      onChange={(next) => form.set(threshold.limit, next)}
                    />
                    {limitError !== undefined ? (
                      <p className="antinuke-threshold-error" role="alert">
                        {limitError}
                      </p>
                    ) : null}
                  </div>

                  <span className="antinuke-threshold-per">per</span>

                  <div className="antinuke-threshold-cell">
                    <DurationInput
                      label={threshold.windowLabel}
                      value={config[threshold.window]}
                      invalid={windowError !== undefined}
                      onChange={(next) => form.set(threshold.window, next)}
                    />
                    {windowError !== undefined ? (
                      <p className="antinuke-threshold-error" role="alert">
                        {windowError}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        label="Response"
        intro="Proton removes all of the member’s roles, highest first. Each removal is recorded as a case with the full role list, so the roles can be restored exactly. If the server owner reaches a limit, Proton only reports it."
      >
        <Rows>
          <SettingRow
            title="After stripping roles"
            description="Roles are always removed first, whatever this is set to."
            error={form.errorAt('afterStrip')}
            note={AFTER_STRIP_OUTCOME[config.afterStrip]}
          >
            <Select
              aria-label="After stripping roles"
              width="lg"
              options={AFTER_STRIP_OPTIONS}
              invalid={form.errorAt('afterStrip') !== undefined}
              value={config.afterStrip}
              onChange={(value) =>
                form.setValue((current) => ({
                  ...current,
                  afterStrip: value as AfterStripAction,
                }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section
        label="Alerts"
        intro="Proton posts one alert each time Anti-Nuke is triggered: what it detected, whose roles it removed, what it did next and anything that failed."
      >
        <Rows>
          <SettingRow
            title="Alert channel"
            error={form.errorAt('alertChannelId')}
            note={
              config.alertChannelId === undefined
                ? 'No alert channel is set, so Anti-Nuke actions are recorded only in Proton’s logs.'
                : undefined
            }
          >
            <ChannelPicker
              guildId={guildId}
              label="Alert channel"
              noneLabel="No alert channel"
              types={[CHANNEL_TYPE.text, CHANNEL_TYPE.announcement]}
              invalid={form.errorAt('alertChannelId') !== undefined}
              value={config.alertChannelId ?? null}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, alertChannelId: next ?? undefined }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <SaveBar dirty={form.dirty} saving={form.saving} onSave={form.save} onReset={form.reset} />
    </>
  );
}
