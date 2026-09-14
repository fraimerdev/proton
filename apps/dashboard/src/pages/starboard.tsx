import { formatComponentEmoji, parseComponentEmoji } from '@proton/core';
import {
  DEFAULT_STAR_EMOJI,
  type StarboardConfig,
  starboardConfigSchema,
} from '@proton/module-starboard/config';
import type { ReactElement } from 'react';
import {
  CHANNEL_TYPE,
  ChannelMultiPicker,
  ChannelName,
  ChannelPicker,
} from '../components/discord/channel-picker.tsx';
import { EmojiGlyph, EmojiPicker } from '../components/discord/emoji-picker.tsx';
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
import { NumberStepper, Switch } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';

const SOURCE_CHANNEL_MAX = 50;

const STARRABLE_CHANNEL_TYPES = [
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.announcement,
  CHANNEL_TYPE.publicThread,
  CHANNEL_TYPE.privateThread,
];

function skipped(config: StarboardConfig): string | null {
  if (config.ignoreBots && config.ignoreNsfw) {
    return 'Bot and webhook messages are ignored, and so are messages in age-restricted channels.';
  }
  if (config.ignoreBots) return 'Bot and webhook messages are ignored.';
  if (config.ignoreNsfw) return 'Messages in age-restricted channels are ignored.';
  return null;
}

function Rule({
  guildId,
  config,
  enabled,
}: {
  guildId: string;
  config: StarboardConfig;
  enabled: boolean;
}): ReactElement {
  const sources = config.sourceChannelIds;
  const onlySource = sources.length === 1 ? sources[0] : undefined;
  const skips = skipped(config);

  return (
    <div className="starboard-rule">
      <p className="starboard-rule-line">
        A message that reaches{' '}
        <span className="starboard-star">
          <EmojiGlyph emoji={parseComponentEmoji(config.emoji)} size={16} />
          <strong>{config.threshold}</strong>
        </span>{' '}
        {onlySource !== undefined ? (
          <>
            in{' '}
            <span className="starboard-chan">
              <ChannelName guildId={guildId} id={onlySource} />
            </span>
          </>
        ) : sources.length === 0 ? (
          <>in any channel Proton can see</>
        ) : (
          <>in any of {sources.length} source channels</>
        )}{' '}
        {config.boardChannelId === undefined ? (
          <span className={enabled ? 'text-warning' : 'text-muted'}>
            is not posted until a board channel is set.
          </span>
        ) : (
          <>
            is posted to{' '}
            <span className="starboard-chan">
              <ChannelName guildId={guildId} id={config.boardChannelId} />
            </span>
            .
          </>
        )}
      </p>

      <p className="starboard-rule-note">
        {config.selfStarAllowed
          ? 'The author’s own star counts toward that total.'
          : 'The author’s own star does not count toward that total.'}
        {skips === null ? null : ` ${skips}`}
      </p>
    </div>
  );
}

function SourceChannels({
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
      types={STARRABLE_CHANNEL_TYPES}
      max={SOURCE_CHANNEL_MAX}
      label="Add source channel"
    />
  );
}

export default function StarboardPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: starboardConfigSchema });
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

      <Rule guildId={guildId} config={form.value} enabled={enabled} />

      <Section label="Board">
        <Rows>
          <SettingRow
            title="Board channel"
            description="Where Proton posts starred messages."
            error={form.errorAt('boardChannelId')}
            note="Messages in the board channel are never starred."
          >
            <ChannelPicker
              guildId={guildId}
              label="Board channel"
              noneLabel="No board channel"
              types={STARRABLE_CHANNEL_TYPES}
              invalid={form.errorAt('boardChannelId') !== undefined}
              value={form.value.boardChannelId}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, boardChannelId: next ?? undefined }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Stars">
        <Rows>
          <SettingRow
            title="Star emoji"
            description="The reaction members use to star a message."
            error={form.errorAt('emoji')}
          >
            <EmojiPicker
              guildId={guildId}
              label="Star emoji"
              value={parseComponentEmoji(form.value.emoji)}
              onChange={(next) =>
                form.setValue((current) => ({
                  ...current,
                  // Clearing is not a value the schema accepts (min 1), so the star comes back.
                  emoji: next === null ? DEFAULT_STAR_EMOJI : formatComponentEmoji(next),
                }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Stars needed"
            description="How many stars a message needs to be posted to the board."
            error={form.errorAt('threshold')}
            note="If a message drops below this, Proton deletes its board post."
          >
            <NumberStepper
              label="Stars needed"
              unit="stars"
              width={148}
              min={1}
              max={100}
              invalid={form.errorAt('threshold') !== undefined}
              value={form.value.threshold}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, threshold: next ?? current.threshold }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Count self-stars"
            error={form.errorAt('selfStarAllowed')}
            note="If off, Proton reads who reacted so the author’s own star is not counted."
          >
            <Switch
              label="Count self-stars"
              checked={form.value.selfStarAllowed}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, selfStarAllowed: next }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Filters">
        <Rows>
          <SettingRow
            stacked
            title="Source channels"
            description="Only messages in these channels can be starred. Leave empty to allow every channel Proton can see."
            error={form.errorAt('sourceChannelIds')}
            badge={
              form.value.sourceChannelIds.length > 0 ? (
                <LimitCounter
                  used={form.value.sourceChannelIds.length}
                  ceiling={SOURCE_CHANNEL_MAX}
                  label="source channels"
                />
              ) : null
            }
          >
            <SourceChannels
              guildId={guildId}
              value={form.value.sourceChannelIds}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, sourceChannelIds: next }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Ignore bot messages"
            error={form.errorAt('ignoreBots')}
            note="Webhook messages count as bot messages."
          >
            <Switch
              label="Ignore bot messages"
              checked={form.value.ignoreBots}
              onChange={(next) => form.setValue((current) => ({ ...current, ignoreBots: next }))}
            />
          </SettingRow>

          <SettingRow title="Ignore age-restricted channels" error={form.errorAt('ignoreNsfw')}>
            <Switch
              label="Ignore age-restricted channels"
              checked={form.value.ignoreNsfw}
              onChange={(next) => form.setValue((current) => ({ ...current, ignoreNsfw: next }))}
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
