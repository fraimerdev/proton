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
        subtitle={`Stores message content — personal data — for ${MESSAGE_LOG_RETENTION_DAYS} days`}
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

      <Section label="Stored data" note={form.dirty ? 'Includes unsaved changes.' : undefined}>
        <div className="logging-ledger">
          <Store
            name="Archive"
            figure={writing ? `${MESSAGE_LOG_RETENTION_DAYS} days` : 'Off'}
            keeping={writing}
            lede={
              writing ? (
                <>
                  One entry for each edit and each deleted message, kept for the last{' '}
                  {MESSAGE_LOG_RETENTION_DAYS} UTC days. Proton deletes a whole day of entries at a
                  time, just after midnight UTC.
                </>
              ) : enabled ? (
                <>Nothing is archived while edits and deletions are both off.</>
              ) : (
                <>Nothing is archived while {meta.label} is switched off.</>
              )
            }
          >
            {writing ? (
              <>
                <Outcome kept={config.logEdits}>
                  {!config.logEdits ? (
                    'Edits are not archived.'
                  ) : config.cacheMessageContent ? (
                    <>
                      Each edit stores the new text, author, channel and message ID, plus the old
                      text while Proton still remembers the message.
                    </>
                  ) : (
                    <>
                      Each edit stores the new text, author, channel and message ID. Discord does
                      not send the old text.
                    </>
                  )}
                </Outcome>

                <Outcome kept={config.logDeletes}>
                  {!config.logDeletes ? (
                    'Deletions are not archived.'
                  ) : config.cacheMessageContent ? (
                    <>
                      Each deletion stores the channel, message ID and time, plus the text and
                      author while Proton still remembers the message.
                    </>
                  ) : (
                    <>
                      Each deletion stores the channel, message ID and time, but not the text or
                      author. Discord sends neither with a deletion.
                    </>
                  )}
                </Outcome>
              </>
            ) : (
              <Outcome kept={false}>
                Switching off stops new entries, but entries already archived are kept for the full{' '}
                {MESSAGE_LOG_RETENTION_DAYS} days.
              </Outcome>
            )}
          </Store>

          <Store
            name="Recent text"
            figure={remembering ? held : 'Off'}
            keeping={remembering}
            lede={
              remembering ? (
                <>Each new message is remembered for {held}, then deleted.</>
              ) : config.cacheMessageContent ? (
                <>Nothing new is remembered while {meta.label} is switched off.</>
              ) : (
                <>Nothing is remembered before an edit or deletion.</>
              )
            }
          >
            {remembering ? (
              <>
                <Outcome kept>
                  Each message’s text, author and channel are remembered, with the filename and link
                  of up to 10 attachments.
                </Outcome>
                <Outcome kept={false}>Proton’s own messages are never remembered.</Outcome>
                {clamped ? (
                  <Outcome kept={false}>
                    {humaniseDuration(config.cacheRetention)} is outside the range of 1 hour to 7
                    days, so each message is remembered for {held} instead.
                  </Outcome>
                ) : (
                  <Outcome kept={false}>
                    Switching {meta.label} off stops new messages being remembered. Messages already
                    remembered are kept for the rest of their {held}.
                  </Outcome>
                )}
              </>
            ) : (
              <Outcome kept={false}>
                Deletion logs show which message was deleted, but not what it said or who sent it.
              </Outcome>
            )}
          </Store>

          <p className="logging-ledger-foot">
            {ignored > 0 ? (
              <>
                Nothing from {ignored} ignored {ignored === 1 ? 'channel' : 'channels'} is archived
                or remembered.
              </>
            ) : (
              <>No channels are ignored, so every channel Proton can read is included.</>
            )}
          </p>
        </div>
      </Section>

      <Section
        label="Recent message text"
        intro={
          <>
            Discord does not send the old text with an edit, or any text with a deletion. Without
            this, Server Logs shows{' '}
            <strong>not remembered — turn on “Remember recent message text” in Message logs</strong>{' '}
            in place of the text.
          </>
        }
      >
        <Rows>
          <SettingRow
            title="Remember recent message text"
            description={`Personal data, held in memory apart from the ${MESSAGE_LOG_RETENTION_DAYS}-day archive`}
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
