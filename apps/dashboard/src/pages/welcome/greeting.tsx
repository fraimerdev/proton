import { PREVIEW_SAMPLE } from '@proton/cards/design';
import {
  type GreetingMessage,
  isSilentGreeting,
  renderGreeting,
  type WelcomeConfig,
} from '@proton/module-welcome/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { CardPreview } from '../../components/discord/card-preview.tsx';
import { ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { EditorPreviewLayout } from '../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { channelsQuery } from '../../lib/queries.ts';
import { cardOptionsFor, type GreetingKind } from './card.tsx';
import type { ConfigErrors } from './errors.ts';
import { GreetingMessageEditor } from './message.tsx';

const COPY = {
  welcome: {
    channelTitle: 'Welcome channel',
    channelDescription: 'Where Proton posts when a member joins.',
    unset: 'No channel is set, so nothing is posted when a member joins.',
    attachment: 'welcome.png',
  },
  goodbye: {
    channelTitle: 'Goodbye channel',
    channelDescription: 'Where Proton posts when a member leaves.',
    unset: 'No channel is set, so nothing is posted when a member leaves.',
    attachment: 'goodbye.png',
  },
} as const;

export function GreetingArea({
  guildId,
  kind,
  form,
  errors,
  guildName,
  viewerName,
}: {
  guildId: string;
  kind: GreetingKind;
  form: ModuleForm<WelcomeConfig>;
  errors: ConfigErrors;
  guildName: string;
  viewerName: string;
}): ReactElement {
  const config = form.value;
  const welcome = kind === 'welcome';
  const copy = COPY[kind];

  const channelId = welcome ? config.welcomeChannelId : config.goodbyeChannelId;
  const channelPath = welcome ? 'welcomeChannelId' : 'goodbyeChannelId';
  const messagePath = welcome ? 'welcomeMessage' : 'goodbyeMessage';
  const message = welcome ? config.welcomeMessage : config.goodbyeMessage;

  const channels = useQuery({ ...channelsQuery(guildId), enabled: channelId !== undefined });
  const channelName = channels.data?.find((channel) => channel.id === channelId)?.name;

  const silent = isSilentGreeting(message);

  const setChannel = (next: string | null): void =>
    form.setValue((current) =>
      welcome
        ? { ...current, welcomeChannelId: next ?? undefined }
        : { ...current, goodbyeChannelId: next ?? undefined },
    );

  const setMessage = (next: GreetingMessage): void =>
    form.setValue((current) =>
      welcome ? { ...current, welcomeMessage: next } : { ...current, goodbyeMessage: next },
    );

  const preview = useMemo(
    () =>
      renderGreeting(message, {
        // Any digits do: the preview draws every mention as "@user" without a lookup, and the
        // viewer's Discord snowflake is not in the session to begin with.
        userId: '0',
        username: viewerName,
        guildName,
        memberCount: PREVIEW_SAMPLE.memberCount,
      }),
    [message, viewerName, guildName],
  );

  const cardOptions = useMemo(() => cardOptionsFor(config, kind), [config, kind]);

  return (
    <EditorPreviewLayout
      editor={
        <>
          <Section label="Posting">
            <Rows>
              <SettingRow
                title={copy.channelTitle}
                description={copy.channelDescription}
                error={errors.at(channelPath)}
                note={channelId === undefined && !silent ? copy.unset : undefined}
              >
                <ChannelPicker
                  guildId={guildId}
                  label={copy.channelTitle}
                  value={channelId ?? null}
                  invalid={errors.at(channelPath) !== undefined}
                  onChange={setChannel}
                />
              </SettingRow>
            </Rows>
          </Section>

          <GreetingMessageEditor
            guildId={guildId}
            kind={kind}
            value={message}
            prefix={messagePath}
            errors={errors}
            cardAttached={config.card}
            onChange={setMessage}
          />
        </>
      }
      preview={
        <>
          <DiscordPreview
            message={preview}
            channelName={channelName}
            empty={config.card ? 'Only the card is posted.' : 'Nothing is posted.'}
          />

          {config.card ? (
            <div className="welcome-attachment">
              <span className="welcome-attachment-name">{copy.attachment}</span>
              <CardPreview guildId={guildId} options={cardOptions} alt={`The ${kind} card`} />
            </div>
          ) : null}
        </>
      }
    />
  );
}
