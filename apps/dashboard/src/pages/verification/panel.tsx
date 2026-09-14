import { MESSAGE_CONTENT_MAX, type ProtonMessage, parseComponentEmoji } from '@proton/core';
import {
  BUTTON_EMOJI_MAX,
  BUTTON_LABEL_MAX,
  PANEL_BUTTON_STYLES,
  type PanelButtonStyle,
  type VerificationConfig,
} from '@proton/module-verification/config';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { CHANNEL_TYPE, ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { configErrors, EmbedEditor } from '../../components/discord/embed-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { LimitCounter } from '../../components/ui/collection.tsx';
import { Button, cx, Switch, TextArea, TextInput } from '../../components/ui/controls.tsx';
import {
  AsyncOperationStatus,
  type AsyncPhase,
  StatusBanner,
} from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { saveFailure } from '../../lib/errors.ts';
import { channelsQuery } from '../../lib/queries.ts';
import { postModulePanel } from '../../server/modules.ts';
import { EmojiField } from './emoji.tsx';

// refineVerificationPanel, verbatim: a stored panel can still carry these, and a save refuses them.
const CARRIES_ROWS =
  'Proton adds the verify button to this panel itself, so it cannot carry button rows of its own ' +
  '— a second row would be posted under a button nobody configured.';

const CARRIES_V2 =
  'The verification panel is posted with Proton’s own verify button attached, and Discord will ' +
  'not put a button row on a components layout. Build this panel from text and embeds.';

const POST_NOTE = 'Post the panel again if it was deleted in Discord.';

const NO_CHANNEL = 'Choose a panel channel first.';

const POST_IS_SAVED = 'Save your changes first. Posting uses the last saved version.';

const EMOJI_IS_UNICODE =
  'Proton sends this to Discord as an emoji character. Choose a server emoji, or paste a single ' +
  'emoji.';

const MENTIONS_NOTE =
  'Choose who this panel can ping when Proton updates it. A newly posted panel notifies no one.';

const PANEL_CHANNEL_TYPES = [CHANNEL_TYPE.text, CHANNEL_TYPE.announcement] as const;

const PANEL_CHANNEL_LABEL = 'Panel channel';
const BUTTON_LABEL_LABEL = 'Button label';
const BUTTON_STYLE_LABEL = 'Button colour';

const BUTTON_STYLE_CLASS: Record<PanelButtonStyle, string> = {
  primary: '',
  secondary: 'secondary',
  success: 'success',
  danger: 'danger',
};

const BUTTON_STYLE_NAME: Record<PanelButtonStyle, string> = {
  primary: 'Blurple',
  secondary: 'Grey',
  success: 'Green',
  danger: 'Red',
};

const MENTION_LABELS: readonly {
  key: 'everyone' | 'roles' | 'users';
  label: string;
  ping: string;
}[] = [
  { key: 'everyone', label: '@everyone and @here', ping: 'Ping @everyone and @here' },
  { key: 'roles', label: 'Roles', ping: 'Ping roles' },
  { key: 'users', label: 'Members', ping: 'Ping members' },
];

interface AreaProps {
  guildId: string;
  moduleId: string;
  form: ModuleForm<VerificationConfig>;
}

function ButtonStyleChoice({
  value,
  onChange,
}: {
  value: PanelButtonStyle;
  onChange: (style: PanelButtonStyle) => void;
}): ReactElement {
  return (
    <fieldset className="verification-style-group">
      <legend className="visually-hidden">{BUTTON_STYLE_LABEL}</legend>
      {PANEL_BUTTON_STYLES.map((style) => (
        <button
          key={style}
          type="button"
          aria-pressed={style === value}
          className={cx('dc-button', BUTTON_STYLE_CLASS[style], 'verification-style-choice')}
          onClick={() => onChange(style)}
        >
          {BUTTON_STYLE_NAME[style]}
        </button>
      ))}
    </fieldset>
  );
}

export function PanelArea({ guildId, moduleId, form }: AreaProps): ReactElement {
  const config = form.value;
  const panel = config.panel;

  const channels = useQuery(channelsQuery(guildId));
  const channel = (channels.data ?? []).find((entry) => entry.id === config.panelChannelId);

  const postable = form.view.postables.find((entry) => entry.id === 'panel');
  const post = useMutation({
    mutationFn: () => postModulePanel({ data: { guildId, moduleId, panelId: 'panel' } }),
  });

  const phase: AsyncPhase = post.isPending
    ? 'working'
    : post.isError
      ? 'failed'
      : post.isSuccess
        ? 'requested'
        : 'idle';

  const content = panel.content ?? '';
  const emoji = parseComponentEmoji(config.panelButtonEmoji);
  const unicodeOnly = emoji !== undefined && emoji.id === undefined;

  const emojiNote =
    unicodeOnly && !/\p{Extended_Pictographic}/u.test(emoji.name ?? '')
      ? EMOJI_IS_UNICODE
      : undefined;

  const labelError =
    config.panelButtonLabel.trim() === ''
      ? 'The verify button needs a label.'
      : form.errorAt('panelButtonLabel');

  const preview: Partial<ProtonMessage> = {
    ...(panel.content === undefined ? {} : { content: panel.content }),
    embeds: panel.embeds,
    mentions: panel.mentions,
    v2: [],
    components: [
      {
        kind: 'buttons',
        buttons: [
          {
            key: 'verify',
            style: config.panelButtonStyle,
            label: config.panelButtonLabel,
            ...(emoji ? { emoji } : {}),
          },
        ],
      },
    ],
  };

  return (
    <div className="editor">
      <div className="editor-main">
        <Section label="Location">
          <Rows>
            <SettingRow
              title={PANEL_CHANNEL_LABEL}
              description="Where Proton posts the panel members use to verify."
              error={form.errorAt('panelChannelId')}
            >
              <ChannelPicker
                guildId={guildId}
                label={PANEL_CHANNEL_LABEL}
                types={PANEL_CHANNEL_TYPES}
                value={config.panelChannelId ?? null}
                onChange={(next) => form.set('panelChannelId', next ?? undefined)}
              />
            </SettingRow>
          </Rows>
        </Section>

        <Section
          label="Message"
          note={
            <LimitCounter used={content.length} ceiling={MESSAGE_CONTENT_MAX} label="characters" />
          }
        >
          {panel.components.length > 0 ? (
            <StatusBanner tone="danger" title="Panel has button rows">
              {CARRIES_ROWS}
            </StatusBanner>
          ) : null}

          {panel.v2.length > 0 ? (
            <StatusBanner tone="danger" title="Panel uses a layout">
              {CARRIES_V2}
            </StatusBanner>
          ) : null}

          <TextArea
            aria-label="Panel message"
            rows={7}
            maxLength={MESSAGE_CONTENT_MAX}
            invalid={form.errorAt('panel.content') !== undefined}
            value={content}
            onChange={(event) =>
              form.set(
                'panel.content',
                event.currentTarget.value === '' ? undefined : event.currentTarget.value,
              )
            }
          />

          {form.errorAt('panel.content') !== undefined ? (
            <p className="field-error">{form.errorAt('panel.content')}</p>
          ) : null}
        </Section>

        <EmbedEditor
          value={panel.embeds}
          prefix="panel.embeds"
          errors={configErrors(form)}
          onChange={(embeds) => form.set('panel.embeds', embeds)}
        />

        <Section label="Mentions" intro={MENTIONS_NOTE}>
          <Rows>
            {MENTION_LABELS.map((mention) => (
              <SettingRow key={mention.key} title={mention.label}>
                <Switch
                  checked={panel.mentions[mention.key]}
                  label={mention.ping}
                  onChange={(next) => form.set(`panel.mentions.${mention.key}`, next)}
                />
              </SettingRow>
            ))}
          </Rows>
        </Section>

        <Section label="Verify button">
          <Rows>
            <SettingRow title={BUTTON_LABEL_LABEL} error={labelError}>
              <TextInput
                width="md"
                aria-label={BUTTON_LABEL_LABEL}
                maxLength={BUTTON_LABEL_MAX}
                invalid={labelError !== undefined}
                value={config.panelButtonLabel}
                onChange={(event) => form.set('panelButtonLabel', event.currentTarget.value)}
              />
            </SettingRow>

            <SettingRow title="Button emoji" note={emojiNote}>
              <EmojiField
                guildId={guildId}
                value={config.panelButtonEmoji}
                maxLength={BUTTON_EMOJI_MAX}
                onChange={(next) => form.set('panelButtonEmoji', next)}
              />
            </SettingRow>

            <SettingRow title={BUTTON_STYLE_LABEL}>
              <ButtonStyleChoice
                value={config.panelButtonStyle}
                onChange={(next) => form.set('panelButtonStyle', next)}
              />
            </SettingRow>
          </Rows>
        </Section>

        <Section label="Posting" intro={POST_NOTE}>
          <div className="verification-post">
            <Button
              busy={post.isPending}
              disabled={postable?.channelId === undefined}
              title={postable?.channelId === undefined ? NO_CHANNEL : undefined}
              onClick={() => post.mutate()}
            >
              Post
            </Button>

            <AsyncOperationStatus
              phase={phase}
              workingLabel="Posting…"
              requestedLabel="Asked Proton to post it. Check the channel in Discord to confirm it appeared."
              failedLabel={
                post.error ? saveFailure(post.error, 'The panel was not posted') : undefined
              }
            />

            {postable?.channelId === undefined ? (
              <span className="text-sm text-muted">{NO_CHANNEL}</span>
            ) : form.dirty ? (
              <span className="text-sm text-muted">{POST_IS_SAVED}</span>
            ) : null}
          </div>
        </Section>
      </div>

      <div className="editor-preview">
        <div className="editor-preview-head">
          <span className="editor-preview-title">Preview</span>
        </div>
        <DiscordPreview message={preview} channelName={channel?.name} />
      </div>
    </div>
  );
}
