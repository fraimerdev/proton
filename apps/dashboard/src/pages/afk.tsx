import { formatDuration, parseDuration } from '@proton/core';
import {
  AFK_RETENTION_MS,
  type AfkConfig,
  afkConfigSchema,
  IGNORED_CHANNELS_MAX,
  QUIET_CHANNEL_TYPES,
  RECAP_MAX,
  TIDY_MAX,
  TIDY_MIN,
  tidyDelayMs,
} from '@proton/module-afk/config';
import type { ReactElement } from 'react';
import { ChannelMultiPicker } from '../components/discord/channel-picker.tsx';
import { DurationInput, humaniseDuration } from '../components/discord/inputs.tsx';
import { DiscordPreview } from '../components/discord/message-preview.tsx';
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

const TIDY_MIN_MS = parseDuration(TIDY_MIN);
const TIDY_MAX_MS = parseDuration(TIDY_MAX);

const RETENTION_DAYS = Math.round(AFK_RETENTION_MS / 86_400_000);

const SAMPLE_NAME = 'Riley';
const SAMPLE_REASON = 'grabbing lunch';
const SAMPLE_PINGS = 2;

function channels(count: number): string {
  return `${count} ${count === 1 ? 'channel' : 'channels'}`;
}

function Exchange({ config }: { config: AfkConfig }): ReactElement {
  const tagged = config.nicknameTag ? `[AFK] ${SAMPLE_NAME}` : SAMPLE_NAME;
  const quiet = config.ignoredChannelIds.length;

  const notice = `**${SAMPLE_NAME}** is AFK: ${SAMPLE_REASON} · 40 minutes ago`;
  const welcome =
    `Welcome back, **${SAMPLE_NAME}**. You were AFK for 1 hour and 15 minutes.` +
    (config.recap ? ` I've sent you the ${SAMPLE_PINGS} pings you missed.` : '');

  const fate = config.tidyReplies
    ? `Proton deletes both replies after about ${humaniseDuration(formatDuration(tidyDelayMs(config)))}.`
    : 'Both replies stay in the channel.';

  return (
    <div className="afk-exchange">
      <figure className="afk-scene">
        <figcaption className="afk-scene-cue">
          Someone pings <strong>{tagged}</strong>, and Proton replies.
        </figcaption>
        <DiscordPreview message={{ content: notice }} timestamp="Today at 12:40" />
      </figure>

      <figure className="afk-scene">
        <figcaption className="afk-scene-cue">
          <strong>{SAMPLE_NAME}</strong> sends their next message.{' '}
          {config.nicknameTag
            ? 'Proton takes [AFK] off their nickname and replies.'
            : 'Proton replies.'}
        </figcaption>
        <DiscordPreview message={{ content: welcome }} timestamp="Today at 13:15" />
      </figure>

      <p className="afk-exchange-foot">
        {fate}
        {quiet > 0 ? ` Neither is posted in the ${channels(quiet)} without AFK replies.` : null}
      </p>
    </div>
  );
}

export default function AfkPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: afkConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;
  const config = form.value;
  const tidyError = form.errorAt('tidyAfter');

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

      <Section label="What members see" note={form.dirty ? 'Includes unsaved changes.' : undefined}>
        <Exchange config={config} />
      </Section>

      <Section
        label="When someone pings them"
        intro="Proton answers by replying to the message, so it needs Send Messages and Read Message History in the channel. Without them it posts nothing."
      >
        <Rows>
          <SettingRow
            title="Tidy up replies"
            description="Delete Proton’s AFK notices and welcome-back notes after a short delay."
            error={form.errorAt('tidyReplies')}
          >
            <Switch
              label="Tidy up replies"
              checked={config.tidyReplies}
              onChange={(next) => form.setValue((current) => ({ ...current, tidyReplies: next }))}
            />
          </SettingRow>

          {config.tidyReplies || tidyError !== undefined ? (
            <SettingRow
              title="Delete after"
              description={`How long a reply stays, from ${humaniseDuration(TIDY_MIN)} to ${humaniseDuration(TIDY_MAX)}. Proton deletes replies in batches, so one can stay a little longer.`}
              note="Proton needs Manage Messages in the channel. Without it, the reply stays."
              error={tidyError}
            >
              <DurationInput
                label="Delete after"
                value={config.tidyAfter}
                min={TIDY_MIN_MS}
                max={TIDY_MAX_MS}
                units={['s', 'm']}
                invalid={tidyError !== undefined}
                onChange={(next) => form.setValue((current) => ({ ...current, tidyAfter: next }))}
              />
            </SettingRow>
          ) : null}

          <SettingRow
            stacked
            title="Channels without AFK replies"
            description="Proton posts no AFK notices or welcome-back notes in these channels, including threads and posts inside them. Pings there still count toward the away member’s recap."
            badge={
              config.ignoredChannelIds.length > 0 ? (
                <LimitCounter
                  used={config.ignoredChannelIds.length}
                  ceiling={IGNORED_CHANNELS_MAX}
                  label="channels without AFK replies"
                />
              ) : null
            }
            error={form.errorAt('ignoredChannelIds')}
          >
            <ChannelMultiPicker
              guildId={guildId}
              value={config.ignoredChannelIds}
              types={QUIET_CHANNEL_TYPES}
              max={IGNORED_CHANNELS_MAX}
              label="Add channel without AFK replies"
              invalid={form.errorAt('ignoredChannelIds') !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, ignoredChannelIds: next }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Nickname">
        <Rows>
          <SettingRow
            title="Add [AFK] tag"
            description="Put [AFK] in front of a member’s nickname while they’re away. Proton puts their old nickname back when they return, unless they changed it in the meantime."
            note="Proton needs Manage Nicknames. Discord never lets bots rename the server owner or anyone ranked at or above Proton, so Proton tells those members it couldn’t add the tag."
            error={form.errorAt('nicknameTag')}
          >
            <Switch
              label="Add [AFK] tag"
              checked={config.nicknameTag}
              onChange={(next) => form.setValue((current) => ({ ...current, nicknameTag: next }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section
        label="Coming back"
        intro={
          <>
            A member stops being AFK when they next send a message, run{' '}
            <span className="mono">/afk clear</span>, or after {RETENTION_DAYS} days. Staff with
            Manage Nicknames can clear it for them.
          </>
        }
      >
        <Rows>
          <SettingRow
            title="Recap by DM"
            description={`DM members up to ${RECAP_MAX} of the pings they missed, each with a link to the message.`}
            note="Sent only when members come back themselves. If their DMs are closed, the welcome-back note says the list couldn’t be sent."
            error={form.errorAt('recap')}
          >
            <Switch
              label="Recap by DM"
              checked={config.recap}
              onChange={(next) => form.setValue((current) => ({ ...current, recap: next }))}
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
