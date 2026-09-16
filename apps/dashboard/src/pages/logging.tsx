import {
  clampCacheTtl,
  formatDuration,
  MESSAGE_CACHE_MAX_TTL_MS,
  MESSAGE_CACHE_MIN_TTL_MS,
  tryParseDuration,
} from '@proton/core';
import {
  loggingConfigSchema,
  MESSAGE_CACHE_FALLBACK_TTL_MS,
  MESSAGE_LOG_RETENTION_DAYS,
} from '@proton/module-logging/config';
import type { ReactElement, ReactNode } from 'react';
import { CHANNEL_TYPE, ChannelMultiPicker } from '../components/discord/channel-picker.tsx';
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
import { LimitCounter } from '../components/ui/collection.tsx';
import { cx, Switch } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';

const IGNORED_CHANNEL_MAX = 50;

const LOGGABLE_CHANNEL_TYPES = [
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.announcement,
  CHANNEL_TYPE.publicThread,
  CHANNEL_TYPE.privateThread,
];

function Store({
  name,
  figure,
  keeping,
  lede,
  children,
}: {
  name: string;
  figure: string;
  keeping: boolean;
  lede: ReactNode;
  children?: ReactNode;
}): ReactElement {
  return (
    <div className="logging-store">
      <div className="logging-store-rail">
        <span className="logging-store-name">{name}</span>
        <span className={cx('logging-store-figure', !keeping && 'empty')}>{figure}</span>
      </div>
      <div className="logging-store-body">
        <p className="logging-store-lede">{lede}</p>
        {children !== undefined ? <ul className="logging-outcomes">{children}</ul> : null}
      </div>
    </div>
  );
}

function Outcome({ kept, children }: { kept: boolean; children: ReactNode }): ReactElement {
  return (
    <li className={cx('logging-outcome', kept ? 'kept' : 'muted')}>
      <Icon name={kept ? 'check' : 'minus'} size={13} />
      <span>{children}</span>
    </li>
  );
}

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

  const requested = tryParseDuration(config.cacheRetention);
  const heldMs = requested === null ? MESSAGE_CACHE_FALLBACK_TTL_MS : clampCacheTtl(requested);
  const held = humaniseDuration(formatDuration(heldMs));
  const clamped = requested !== null && requested !== heldMs;

  const writing = enabled && (config.logEdits || config.logDeletes);
  const remembering = enabled && config.cacheMessageContent;
  const ignored = config.ignoredChannels.length;

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

      <Section
        label="Recent message text"
        intro={
          <>
            Enable to remember the text of recent messages, for up to {MESSAGE_LOG_RETENTION_DAYS} days
          </>
        }
      >
        <Rows>
          <SettingRow
            title="Remember recent message text"
            description={`Stores the text of recent messages in memory for up to ${MESSAGE_LOG_RETENTION_DAYS} days.`}
            note="Switching this off deletes everything already remembered when you save."
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
              description="How long each message is remembered, from 1 hour to 7 days. Anything outside that range uses the nearest limit."
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

      <Section label="Archive">
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
            description="Archive deleted messages, including bulk deletions."
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
