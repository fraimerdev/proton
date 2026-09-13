import { PREVIEW_SAMPLE } from '@proton/cards/design';
import type { ProtonMessage } from '@proton/core';
import {
  countV2Components,
  MESSAGE_CONTENT_MAX,
  substitute,
  V2_COMPONENTS_MAX,
} from '@proton/core';
import {
  isSilentLevelUp,
  LEVEL_UP_PLACEHOLDERS,
  type LevelingConfig,
} from '@proton/module-leveling/config';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { CHANNEL_TYPE, ChannelPicker } from '../../components/discord/channel-picker.tsx';
import {
  type EditableMessage,
  EditorPreviewLayout,
  MessageEditor,
} from '../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { Button, Switch } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { channelsQuery, sessionQuery } from '../../lib/queries.ts';
import { LinkButtonRows } from './buttons.tsx';

type LevelUpMessage = LevelingConfig['levelUpMessage'];

const ANNOUNCEMENT_CHANNEL_TYPES = [
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.announcement,
  CHANNEL_TYPE.publicThread,
  CHANNEL_TYPE.privateThread,
] as const;

const OWN_CHANNEL_NOTE =
  'No level-up channel is set, so Proton announces in the channel the member was talking in.';

const SILENT_NOTE = 'This message is empty, so nothing is posted when a member levels up.';

const PREVIEW_EMPTY = 'This message is empty, so nothing is posted.';

const NEAR_LIMIT_AT = 1900;

const NEAR_LIMIT_NOTE = `If placeholders push this past ${MESSAGE_CONTENT_MAX} characters, the message is not posted.`;

const PLACEHOLDER_HELP =
  'Use {user}, {level} and {xp} here and in embed titles, field text, footers, button labels ' +
  'and button links.';

const LAYOUT_NOTE =
  'A layout is the whole message. Discord ignores any text, embeds or button rows sent with it.';

const PLACEHOLDER_MEANING: Record<string, string> = {
  '{user}': 'Mentions the member',
  '{level}': 'The level the member reached',
  '{xp}': 'The member’s total XP',
};

const VARIABLES = LEVEL_UP_PLACEHOLDERS.map((token) => ({
  token,
  describes: PLACEHOLDER_MEANING[token] ?? '',
}));

const TOKEN = /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}/g;
const KNOWN = new Set(LEVEL_UP_PLACEHOLDERS.map((token) => token.slice(1, -1)));

function collectUnknown(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(TOKEN)) {
      const name = match[1];
      if (name !== undefined && !KNOWN.has(name)) found.add(name);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectUnknown(item, found);
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectUnknown(item, found);
  }
}

function Mentions({
  value,
  onChange,
}: {
  value: LevelUpMessage['mentions'];
  onChange: (next: LevelUpMessage['mentions']) => void;
}): ReactElement {
  return (
    <Section
      label="Mentions"
      intro="Choose who this message can ping. Mentions that are off still show but do not notify anyone."
    >
      <Rows>
        <SettingRow title="@everyone and @here">
          <Switch
            label="Ping @everyone and @here"
            checked={value.everyone}
            onChange={(everyone) => onChange({ ...value, everyone })}
          />
        </SettingRow>
        <SettingRow title="Roles">
          <Switch
            label="Ping roles"
            checked={value.roles}
            onChange={(roles) => onChange({ ...value, roles })}
          />
        </SettingRow>
        <SettingRow title="Members">
          <Switch
            label="Ping members"
            checked={value.users}
            onChange={(users) => onChange({ ...value, users })}
          />
        </SettingRow>
      </Rows>
    </Section>
  );
}

export function LevelUpArea({
  guildId,
  form,
}: {
  guildId: string;
  form: ModuleForm<LevelingConfig>;
}): ReactElement {
  const config = form.value;
  const message = config.levelUpMessage;

  const { user } = useSuspenseQuery(sessionQuery()).data;
  const { data: channels } = useQuery({
    ...channelsQuery(guildId),
    enabled: config.levelUpChannelId !== undefined,
  });

  const channelName = (channels ?? []).find(
    (channel) => channel.id === config.levelUpChannelId,
  )?.name;

  const setMessage = (next: LevelUpMessage): void =>
    form.setValue((current) => ({ ...current, levelUpMessage: next }));

  const preview = useMemo(
    () =>
      substitute(message, {
        user: `<@${user.id}>`,
        level: PREVIEW_SAMPLE.level,
        xp: PREVIEW_SAMPLE.totalXp,
      }) as Partial<ProtonMessage>,
    [message, user.id],
  );

  const unknown = useMemo(() => {
    const found = new Set<string>();
    collectUnknown(message, found);
    return [...found];
  }, [message]);

  const hasLayout = message.v2.length > 0;
  const silent = isSilentLevelUp(message);
  const content = message.content ?? '';

  // interactiveKeys walks the v2 tree too, so a layout's own button reports against `components`
  // where nothing is wrong. Both branches have to show it or the message cannot be fixed.
  const componentsError = form.errorAt('levelUpMessage.components');

  const editor = (
    <>
      <Section label="Posting">
        <Rows>
          <SettingRow
            title="Level-up channel"
            description="Where Proton announces new levels. Voice level-ups are announced only when a channel is set."
            error={form.errorAt('levelUpChannelId')}
            note={config.levelUpChannelId === undefined ? OWN_CHANNEL_NOTE : undefined}
          >
            <ChannelPicker
              guildId={guildId}
              label="Level-up channel"
              noneLabel="Member’s current channel"
              placeholder="Member’s current channel"
              types={ANNOUNCEMENT_CHANNEL_TYPES}
              value={config.levelUpChannelId ?? null}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, levelUpChannelId: next ?? undefined }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      {hasLayout ? (
        <Section label="Layout" intro={LAYOUT_NOTE}>
          <Rows>
            <SettingRow
              title="Components"
              description="Remove the layout to write text, embeds and link buttons instead."
              error={form.errorAt('levelUpMessage.v2') ?? componentsError}
              note={`${countV2Components(message.v2)} / ${V2_COMPONENTS_MAX} components`}
            >
              <Button
                tone="danger-quiet"
                size="sm"
                icon="trash"
                onClick={() => setMessage({ ...message, v2: [] })}
              >
                Remove layout
              </Button>
            </SettingRow>
          </Rows>
        </Section>
      ) : (
        <>
          <MessageEditor
            guildId={guildId}
            value={message}
            allow={{ components: false, mentions: false }}
            variables={VARIABLES}
            contentLabel="Level-up message"
            contentDescription={
              content.length >= NEAR_LIMIT_AT
                ? `${PLACEHOLDER_HELP} ${NEAR_LIMIT_NOTE}`
                : PLACEHOLDER_HELP
            }
            errorAt={form.errorAt}
            pathPrefix="levelUpMessage"
            onChange={(next: EditableMessage) => setMessage({ ...message, ...next })}
          />

          <LinkButtonRows
            guildId={guildId}
            rows={message.components}
            errorAt={form.errorAt}
            sectionError={componentsError}
            onChange={(components) => setMessage({ ...message, components })}
          />
        </>
      )}

      {silent ? <p className="leveling-note">{SILENT_NOTE}</p> : null}

      {unknown.length > 0 ? (
        <p className="leveling-note">
          Proton does not recognise {unknown.map((name) => `{${name}}`).join(', ')}.{' '}
          {unknown.length === 1 ? 'It is' : 'They are'} posted as written.
        </p>
      ) : null}

      <Mentions
        value={message.mentions}
        onChange={(mentions) => setMessage({ ...message, mentions })}
      />
    </>
  );

  return (
    <EditorPreviewLayout
      editor={editor}
      previewTitle="Discord preview"
      preview={
        <DiscordPreview
          message={preview}
          botName="Proton"
          channelName={channelName}
          empty={PREVIEW_EMPTY}
        />
      }
    />
  );
}
