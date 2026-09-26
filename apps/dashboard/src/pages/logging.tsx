import { MESSAGE_CACHE_MAX_TTL_MS, MESSAGE_CACHE_MIN_TTL_MS } from '@proton/core';
import { loggingConfigSchema, MESSAGE_LOG_RETENTION_DAYS } from '@proton/module-logging/config';
import type { ReactElement } from 'react';
import { CHANNEL_TYPE, ChannelMultiPicker } from '../components/discord/channel-picker.tsx';
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
import { LimitCounter } from '../components/ui/collection.tsx';
import { Switch } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';

const IGNORED_CHANNEL_MAX = 50;

const LOGGABLE_CHANNEL_TYPES = [
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.announcement,
  CHANNEL_TYPE.publicThread,
  CHANNEL_TYPE.privateThread,
];

function IgnoredChannels({
  guildId,
  value,
  onChange,
}: {
  guildId: string;
  value: readonly string[];
  onChange: (channelIds: string[]) => void;
}): ReactElement {
  return (
    <ChannelMultiPicker
      guildId={guildId}
      value={value}
      onChange={onChange}
      types={LOGGABLE_CHANNEL_TYPES}
      max={IGNORED_CHANNEL_MAX}
      label="Add ignored channel"
    />
  );
}

export default function LoggingPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: loggingConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;
  const config = form.value;
  const retentionError = form.errorAt('cacheRetention');

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
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        offNote="Settings are saved, but no new messages are stored until you turn it on."
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

      <Section label="Recent message text">
        <Rows>
          <SettingRow
            title="Remember recent message text"
            description="Stores the text, author and attachment links of recent messages, so edit and delete logs can show what changed and who wrote it."
            help="Discord doesn’t send the old text of an edited message, or the text and author of a deleted one. Without this, logs can’t show them."
            note="Turning this off deletes everything already remembered when you save."
            error={form.errorAt('cacheMessageContent')}
          >
            <Switch
              label="Remember recent message text"
              checked={config.cacheMessageContent}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, cacheMessageContent: next }))
              }
            />
          </SettingRow>

          {config.cacheMessageContent ? (
            <SettingRow
              title="Remember for"
              description="From 1 hour to 7 days."
              help="Anything outside that range uses the nearest limit. With Server Logs on, an edited message is remembered for a day from its latest edit."
              error={retentionError}
            >
              <DurationInput
                label="Remember for"
                value={config.cacheRetention}
                min={MESSAGE_CACHE_MIN_TTL_MS}
                max={MESSAGE_CACHE_MAX_TTL_MS}
                units={['h', 'd']}
                invalid={retentionError !== undefined}
                onChange={(next) =>
                  form.setValue((current) => ({ ...current, cacheRetention: next }))
                }
              />
            </SettingRow>
          ) : null}
        </Rows>
      </Section>

      <Section label="Archive" note={`Kept for ${MESSAGE_LOG_RETENTION_DAYS} days`}>
        <Rows>
          <SettingRow
            title="Log edits"
            description="Archive the new text of each edit, and the old text while Proton still remembers the message."
            error={form.errorAt('logEdits')}
          >
            <Switch
              label="Log edits"
              checked={config.logEdits}
              onChange={(next) => form.setValue((current) => ({ ...current, logEdits: next }))}
            />
          </SettingRow>

          <SettingRow
            title="Log deletions"
            description="Archive each deleted message, including bulk deletions, with its text while Proton still remembers it."
            error={form.errorAt('logDeletes')}
          >
            <Switch
              label="Log deletions"
              checked={config.logDeletes}
              onChange={(next) => form.setValue((current) => ({ ...current, logDeletes: next }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Exemptions">
        <Rows>
          <SettingRow
            stacked
            title="Ignored channels"
            description="Messages in these channels are never archived or remembered."
            badge={
              <LimitCounter
                used={config.ignoredChannels.length}
                ceiling={IGNORED_CHANNEL_MAX}
                label="ignored channels"
              />
            }
            error={form.errorAt('ignoredChannels')}
          >
            <IgnoredChannels
              guildId={guildId}
              value={config.ignoredChannels}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, ignoredChannels: next }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

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
