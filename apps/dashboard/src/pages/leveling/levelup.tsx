import { countV2Components, V2_COMPONENTS_MAX } from '@proton/core';
import type { PathDiagnostic, SurfaceSample } from '@proton/core/placeholders';
import { isSilentLevelUp, type LevelingConfig } from '@proton/module-leveling/config';
import {
  LEVEL_UP_BASE_PATH,
  LEVEL_UP_SURFACE,
  type LevelUpPlaceholderFacts,
} from '@proton/module-leveling/placeholders';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { CHANNEL_TYPE, ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { sentence } from '../../components/discord/embed-editor.tsx';
import {
  EditorPreviewLayout,
  MessageEditor,
  placeholderSlot,
} from '../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { Button, Switch } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { previewMessage } from '../../lib/placeholder-preview.ts';
import { channelsQuery } from '../../lib/queries.ts';
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

const CONTENT_DESCRIPTION = 'Supports Discord markdown and placeholders. Type { to add one.';

const PREVIEW_REFUSED =
  'Filled in for this sample, the message could not be posted, so nothing would appear. The ' +
  'preview shows it as written.';

const LAYOUT_NOTE =
  'A layout is the whole message. Discord ignores any text, embeds or button rows sent with it.';

const PREVIEW_NOTE_CODES: ReadonlySet<string> = new Set(['output_truncated', 'invalid_url']);

function levelUpSample(): SurfaceSample<LevelUpPlaceholderFacts> {
  const [sample] = LEVEL_UP_SURFACE.samples;
  if (sample === undefined) {
    throw new Error(
      'The level-up placeholders have no sample, so the preview cannot be filled in.',
    );
  }
  return sample;
}

const SAMPLE = levelUpSample();

function previewNotes(diagnostics: readonly PathDiagnostic[]): string[] {
  const notes = new Set<string>();

  for (const { code, message, path } of diagnostics) {
    if (!PREVIEW_NOTE_CODES.has(code)) continue;

    const label = LEVEL_UP_SURFACE.fieldAt(`${LEVEL_UP_BASE_PATH}.${path}`)?.label;
    const text = sentence(message);
    notes.add(label === undefined || text.startsWith(label) ? text : `${label}: ${text}`);
  }

  return [...notes];
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

  const { data: channels } = useQuery({
    ...channelsQuery(guildId),
    enabled: config.levelUpChannelId !== undefined,
  });

  const channel = (channels ?? []).find(({ id }) => id === config.levelUpChannelId);

  const setMessage = (next: LevelUpMessage): void =>
    form.setValue((current) => ({ ...current, levelUpMessage: next }));

  const placeholders = placeholderSlot(LEVEL_UP_SURFACE, form.templateDiagnosticsAt);

  const preview = useMemo(
    () =>
      previewMessage(
        LEVEL_UP_SURFACE,
        message,
        SAMPLE,
        channel === undefined
          ? undefined
          : {
              destinationChannel: {
                id: channel.id,
                name: channel.name,
                type: channel.type,
                parentId: channel.parentId,
              },
            },
      ),
    [message, channel],
  );

  const notes = useMemo(() => previewNotes(preview.diagnostics), [preview.diagnostics]);

  const hasLayout = message.v2.length > 0;
  const silent = isSilentLevelUp(message);

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
            placeholders={placeholders}
            contentLabel="Level-up message"
            contentDescription={CONTENT_DESCRIPTION}
            errorAt={form.errorAt}
            pathPrefix={LEVEL_UP_BASE_PATH}
            onChange={(next) => setMessage({ ...message, ...next })}
          />

          <LinkButtonRows
            guildId={guildId}
            rows={message.components}
            errorAt={form.errorAt}
            sectionError={componentsError}
            placeholders={placeholders}
            onChange={(components) => setMessage({ ...message, components })}
          />
        </>
      )}

      {silent ? <p className="leveling-note">{SILENT_NOTE}</p> : null}

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
        <>
          <DiscordPreview
            message={preview.message}
            mentionNames={preview.mentionNames}
            now={preview.now}
            botName="Proton"
            channelName={
              config.levelUpChannelId === undefined
                ? SAMPLE.facts.destinationChannel.name
                : channel?.name
            }
            empty={PREVIEW_EMPTY}
          />
          {silent ? null : <p className="leveling-note">{preview.caption}</p>}
          {preview.problem !== undefined ? (
            <p className="leveling-note">
              <span className="text-danger">{PREVIEW_REFUSED}</span>
            </p>
          ) : null}
          {notes.map((note) => (
            <p key={note} className="leveling-note">
              {note}
            </p>
          ))}
        </>
      }
    />
  );
}
