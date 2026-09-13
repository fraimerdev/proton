import { countV2Components, V2_COMPONENTS_MAX } from '@proton/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { EditorPreviewLayout } from '../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { Switch } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { channelsQuery } from '../../lib/queries.ts';
import { LayoutBuilder } from './layout-builder.tsx';
import {
  armedChannelIds,
  configErrors,
  type HoneypotForm,
  noticePreview,
  overriddenBodyPath,
  quietNoticeBody,
} from './shape.ts';

const SAVE_RECONCILES = 'Saving deletes the warning message from paused and removed bait channels.';

const OVERRIDDEN =
  '“Hide channel purpose” is switched on, so this text replaces your paragraph when the warning ' +
  'message is posted.';

const COUNTER_IS_ZERO =
  'The preview counter shows 0. In Discord, each bait channel shows its own count.';

const NOT_POSTED =
  'The warning message is switched off. This layout is kept, and saving deletes any warning ' +
  'messages already posted in bait channels.';

const FREE_TIER =
  'On the Free plan, Proton posts its own wording. Yours is saved and used once the server is on ' +
  'a paid plan.';

export function NoticeArea({
  form,
  guildId,
}: {
  form: HoneypotForm;
  guildId: string;
}): ReactElement {
  const config = form.value;
  const errors = configErrors(form);
  const layoutError = form.errorAt('noticeLayout.v2');

  const { data: channels } = useQuery(channelsQuery(guildId));
  const armed = armedChannelIds(config)[0] ?? config.channels[0]?.channelId;
  const baitChannel = (channels ?? []).find((channel) => channel.id === armed);

  const overriddenAt = config.hideWhatIsAHoneypot
    ? overriddenBodyPath(config.noticeLayout.v2)
    : undefined;
  const overriddenPath = overriddenAt === undefined ? undefined : `noticeLayout.v2.${overriddenAt}`;

  return (
    <EditorPreviewLayout
      previewTitle="What the channel shows"
      editor={
        <>
          {config.postNotice ? null : <StatusBanner tone="neutral">{NOT_POSTED}</StatusBanner>}

          <Section label="Posting">
            <Rows>
              <SettingRow
                title="Post a warning message"
                description="Shown in every armed bait channel to warn members away."
              >
                <Switch
                  label="Post a warning message"
                  checked={config.postNotice}
                  onChange={(next) => form.setValue((c) => ({ ...c, postNotice: next }))}
                />
              </SettingRow>

              {config.postNotice ? (
                <SettingRow
                  title="Counter button"
                  description="Show how many members this bait channel has caught."
                >
                  <Switch
                    label="Counter button"
                    checked={config.noticeCounterButton}
                    onChange={(next) => form.setValue((c) => ({ ...c, noticeCounterButton: next }))}
                  />
                </SettingRow>
              ) : null}

              {config.postNotice ? (
                <SettingRow
                  title="Hide channel purpose"
                  description="Warn members away without explaining that the channel catches spam bots."
                >
                  <Switch
                    label="Hide channel purpose"
                    checked={config.hideWhatIsAHoneypot}
                    onChange={(next) => form.setValue((c) => ({ ...c, hideWhatIsAHoneypot: next }))}
                  />
                </SettingRow>
              ) : null}
            </Rows>
          </Section>

          <Section
            label="Layout"
            note={`${countV2Components(config.noticeLayout.v2)} / ${V2_COMPONENTS_MAX} components`}
          >
            {layoutError !== undefined ? (
              <p className="row-error honeypot-layout-error">{layoutError}</p>
            ) : null}

            <p className="section-intro">
              <span className="mono">{'{consequence}'}</span> is replaced with what the action does
              to the member, and <span className="mono">{'{purge}'}</span> with a sentence about
              deleted messages.
            </p>

            <LayoutBuilder
              guildId={guildId}
              value={config.noticeLayout.v2}
              errors={errors}
              prefix="noticeLayout.v2"
              overriddenAt={
                overriddenPath === undefined
                  ? undefined
                  : (path) =>
                      path === overriddenPath
                        ? { content: quietNoticeBody(config), note: OVERRIDDEN }
                        : undefined
              }
              onChange={(next) =>
                form.setValue((c) => ({ ...c, noticeLayout: { ...c.noticeLayout, v2: next } }))
              }
            />

            <p className="row-note honeypot-foot-note">{SAVE_RECONCILES}</p>
          </Section>
        </>
      }
      preview={
        <div className="stack stack-10">
          <DiscordPreview
            message={{ v2: noticePreview(config, form.view.tier, 0) }}
            channelName={baitChannel?.name ?? 'bait'}
            empty="This layout posts nothing. Discord refuses an empty message."
          />
          <p className="text-xs text-muted">{COUNTER_IS_ZERO}</p>
          {form.view.tier === 'free' ? <p className="text-xs text-muted">{FREE_TIER}</p> : null}
        </div>
      }
    />
  );
}
