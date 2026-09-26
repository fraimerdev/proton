import {
  ACTION_ROWS_MAX,
  countV2Components,
  type ModuleSummary,
  V2_COMPONENTS_MAX,
} from '@proton/core';
import type { ChannelFacts, PathDiagnostic, SurfaceSample } from '@proton/core/placeholders';
import {
  type AchievementsConfig,
  type AnnouncementMessage,
  isSilentMessage,
} from '@proton/module-achievements/config';
import {
  ACHIEVEMENT_SURFACES,
  type AchievementMessageKind,
  type AchievementPlaceholderFacts,
  almostThereRoute,
  isDirectMessageKind,
  type MessageRoute,
  unlockRoute,
} from '@proton/module-achievements/placeholders';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { CHANNEL_TYPE, ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { configErrors, sentence } from '../../components/discord/embed-editor.tsx';
import { DurationInput } from '../../components/discord/inputs.tsx';
import { newLinkButton } from '../../components/discord/layout-builder.tsx';
import {
  EditorPreviewLayout,
  MessageEditor,
  placeholderSlot,
} from '../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { TestMessage } from '../../components/module/test-message.tsx';
import { useRecent } from '../../components/ui/collection.tsx';
import {
  Button,
  IconButton,
  SegmentedControl,
  type SegmentedOption,
  Switch,
} from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import type { GuildChannel } from '../../lib/discord.ts';
import type { ModuleMeta } from '../../lib/modules/catalogue.ts';
import { previewMessage } from '../../lib/placeholder-preview.ts';
import { channelsQuery } from '../../lib/queries.ts';
import { LinkButtonRowEditor, takenKeys } from '../welcome/buttons.tsx';

type Form = ModuleForm<AchievementsConfig>;

type Destination = AchievementsConfig['announcement']['destination'];

type Fallback = AchievementsConfig['announcement']['fallback'];

type AlmostDestination = AchievementsConfig['almostThere']['destination'];

const ANNOUNCE_CHANNEL_TYPES = [
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.announcement,
  CHANNEL_TYPE.publicThread,
  CHANNEL_TYPE.privateThread,
] as const;

const HOUR_MS = 60 * 60 * 1000;
const ALMOST_COOLDOWN_MIN_MS = HOUR_MS;
const ALMOST_COOLDOWN_MAX_MS = 30 * 24 * HOUR_MS;

const UNLOCK_LABEL = 'When a member earns an achievement';

const UNLOCK_HELP =
  'This is the server default. Each achievement can have its own announcement, or none, in its ' +
  'Announcement tab.';

const DESTINATION_OPTIONS: readonly SegmentedOption<Destination>[] = [
  { value: 'current', label: 'Current channel' },
  { value: 'channel', label: 'Channel' },
  { value: 'dm', label: 'DM' },
  { value: 'none', label: 'Off', tone: 'off' },
];

const DM_DESCRIPTION =
  'Sent to the member by DM. Members who don’t accept DMs from the server don’t get it.';

const DESTINATION_DESCRIPTION: Record<Destination, string> = {
  current: 'Posted in the channel where the member earned it.',
  channel: 'Posted in one channel you choose.',
  dm: DM_DESCRIPTION,
  none: 'Nothing is posted unless an achievement has its own announcement. Rewards are still given.',
};

const FALLBACK_OPTIONS: readonly SegmentedOption<Fallback>[] = [
  { value: 'channel', label: 'Channel' },
  { value: 'dm', label: 'DM' },
  { value: 'none', label: 'None', tone: 'off' },
];

const FALLBACK_TITLE = 'When there’s no current channel';

const FALLBACK_DESCRIPTION =
  'Used when it’s earned outside a channel, such as in voice, or when Proton can’t post where it ' +
  'was earned.';

const FALLBACK_NONE_NOTE =
  'Achievements earned outside a channel, such as from voice time, aren’t announced.';

const ATTACH_TITLE = 'Attach the badge';

const ATTACH_DESCRIPTION = 'Adds the achievement’s badge image to unlock announcements.';

const ATTACH_HELP =
  'If the announcement has an embed, the badge becomes the first embed’s thumbnail unless it ' +
  'already has one.';

const ATTACH_LAYOUT_NOTE = 'A layout message can’t carry the badge, so this one goes without it.';

const ALMOST_LABEL = 'Almost there';

const ALMOST_INTRO =
  'Reminds members when they’re close to their next tier. Turn reminders on for each achievement ' +
  'in its Schedule tab.';

const ALMOST_OPTIONS: readonly SegmentedOption<AlmostDestination>[] = [
  { value: 'dm', label: 'DM' },
  { value: 'current', label: 'Current channel' },
  { value: 'channel', label: 'Channel' },
];

const ALMOST_DESCRIPTION: Record<AlmostDestination, string> = {
  dm: DM_DESCRIPTION,
  current:
    'Posted in the channel where the member was active. Nothing is sent for activity outside a ' +
    'channel, such as voice.',
  channel: 'Posted in one channel you choose.',
};

const COOLDOWN_DESCRIPTION =
  'A member gets at most one reminder per achievement in this time, and only one per tier.';

const CONTENT_DESCRIPTION = 'Supports Discord markdown and placeholders. Type { to add one.';

const LAYOUT_HELP =
  'A layout is the whole message. Discord ignores any text, embeds or button rows sent with it.';

const BUTTONS_EMPTY = 'No link buttons yet.';

const SELECT_ROW = 'This row is a dropdown, which these messages can’t carry.';

const DM_MENTIONS_NOTE = 'DMs never ping anyone, so there’s nothing to set here.';

const SILENT_UNLOCK =
  'This message is empty, so nothing is posted when a member earns an achievement.';

const SILENT_ALMOST = 'This message is empty, so no reminder is sent.';

const PREVIEW_EMPTY = 'This message is empty, so nothing is posted.';

const PREVIEW_OFF = 'Nothing is posted unless an achievement has its own announcement.';

const PREVIEW_DM = 'Sent to the member by DM.';

const PREVIEW_REFUSED =
  'With this sample filled in, the message couldn’t be posted, so nothing would appear. The ' +
  'preview shows it as written.';

const EMPTY_REFUSAL = 'Write something in the message before testing it.';

const PREVIEW_NOTE_CODES: ReadonlySet<string> = new Set(['output_truncated', 'invalid_url']);

const SIMULATION_IDS: Record<AchievementMessageKind, string> = {
  unlocked: 'achievements.unlocked',
  unlocked_dm: 'achievements.unlocked_dm',
  almost_there: 'achievements.almost_there',
  almost_there_dm: 'achievements.almost_there_dm',
};

function sampleOf(kind: AchievementMessageKind): SurfaceSample<AchievementPlaceholderFacts> {
  const [sample] = ACHIEVEMENT_SURFACES[kind].samples;
  if (sample === undefined) {
    throw new Error(
      'The achievement message placeholders have no sample, so the preview cannot be filled in.',
    );
  }
  return sample;
}

function previewNotes(
  kind: AchievementMessageKind,
  basePath: string,
  diagnostics: readonly PathDiagnostic[],
): string[] {
  const notes = new Set<string>();

  for (const { code, message, path } of diagnostics) {
    if (!PREVIEW_NOTE_CODES.has(code)) continue;

    const label = ACHIEVEMENT_SURFACES[kind].fieldAt(`${basePath}.${path}`)?.label;
    const text = sentence(message);
    notes.add(label === undefined || text.startsWith(label) ? text : `${label}: ${text}`);
  }

  return [...notes];
}

export function withUnlockDestination(
  config: AchievementsConfig,
  destination: Destination,
): AchievementsConfig {
  const { announcement } = config;
  const strandedFallback =
    destination !== 'current' &&
    announcement.fallback === 'channel' &&
    announcement.fallbackChannelId === undefined;

  return {
    ...config,
    announcement: {
      ...announcement,
      destination,
      ...(strandedFallback ? { fallback: 'none' as const } : {}),
    },
  };
}

function Mentions({
  value,
  onChange,
}: {
  value: AnnouncementMessage['mentions'];
  onChange: (next: AnnouncementMessage['mentions']) => void;
}): ReactElement {
  return (
    <Section
      label="Mentions"
      help="A mention that’s off still shows in the message but doesn’t notify anyone."
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

function LinkButtons({
  guildId,
  form,
  kind,
  path,
  rows,
  onChange,
}: {
  guildId: string;
  form: Form;
  kind: AchievementMessageKind;
  path: string;
  rows: AnnouncementMessage['components'];
  onChange: (components: AnnouncementMessage['components']) => void;
}): ReactElement {
  const recent = useRecent();
  const taken = takenKeys(rows);
  const errors = configErrors(form);
  const placeholders = placeholderSlot(ACHIEVEMENT_SURFACES[kind], form.templateDiagnosticsAt);
  const rowsError = form.errorAt(`${path}.components`);

  const drop = (index: number): void => onChange(rows.filter((_, at) => at !== index));

  return (
    <Section
      label="Link buttons"
      note={`${rows.length} / ${ACTION_ROWS_MAX} rows`}
      actions={
        rows.length < ACTION_ROWS_MAX ? (
          <Button
            size="sm"
            icon="plus"
            onClick={() => {
              recent.mark(rows.length);
              onChange([...rows, { kind: 'buttons', buttons: [newLinkButton(taken)] }]);
            }}
          >
            Add row
          </Button>
        ) : undefined
      }
    >
      {rowsError !== undefined ? (
        <p className="row-error" role="alert">
          {rowsError}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="section-intro">{BUTTONS_EMPTY}</p>
      ) : (
        <div className="stack stack-10">
          {rows.map((row, index) =>
            row.kind === 'buttons' ? (
              <LinkButtonRowEditor
                // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
                key={index}
                className={recent.enter(index, 'part')}
                guildId={guildId}
                row={row}
                taken={taken}
                prefix={`${path}.components.${index}.buttons`}
                errors={errors}
                placeholders={placeholders}
                onChange={(next) =>
                  onChange(rows.map((current, at) => (at === index ? next : current)))
                }
                onRemove={() => drop(index)}
              />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
              <div className="panel-sunken inline inline-8" key={index}>
                <span className="text-sm text-danger">
                  {errors.at(`${path}.components.${index}`) ?? SELECT_ROW}
                </span>
                <span className="push-right">
                  <IconButton
                    icon="trash"
                    tone="ghost"
                    size="sm"
                    label={`Remove row ${index + 1}`}
                    onClick={() => drop(index)}
                  />
                </span>
              </div>
            ),
          )}
        </div>
      )}
    </Section>
  );
}

export function MessageSections({
  guildId,
  form,
  kind,
  path,
  message,
  contentLabel,
  silentNote,
  onChange,
}: {
  guildId: string;
  form: Form;
  kind: AchievementMessageKind;
  path: string;
  message: AnnouncementMessage;
  contentLabel: string;
  silentNote: string;
  onChange: (next: AnnouncementMessage) => void;
}): ReactElement {
  const placeholders = placeholderSlot(ACHIEVEMENT_SURFACES[kind], form.templateDiagnosticsAt);
  // interactiveKeys walks a layout too, so its own button reports against `components`.
  const componentsError = form.errorAt(`${path}.components`);

  return (
    <>
      {message.v2.length > 0 ? (
        <Section label="Layout" help={LAYOUT_HELP}>
          <Rows>
            <SettingRow
              title="Components"
              description="Remove the layout to write text, embeds and link buttons instead."
              error={form.errorAt(`${path}.v2`) ?? componentsError}
              note={`${countV2Components(message.v2)} / ${V2_COMPONENTS_MAX} components`}
            >
              <Button
                tone="danger-quiet"
                size="sm"
                icon="trash"
                onClick={() => onChange({ ...message, v2: [] })}
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
            contentLabel={contentLabel}
            contentDescription={CONTENT_DESCRIPTION}
            errorAt={form.errorAt}
            pathPrefix={path}
            onChange={(next) => onChange({ ...message, ...next })}
          />

          <LinkButtons
            guildId={guildId}
            form={form}
            kind={kind}
            path={path}
            rows={message.components}
            onChange={(components) => onChange({ ...message, components })}
          />
        </>
      )}

      {isSilentMessage(message) ? <p className="achievements-note">{silentNote}</p> : null}

      {isDirectMessageKind(kind) ? (
        <Section label="Mentions">
          <p className="section-intro">{DM_MENTIONS_NOTE}</p>
        </Section>
      ) : (
        <Mentions
          value={message.mentions}
          onChange={(mentions) => onChange({ ...message, mentions })}
        />
      )}
    </>
  );
}

function channelFacts(channel: GuildChannel): ChannelFacts {
  return { id: channel.id, name: channel.name, type: channel.type, parentId: channel.parentId };
}

function useChannel(guildId: string, id: string | null): GuildChannel | undefined {
  const { data } = useQuery({ ...channelsQuery(guildId), enabled: id !== null });
  return id === null ? undefined : (data ?? []).find((channel) => channel.id === id);
}

function MessagePreview({
  config,
  route,
  destination,
  silentPreview,
}: {
  config: AchievementsConfig;
  route: MessageRoute;
  destination: GuildChannel | undefined;
  silentPreview: string;
}): ReactElement {
  const preview = useMemo(() => {
    const sample = sampleOf(route.kind);
    const rendered = previewMessage(ACHIEVEMENT_SURFACES[route.kind], route.message, sample, {
      timeZone: config.timezone,
      ...(route.destination === 'channel' && destination !== undefined
        ? { destinationChannel: channelFacts(destination) }
        : {}),
    });

    const channelName =
      route.destination === 'dm'
        ? undefined
        : route.destination === 'channel'
          ? destination?.name
          : (sample.facts.originChannel?.name ?? undefined);

    return {
      rendered,
      channelName,
      notes: previewNotes(route.kind, route.basePath, rendered.diagnostics),
    };
  }, [config.timezone, route, destination]);

  const silent = isSilentMessage(route.message);

  return (
    <>
      <DiscordPreview
        message={preview.rendered.message}
        mentionNames={preview.rendered.mentionNames}
        now={preview.rendered.now}
        botName="Proton"
        channelName={preview.channelName}
        empty={silentPreview}
      />
      {silent ? null : <p className="achievements-note">{preview.rendered.caption}</p>}
      {!silent && route.destination === 'dm' ? (
        <p className="achievements-note">{PREVIEW_DM}</p>
      ) : null}
      {preview.rendered.problem !== undefined ? (
        <p className="achievements-note">
          <span className="text-danger">{PREVIEW_REFUSED}</span>
        </p>
      ) : null}
      {preview.notes.map((note) => (
        <p key={note} className="achievements-note">
          {note}
        </p>
      ))}
    </>
  );
}

function Test({
  guildId,
  form,
  route,
}: {
  guildId: string;
  form: Form;
  route: MessageRoute;
}): ReactElement | null {
  return (
    <TestMessage
      guildId={guildId}
      moduleId="achievements"
      simulations={form.view.simulations}
      simulationId={SIMULATION_IDS[route.kind]}
      draft={form.value as unknown as Record<string, unknown>}
      dirty={form.dirty}
      configuredChannelId={route.destination === 'channel' ? route.channelId : null}
      refusal={isSilentMessage(route.message) ? EMPTY_REFUSAL : undefined}
    />
  );
}

function UnlockAnnouncement({ guildId, form }: { guildId: string; form: Form }): ReactElement {
  const config = form.value;
  const settings = config.announcement;
  const route = useMemo(() => unlockRoute(config, null), [config]);
  const destination = useChannel(
    guildId,
    settings.destination === 'channel' ? (settings.channelId ?? null) : null,
  );

  const set = (patch: Partial<AchievementsConfig['announcement']>): void =>
    form.setValue((current) => ({
      ...current,
      announcement: { ...current.announcement, ...patch },
    }));

  const off = settings.destination === 'none';

  const editor = (
    <>
      <Section label={UNLOCK_LABEL} help={UNLOCK_HELP}>
        <Rows>
          <SettingRow
            title="Where"
            description={DESTINATION_DESCRIPTION[settings.destination]}
            error={form.errorAt('announcement.destination')}
            stacked
          >
            <SegmentedControl<Destination>
              label="Where to announce achievements"
              options={DESTINATION_OPTIONS}
              value={settings.destination}
              onChange={(next) => form.setValue((current) => withUnlockDestination(current, next))}
            />
          </SettingRow>

          {settings.destination === 'channel' ? (
            <SettingRow title="Channel" error={form.errorAt('announcement.channelId')}>
              <ChannelPicker
                guildId={guildId}
                label="Announcement channel"
                allowNone={false}
                types={ANNOUNCE_CHANNEL_TYPES}
                invalid={form.errorAt('announcement.channelId') !== undefined}
                value={settings.channelId ?? null}
                onChange={(channelId) => {
                  if (channelId !== null) set({ channelId });
                }}
              />
            </SettingRow>
          ) : null}

          {settings.destination === 'current' ? (
            <SettingRow
              title={FALLBACK_TITLE}
              description={FALLBACK_DESCRIPTION}
              note={settings.fallback === 'none' ? FALLBACK_NONE_NOTE : undefined}
              error={form.errorAt('announcement.fallback')}
              stacked
            >
              <SegmentedControl<Fallback>
                label={FALLBACK_TITLE}
                options={FALLBACK_OPTIONS}
                value={settings.fallback}
                onChange={(fallback) => set({ fallback })}
              />
            </SettingRow>
          ) : null}

          {settings.destination === 'current' && settings.fallback === 'channel' ? (
            <SettingRow
              title="Fallback channel"
              error={form.errorAt('announcement.fallbackChannelId')}
            >
              <ChannelPicker
                guildId={guildId}
                label="Fallback channel"
                allowNone={false}
                types={ANNOUNCE_CHANNEL_TYPES}
                invalid={form.errorAt('announcement.fallbackChannelId') !== undefined}
                value={settings.fallbackChannelId ?? null}
                onChange={(fallbackChannelId) => {
                  if (fallbackChannelId !== null) set({ fallbackChannelId });
                }}
              />
            </SettingRow>
          ) : null}

          <SettingRow
            title={ATTACH_TITLE}
            description={ATTACH_DESCRIPTION}
            help={ATTACH_HELP}
            note={
              settings.attachBadge && !off && settings.message.v2.length > 0
                ? ATTACH_LAYOUT_NOTE
                : undefined
            }
            error={form.errorAt('announcement.attachBadge')}
          >
            <Switch
              label={ATTACH_TITLE}
              checked={settings.attachBadge}
              onChange={(attachBadge) => set({ attachBadge })}
            />
          </SettingRow>
        </Rows>
      </Section>

      {off || route === null ? null : (
        <MessageSections
          guildId={guildId}
          form={form}
          kind={route.kind}
          path={route.basePath}
          message={settings.message}
          contentLabel="Announcement"
          silentNote={SILENT_UNLOCK}
          onChange={(message) => set({ message })}
        />
      )}
    </>
  );

  return (
    <EditorPreviewLayout
      editor={editor}
      previewTitle="Discord preview"
      previewActions={
        off || route === null ? null : <Test guildId={guildId} form={form} route={route} />
      }
      preview={
        off || route === null ? (
          <DiscordPreview message={undefined} empty={PREVIEW_OFF} />
        ) : (
          <MessagePreview
            config={config}
            route={route}
            destination={destination}
            silentPreview={PREVIEW_EMPTY}
          />
        )
      }
    />
  );
}

function AlmostThere({ guildId, form }: { guildId: string; form: Form }): ReactElement {
  const config = form.value;
  const settings = config.almostThere;
  const route = useMemo(() => almostThereRoute(config), [config]);
  const destination = useChannel(
    guildId,
    settings.destination === 'channel' ? (settings.channelId ?? null) : null,
  );

  const set = (patch: Partial<AchievementsConfig['almostThere']>): void =>
    form.setValue((current) => ({
      ...current,
      almostThere: { ...current.almostThere, ...patch },
    }));

  const cooldownError = form.errorAt('almostThere.cooldown');

  const editor = (
    <>
      <Section label={ALMOST_LABEL} intro={ALMOST_INTRO}>
        <Rows>
          <SettingRow
            title="Where"
            description={ALMOST_DESCRIPTION[settings.destination]}
            error={form.errorAt('almostThere.destination')}
            stacked
          >
            <SegmentedControl<AlmostDestination>
              label="Where to send reminders"
              options={ALMOST_OPTIONS}
              value={settings.destination}
              onChange={(next) => set({ destination: next })}
            />
          </SettingRow>

          {settings.destination === 'channel' ? (
            <SettingRow title="Channel" error={form.errorAt('almostThere.channelId')}>
              <ChannelPicker
                guildId={guildId}
                label="Reminder channel"
                allowNone={false}
                types={ANNOUNCE_CHANNEL_TYPES}
                invalid={form.errorAt('almostThere.channelId') !== undefined}
                value={settings.channelId ?? null}
                onChange={(channelId) => {
                  if (channelId !== null) set({ channelId });
                }}
              />
            </SettingRow>
          ) : null}

          <SettingRow title="Cooldown" description={COOLDOWN_DESCRIPTION} error={cooldownError}>
            <DurationInput
              label="Reminder cooldown"
              value={settings.cooldown}
              min={ALMOST_COOLDOWN_MIN_MS}
              max={ALMOST_COOLDOWN_MAX_MS}
              units={['h', 'd', 'w']}
              invalid={cooldownError !== undefined}
              onChange={(cooldown) => set({ cooldown })}
            />
          </SettingRow>
        </Rows>
      </Section>

      <MessageSections
        guildId={guildId}
        form={form}
        kind={route.kind}
        path={route.basePath}
        message={settings.message}
        contentLabel="Reminder"
        silentNote={SILENT_ALMOST}
        onChange={(message) => set({ message })}
      />
    </>
  );

  return (
    <EditorPreviewLayout
      editor={editor}
      previewTitle="Discord preview"
      previewActions={<Test guildId={guildId} form={form} route={route} />}
      preview={
        <MessagePreview
          config={config}
          route={route}
          destination={destination}
          silentPreview={PREVIEW_EMPTY}
        />
      }
    />
  );
}

export function AnnouncementsArea({
  guildId,
  form,
}: {
  guildId: string;
  form: Form;
  meta: ModuleMeta;
  summary: ModuleSummary | undefined;
}): ReactElement {
  return (
    <div className="achievements-ann-stack">
      <UnlockAnnouncement guildId={guildId} form={form} />
      <AlmostThere guildId={guildId} form={form} />
    </div>
  );
}
