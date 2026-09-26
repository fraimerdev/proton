import { TIER_LABELS } from '@proton/cards/design';
import {
  type ChannelFacts,
  type PathDiagnostic,
  SAMPLE_NOW,
  type SurfaceSample,
} from '@proton/core/placeholders';
import {
  type Achievement,
  type AchievementAnnouncement,
  type AchievementsConfig,
  type AnnouncementMessage,
  isSilentMessage,
} from '@proton/module-achievements/config';
import {
  ACHIEVEMENT_SURFACES,
  type AchievementMessageKind,
  type AchievementPlaceholderFacts,
  type MessageRoute,
  previewFacts,
  unlockRoute,
} from '@proton/module-achievements/placeholders';
import { triggerOf } from '@proton/module-achievements/triggers';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { sentence } from '../../components/discord/embed-editor.tsx';
import { EditorPreviewLayout } from '../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { ModuleLink } from '../../components/module/route.tsx';
import { TestMessage } from '../../components/module/test-message.tsx';
import { Button, SegmentedControl, type SegmentedOption } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import type { GuildChannel } from '../../lib/discord.ts';
import { previewMessage } from '../../lib/placeholder-preview.ts';
import { channelsQuery, rolesQuery } from '../../lib/queries.ts';
import { MessageSections } from './announcements.tsx';

type Mode = AchievementAnnouncement['mode'];

type Destination = NonNullable<AchievementAnnouncement['destination']>;

type ModuleAnnouncement = AchievementsConfig['announcement'];

type Update = (next: (current: Achievement) => Achievement) => void;

const MODE_OPTIONS: readonly SegmentedOption<Mode>[] = [
  { value: 'default', label: 'Server default' },
  { value: 'custom', label: 'Custom' },
  { value: 'off', label: 'Don’t announce' },
];

const DESTINATION_OPTIONS: readonly SegmentedOption<Destination>[] = [
  { value: 'current', label: 'Current channel' },
  { value: 'channel', label: 'Channel' },
  { value: 'dm', label: 'DM' },
];

const MODE_TITLE = 'When a member earns it';

const OFF_NOTE = 'Proton posts nothing when a member earns it. Rewards are still given.';

const DEFAULT_LINK = 'Change it in Announcements';

const DESTINATION_DESCRIPTION: Record<Destination, string> = {
  current:
    'Posted in the channel where the member earned it. If it’s earned outside a channel, the ' +
    'fallback set in Announcements is used.',
  channel: 'Posted in one channel you choose.',
  dm: 'Sent to the member by DM. Members who don’t accept DMs from the server don’t get it.',
};

const NOWHERE_BODY =
  'None of these requirements happen in a channel, and Announcements has no fallback set, so ' +
  'nothing will be posted.';

const NOWHERE_FIX: Record<'default' | 'custom', string> = {
  default: 'Choose Custom, or set a fallback in Announcements.',
  custom: 'Choose Channel or DM, or set a fallback in Announcements.',
};

const NO_MESSAGE = 'This announcement has no message yet.';

const SILENT_NOTE = 'This message is empty, so nothing is posted when a member earns it.';

const PREVIEW_EMPTY = 'This message is empty, so nothing is posted.';

const OFF_PREVIEW = 'Nothing is posted for this achievement.';

const NONE_PREVIEW = 'The server default is not to announce, so nothing is posted.';

const PREVIEW_REFUSED =
  'With this sample filled in, the message couldn’t be posted, so nothing would appear. The ' +
  'preview shows it as written.';

const TRY_IT_CAPTION = 'Tiers and progress follow the Try it values on the Requirements tab.';

const EMPTY_REFUSAL = 'Write something in the message before testing it.';

const PREVIEW_NOTE_CODES: ReadonlySet<string> = new Set(['output_truncated', 'invalid_url']);

function channelLabel(channel: GuildChannel | undefined, fallback: string): string {
  return channel === undefined ? fallback : `#${channel.name}`;
}

export function withMode(
  achievement: Achievement,
  mode: Mode,
  module: ModuleAnnouncement,
): Achievement {
  if (achievement.announcement.mode === mode) return achievement;
  if (mode !== 'custom') return { ...achievement, announcement: { mode } };

  const destination: Destination = module.destination === 'none' ? 'current' : module.destination;
  const channelId = destination === 'channel' ? module.channelId : undefined;

  return {
    ...achievement,
    announcement: {
      mode,
      destination,
      ...(channelId === undefined ? {} : { channelId }),
      message: structuredClone(module.message),
    },
  };
}

export function withDestination(
  achievement: Achievement,
  destination: Destination,
  suggestedChannelId: string | undefined,
): Achievement {
  const { channelId, ...rest } = achievement.announcement;
  const kept = destination === 'channel' ? (channelId ?? suggestedChannelId) : undefined;

  return {
    ...achievement,
    announcement:
      kept === undefined ? { ...rest, destination } : { ...rest, destination, channelId: kept },
  };
}

export function hasFallback(module: ModuleAnnouncement): boolean {
  return (
    module.fallback === 'dm' ||
    (module.fallback === 'channel' && module.fallbackChannelId !== undefined)
  );
}

export function announcesNowhere(config: AchievementsConfig, achievement: Achievement): boolean {
  const route = unlockRoute(config, achievement);
  if (route === null || route.destination !== 'current') return false;
  if (hasFallback(config.announcement)) return false;

  return achievement.requirements.every(
    (requirement) => !triggerOf(requirement.trigger).originChannel,
  );
}

export function defaultSummary(
  module: ModuleAnnouncement,
  channelOf: (id: string) => GuildChannel | undefined,
): string {
  switch (module.destination) {
    case 'current': {
      const fallback =
        module.fallback === 'dm'
          ? ', or by DM when it was earned outside a channel'
          : module.fallback === 'channel' && module.fallbackChannelId !== undefined
            ? `, or in ${channelLabel(channelOf(module.fallbackChannelId), 'the fallback channel')} when it was earned outside a channel`
            : '';
      return `The server default posts it in the channel where it was earned${fallback}.`;
    }
    case 'channel':
      return module.channelId === undefined
        ? 'The server default posts it in an announcement channel that isn’t set yet.'
        : `The server default posts it in ${channelLabel(channelOf(module.channelId), 'the announcement channel')}.`;
    case 'dm':
      return 'The server default sends it to the member by DM.';
    case 'none':
      return NONE_PREVIEW;
  }
}

function sampleOf(kind: AchievementMessageKind): SurfaceSample<AchievementPlaceholderFacts> {
  const [sample] = ACHIEVEMENT_SURFACES[kind].samples;
  if (sample === undefined) {
    throw new Error(
      'The achievement announcement placeholders have no sample, so the preview cannot be filled in.',
    );
  }
  return sample;
}

function captionOf(facts: AchievementPlaceholderFacts, dm: boolean): string {
  const who = facts.user?.globalName ?? facts.user?.username ?? 'A sample member';
  const tier = facts.tier === 'single' ? '' : ` (${TIER_LABELS[facts.tier]})`;
  return `Sample: ${who} earning ${facts.achievement.name}${tier}${dm ? ', sent by DM' : ''}.`;
}

function channelFacts(channel: GuildChannel): ChannelFacts {
  return { id: channel.id, name: channel.name, type: channel.type, parentId: channel.parentId };
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

function usePreview({
  config,
  achievement,
  route,
  tryValues,
  roleNames,
  destination,
}: {
  config: AchievementsConfig;
  achievement: Achievement;
  route: MessageRoute | null;
  tryValues: Record<string, number>;
  roleNames: Readonly<Record<string, string>>;
  destination: GuildChannel | undefined;
}) {
  return useMemo(() => {
    if (route === null || route.destination === 'none') return null;

    const hasOrigin = achievement.requirements.some(
      (requirement) => triggerOf(requirement.trigger).originChannel,
    );

    const facts = previewFacts(config, achievement, {
      kind: route.kind,
      now: SAMPLE_NOW,
      values: tryValues,
      roleNames,
      ...(hasOrigin ? {} : { originChannel: null }),
      ...(route.destination === 'channel' && destination !== undefined
        ? { destinationChannel: channelFacts(destination) }
        : {}),
    });

    const rendered = previewMessage(
      ACHIEVEMENT_SURFACES[route.kind],
      route.message,
      sampleOf(route.kind),
      facts,
    );

    const channelName =
      route.destination === 'dm'
        ? undefined
        : route.destination === 'channel'
          ? destination?.name
          : (facts.originChannel?.name ?? undefined);

    return {
      rendered,
      channelName,
      caption: captionOf(facts, route.destination === 'dm'),
      notes: previewNotes(route.kind, route.basePath, rendered.diagnostics),
    };
  }, [config, achievement, route, tryValues, roleNames, destination]);
}

export function AnnouncementTab({
  guildId,
  form,
  index,
  achievement,
  tryValues,
}: {
  guildId: string;
  form: ModuleForm<AchievementsConfig>;
  index: number;
  achievement: Achievement;
  tryValues: Record<string, number>;
}): ReactElement {
  const config = form.value;
  const base = `achievements.${index}`;
  const path = `${base}.announcement.message`;
  const { announcement } = achievement;
  const custom = announcement.mode === 'custom' ? announcement : null;

  const route = useMemo(() => unlockRoute(config, achievement), [config, achievement]);

  const module = config.announcement;
  const wantsChannels =
    route?.destination === 'channel' ||
    (announcement.mode === 'default' &&
      (module.destination === 'channel' || module.fallback === 'channel'));

  const { data: channels } = useQuery({ ...channelsQuery(guildId), enabled: wantsChannels });
  const roleRewards = achievement.tiers.some((tier) =>
    tier.rewards.some((reward) => reward.kind !== 'xp'),
  );
  const { data: roles } = useQuery({ ...rolesQuery(guildId), enabled: roleRewards });

  const roleNames = useMemo(
    () => Object.fromEntries((roles ?? []).map((role) => [role.id, role.name])),
    [roles],
  );

  const channelOf = (id: string): GuildChannel | undefined =>
    (channels ?? []).find((channel) => channel.id === id);

  const destination =
    route?.destination === 'channel' && route.channelId !== null
      ? channelOf(route.channelId)
      : undefined;

  const preview = usePreview({ config, achievement, route, tryValues, roleNames, destination });

  const update: Update = (next) =>
    form.setValue((current) => ({
      ...current,
      achievements: current.achievements.map((item, at) => (at === index ? next(item) : item)),
    }));

  const setMessage = (message: AnnouncementMessage): void =>
    update((current) => ({ ...current, announcement: { ...current.announcement, message } }));

  const nowhere = announcesNowhere(config, achievement);
  const testable = route !== null && route.destination !== 'none';

  const modeNote =
    announcement.mode === 'default' ? (
      <>
        {defaultSummary(module, channelOf)}{' '}
        <ModuleLink guildId={guildId} moduleId="achievements" search={{ area: 'announcements' }}>
          {DEFAULT_LINK}
        </ModuleLink>
      </>
    ) : announcement.mode === 'off' ? (
      OFF_NOTE
    ) : undefined;

  const customDestination = custom?.destination ?? 'current';

  const editor = (
    <>
      <Section label="Announcement">
        <div className="stack stack-10">
          <Rows>
            <SettingRow
              title={MODE_TITLE}
              description={modeNote}
              error={form.errorAt(`${base}.announcement.mode`)}
            >
              <SegmentedControl<Mode>
                label={MODE_TITLE}
                options={MODE_OPTIONS}
                value={announcement.mode}
                onChange={(mode) => update((current) => withMode(current, mode, module))}
              />
            </SettingRow>

            {custom !== null ? (
              <SettingRow
                title="Where"
                description={DESTINATION_DESCRIPTION[customDestination]}
                error={form.errorAt(`${base}.announcement.destination`)}
              >
                <SegmentedControl<Destination>
                  label="Where to announce it"
                  options={DESTINATION_OPTIONS}
                  value={customDestination}
                  onChange={(next) =>
                    update((current) => withDestination(current, next, module.channelId))
                  }
                />
              </SettingRow>
            ) : null}

            {custom !== null && customDestination === 'channel' ? (
              <SettingRow title="Channel" error={form.errorAt(`${base}.announcement.channelId`)}>
                <ChannelPicker
                  guildId={guildId}
                  label="Announcement channel"
                  allowNone={false}
                  invalid={form.errorAt(`${base}.announcement.channelId`) !== undefined}
                  value={custom.channelId ?? null}
                  onChange={(channelId) => {
                    if (channelId === null) return;
                    update((current) => ({
                      ...current,
                      announcement: { ...current.announcement, channelId },
                    }));
                  }}
                />
              </SettingRow>
            ) : null}

            {custom !== null && custom.message === undefined ? (
              <SettingRow title="Message" description={NO_MESSAGE} error={form.errorAt(path)}>
                <Button size="sm" onClick={() => setMessage(structuredClone(module.message))}>
                  Start from the server default
                </Button>
              </SettingRow>
            ) : null}
          </Rows>

          {nowhere ? (
            <StatusBanner tone="warning">
              {NOWHERE_BODY} {NOWHERE_FIX[custom !== null ? 'custom' : 'default']}
            </StatusBanner>
          ) : null}
        </div>
      </Section>

      {custom?.message !== undefined && route !== null ? (
        <MessageSections
          guildId={guildId}
          form={form}
          kind={route.kind}
          path={path}
          message={custom.message}
          contentLabel="Announcement"
          silentNote={SILENT_NOTE}
          onChange={setMessage}
        />
      ) : null}
    </>
  );

  return (
    <EditorPreviewLayout
      editor={editor}
      previewTitle="Discord preview"
      previewActions={
        testable ? (
          <TestMessage
            guildId={guildId}
            moduleId="achievements"
            simulations={form.view.simulations}
            simulationId={
              route.kind === 'unlocked_dm' ? 'achievements.unlocked_dm' : 'achievements.unlocked'
            }
            draft={config as unknown as Record<string, unknown>}
            dirty={form.dirty}
            fixed={{ achievement: achievement.id }}
            configuredChannelId={route.destination === 'channel' ? route.channelId : null}
            refusal={isSilentMessage(route.message) ? EMPTY_REFUSAL : undefined}
          />
        ) : null
      }
      preview={
        preview === null ? (
          <DiscordPreview message={undefined} empty={route === null ? OFF_PREVIEW : NONE_PREVIEW} />
        ) : (
          <>
            <DiscordPreview
              message={preview.rendered.message}
              mentionNames={preview.rendered.mentionNames}
              now={preview.rendered.now}
              botName="Proton"
              channelName={preview.channelName}
              empty={PREVIEW_EMPTY}
            />
            {route !== null && isSilentMessage(route.message) ? null : (
              <p className="achievements-note">{preview.caption}</p>
            )}
            {Object.keys(tryValues).length > 0 ? (
              <p className="achievements-note">{TRY_IT_CAPTION}</p>
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
        )
      }
    />
  );
}
