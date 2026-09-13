import { MAX_TIMEOUT_MS, tryParseDuration } from '@proton/core';
import {
  PHISHING_ACTIONS,
  type PhishingAction,
  phishingConfigSchema,
} from '@proton/module-phishing/config';
import type { ReactElement } from 'react';
import { CHANNEL_TYPE, ChannelPicker } from '../components/discord/channel-picker.tsx';
import { DurationInput } from '../components/discord/inputs.tsx';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { Select } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { ACTION_LABELS } from '../lib/enum-labels.ts';
import { DomainLists } from './phishing/domain-lists.tsx';

const ALERT_CHANNEL_TYPES = [
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.announcement,
  CHANNEL_TYPE.publicThread,
  CHANNEL_TYPE.privateThread,
];

const ACTION_OPTIONS = PHISHING_ACTIONS.map((value) => ({ value, label: ACTION_LABELS[value] }));

const SWITCHED_OFF = 'Settings are saved, but nothing runs until you switch it on.';

const RESPONSE_INTRO =
  'Proton never deletes the message itself. A ban also deletes the member’s messages from the ' +
  'last 24 hours.';

const NO_ALERT_CHANNEL =
  'No alert channel is set, so Proton still acts on the member, but nobody is told where the ' +
  'link was posted or which message is still up.';

export default function PhishingPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: phishingConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;
  const config = form.value;

  const timeoutMs = tryParseDuration(config.timeoutDuration);
  const clamped = timeoutMs !== null && timeoutMs > MAX_TIMEOUT_MS;

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
          <StatusBanner tone="neutral">{`${meta.label} is switched off. ${SWITCHED_OFF}`}</StatusBanner>
        ) : null}
      </ModuleBanners>

      <Section label="Response" intro={RESPONSE_INTRO}>
        <Rows>
          <SettingRow
            title="Action"
            description="What Proton does to the member who posted the link."
            error={form.errorAt('action')}
          >
            <Select
              aria-label="Action"
              width="lg"
              options={ACTION_OPTIONS}
              invalid={form.errorAt('action') !== undefined}
              value={config.action}
              onChange={(event) =>
                form.setValue((current) => ({
                  ...current,
                  action: event.currentTarget.value as PhishingAction,
                }))
              }
            />
          </SettingRow>

          {config.action === 'timeout' ? (
            <SettingRow
              title="Timeout duration"
              description="Discord caps timeouts at 28 days."
              error={form.errorAt('timeoutDuration')}
              note={clamped ? 'Discord applies anything longer as 28 days.' : undefined}
            >
              <DurationInput
                label="Timeout duration"
                value={config.timeoutDuration}
                invalid={form.errorAt('timeoutDuration') !== undefined}
                onChange={(next) =>
                  form.setValue((current) => ({ ...current, timeoutDuration: next }))
                }
              />
            </SettingRow>
          ) : null}

          <SettingRow
            title="Alert channel"
            description="Where Proton reports Phishing actions."
            error={form.errorAt('alertChannel')}
            note={config.alertChannel === undefined ? NO_ALERT_CHANNEL : undefined}
          >
            <ChannelPicker
              guildId={guildId}
              label="Alert channel"
              noneLabel="No alert channel"
              types={ALERT_CHANNEL_TYPES}
              invalid={form.errorAt('alertChannel') !== undefined}
              value={config.alertChannel ?? null}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, alertChannel: next ?? undefined }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <DomainLists value={config} onChange={form.setValue} errorAt={form.errorAt} />

      <SaveBar dirty={form.dirty} saving={form.saving} onSave={form.save} onReset={form.reset} />
    </>
  );
}
