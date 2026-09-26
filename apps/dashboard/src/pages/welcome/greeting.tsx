import {
  type GreetingMessage,
  isSilentGreeting,
  type WelcomeConfig,
} from '@proton/module-welcome/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { CardPreview } from '../../components/discord/card-preview.tsx';
import { ChannelPicker } from '../../components/discord/channel-picker.tsx';
import type { ConfigErrors } from '../../components/discord/embed-editor.tsx';
import { EditorPreviewLayout } from '../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { TestMessage } from '../../components/module/test-message.tsx';
import { Switch } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { previewMessage } from '../../lib/placeholder-preview.ts';
import { channelsQuery } from '../../lib/queries.ts';
import { type CardGreeting, cardOptionsFor } from './card.tsx';
import {
  GREETING_SURFACES,
  type GreetingKind,
  GreetingMessageEditor,
  type GreetingMessageKey,
} from './message.tsx';

interface KindCopy {
  channelKey: 'welcomeChannelId' | 'goodbyeChannelId' | 'boostChannelId';
  messageKey: GreetingMessageKey;
  channelTitle: string;
  unset: string | null;
  noChannel: string | null;
  intro: string | null;
  toggle: { title: string; description: string; help: string } | null;
  card: { kind: CardGreeting; attachment: string } | null;
}

const SIMULATIONS: Record<GreetingKind, string> = {
  welcome: 'welcome.join',
  goodbye: 'welcome.leave',
  boost: 'welcome.boost',
};

const COPY: Record<GreetingKind, KindCopy> = {
  welcome: {
    channelKey: 'welcomeChannelId',
    messageKey: 'welcomeMessage',
    channelTitle: 'Welcome channel',
    unset: 'No channel is set, so nothing is posted when a member joins.',
    noChannel: null,
    intro: null,
    toggle: null,
    card: { kind: 'welcome', attachment: 'welcome.png' },
  },
  goodbye: {
    channelKey: 'goodbyeChannelId',
    messageKey: 'goodbyeMessage',
    channelTitle: 'Goodbye channel',
    unset: 'No channel is set, so nothing is posted when a member leaves.',
    noChannel: null,
    intro: null,
    toggle: null,
    card: { kind: 'goodbye', attachment: 'goodbye.png' },
  },
  boost: {
    channelKey: 'boostChannelId',
    messageKey: 'boostMessage',
    channelTitle: 'Boost channel',
    unset: null,
    noChannel: 'Same channel as Discord’s boost notice',
    intro: null,
    toggle: {
      title: 'Thank boosters',
      description: 'Post this message every time a member boosts.',
      help:
        'Proton posts this when Discord posts its own boost notice, so boost notices need to be ' +
        'on in your server’s system message settings.',
    },
    card: null,
  },
};

const REFUSED = 'This message can’t be posted:';

const EMPTY = 'The message is empty, so there is nothing to send.';

const POSITIONS: ReadonlyMap<string, string> = new Map([
  ['embeds', 'embed'],
  ['fields', 'field'],
  ['components', 'button row'],
  ['buttons', 'button'],
  ['v2', 'component'],
  ['children', 'item'],
  ['text', 'line'],
  ['items', 'image'],
]);

const SITE = /\b((?:embeds|components|v2)(?:\.\w+)*) \(([^)]+)\)/g;

function positionOf(path: string): string {
  const segments = path.split('.');

  return segments
    .flatMap((segment, index) => {
      const noun = POSITIONS.get(segments[index - 1] ?? '');
      return noun !== undefined && /^\d+$/.test(segment) ? [`${noun} ${Number(segment) + 1}`] : [];
    })
    .join(', ');
}

function readableProblem(problem: string): string {
  const start = problem.indexOf(': ');
  const reasons = start === -1 ? problem : problem.slice(start + 2);

  return reasons.replace(SITE, (_site, path: string, label: string) => {
    const where = positionOf(path);
    if (where === '') return label;

    return where.startsWith(label.toLowerCase())
      ? `${where.charAt(0).toUpperCase()}${where.slice(1)}`
      : `${label} (${where})`;
  });
}

export function GreetingArea({
  guildId,
  kind,
  form,
  errors,
}: {
  guildId: string;
  kind: GreetingKind;
  form: ModuleForm<WelcomeConfig>;
  errors: ConfigErrors;
}): ReactElement {
  const config = form.value;
  const copy = COPY[kind];
  const card = copy.card;
  const surface = GREETING_SURFACES[kind];

  const channelId = config[copy.channelKey];
  const channelPath = copy.channelKey;
  const messagePath = copy.messageKey;
  const message = config[copy.messageKey];

  const channels = useQuery({ ...channelsQuery(guildId), enabled: channelId !== undefined });
  const channelName = channels.data?.find((channel) => channel.id === channelId)?.name;

  const silent = isSilentGreeting(message);
  const cardAttached = card !== null && config.card;

  const setChannel = (next: string | null): void =>
    form.setValue((current) => ({ ...current, [copy.channelKey]: next ?? undefined }));

  const setMessage = (next: GreetingMessage): void =>
    form.setValue((current) => ({ ...current, [copy.messageKey]: next }));

  const preview = useMemo(() => {
    const [sample] = surface.samples;
    return sample === undefined ? null : previewMessage(surface, message, sample);
  }, [surface, message]);

  const cut = useMemo(
    () => [
      ...new Set(
        (preview?.diagnostics ?? [])
          .filter(({ code }) => code === 'output_truncated')
          .map((diagnostic) => diagnostic.message),
      ),
    ],
    [preview],
  );

  const cardOptions = useMemo(
    () => (card === null ? null : cardOptionsFor(config, card.kind)),
    [config, card],
  );

  return (
    <EditorPreviewLayout
      previewActions={
        <TestMessage
          guildId={guildId}
          moduleId="welcome"
          simulations={form.view.simulations}
          simulationId={SIMULATIONS[kind]}
          draft={config as unknown as Record<string, unknown>}
          dirty={form.dirty}
          configuredChannelId={channelId ?? null}
          refusal={silent && !cardAttached ? EMPTY : undefined}
        />
      }
      editor={
        <>
          <Section label="Posting" intro={copy.intro ?? undefined}>
            <Rows>
              {copy.toggle !== null ? (
                <SettingRow
                  title={copy.toggle.title}
                  description={copy.toggle.description}
                  help={copy.toggle.help}
                  error={errors.at('boostEnabled')}
                >
                  <Switch
                    label={copy.toggle.title}
                    checked={config.boostEnabled}
                    onChange={(next) =>
                      form.setValue((current) => ({ ...current, boostEnabled: next }))
                    }
                  />
                </SettingRow>
              ) : null}

              <SettingRow
                title={copy.channelTitle}
                error={errors.at(channelPath)}
                note={
                  channelId === undefined && !silent && copy.unset !== null ? copy.unset : undefined
                }
              >
                <ChannelPicker
                  guildId={guildId}
                  label={copy.channelTitle}
                  value={channelId ?? null}
                  placeholder={copy.noChannel ?? undefined}
                  noneLabel={copy.noChannel ?? undefined}
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
            diagnosticsAt={form.templateDiagnosticsAt}
            cardAttached={cardAttached}
            onChange={setMessage}
          />
        </>
      }
      preview={
        <>
          <DiscordPreview
            message={preview?.message ?? message}
            mentionNames={preview?.mentionNames}
            now={preview?.now}
            channelName={channelName}
            empty={cardAttached ? 'Only the card is posted.' : 'Nothing is posted.'}
          />

          {preview === null || silent ? null : (
            <div className="welcome-preview-notes">
              <p className="text-sm text-muted">{preview.caption}</p>
              {preview.problem === undefined ? null : (
                <p className="field-error">{`${REFUSED} ${readableProblem(preview.problem)}`}</p>
              )}
              {cut.map((line) => (
                <p key={line} className="field-warning">
                  {line}
                </p>
              ))}
            </div>
          )}

          {card !== null && cardOptions !== null && config.card ? (
            <div className="welcome-attachment">
              <span className="welcome-attachment-name">{card.attachment}</span>
              <CardPreview guildId={guildId} options={cardOptions} alt={`The ${card.kind} card`} />
            </div>
          ) : null}
        </>
      }
    />
  );
}
