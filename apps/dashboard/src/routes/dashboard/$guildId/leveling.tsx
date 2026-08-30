import { EMPTY_MESSAGE, type LeaderboardResult, leaderboardQuerySchema } from '@proton/core';
import {
  levelUpMessageSchema,
  type RoleReward,
  roleRewardsSchema,
} from '@proton/module-leveling/config';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, lazyRouteComponent, useNavigate } from '@tanstack/react-router';
import { type ReactElement, useEffect } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { RoleRewardsEditor } from '../../../components/leveling/role-rewards.tsx';
import { LEVELING_AREAS as AREAS } from '../../../components/module/area-index.ts';
import type { AreaEntry } from '../../../components/module/areas.ts';
import { activeArea } from '../../../components/module/areas.ts';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import {
  ChannelField,
  Choice,
  Colour,
  Duration,
  Num,
  POSTABLE_CHANNEL_TYPES,
  Text,
  Toggle,
  Tokens,
  usePanelSchema,
} from '../../../components/module/inputs.tsx';
import {
  ActiveView,
  AreaHub,
  ModuleChrome,
  ModuleSettings,
  tabsFor,
} from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';
import type { ModuleView, ViewEntry } from '../../../components/module/views.ts';
import { viewSearchUpdate } from '../../../components/module/views.ts';
import { modulesQuery } from '../../../lib/queries.ts';
import { LIVE, queryKeys, STALE } from '../../../lib/query-keys.ts';

const LevelUpMessageEditor = lazyRouteComponent(
  () => import('../../../components/leveling/level-up-message.tsx'),
  'LevelUpMessageEditor',
);

const RankCardPreview = lazyRouteComponent(
  () => import('../../../components/cards/card-preview.tsx'),
  'RankCardPreview',
);

const ANNOUNCE_CHANNEL_TYPES = [0, 5, 11, 12];

const VIEWS: readonly ModuleView[] = [
  {
    id: 'leaderboard',
    title: 'Leaderboard',
    searchSchema: leaderboardQuerySchema,

    query: ({ guildId, search }) => ({
      queryKey: queryKeys.view(guildId, 'leaderboard', search),

      // Imported lazily: server/modules.ts opens better-auth's database at module scope.
      queryFn: async () =>
        (await import('../../../server/modules.ts')).searchLeaderboard({
          data: { guildId, ...search },
        }),
      staleTime: STALE.browse,
      ...LIVE,
    }),
    View: lazyRouteComponent(
      () => import('../../../components/views/views.tsx'),
      'LeaderboardView',
    ),
  } satisfies ViewEntry<typeof leaderboardQuerySchema, LeaderboardResult>,
];

export const Route = createFileRoute('/dashboard/$guildId/leveling')({
  ...moduleRoute('leveling', {
    areas: AREAS,
    views: VIEWS,
    preload: [LevelUpMessageEditor, RankCardPreview],
  }),
  component: LevelingPage,
});

function LevelingPage(): ReactElement {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();

  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;

  const entry = VIEWS.find((view) => view.id === search.view);
  const area = activeArea(AREAS, search.area);
  const summary = modules.find((candidate) => candidate.id === 'leveling');

  return (
    <>
      {summary ? (
        <ModuleChrome
          guildId={guildId}
          summary={summary}
          area={entry ? undefined : area}
          tabs={tabsFor(VIEWS, search.view, area?.id)}
        />
      ) : null}

      {/* Split out: useModuleForm suspends on three queries the loader skips for a browse tab. */}
      {entry ? (
        <Browse guildId={guildId} entry={entry} />
      ) : (
        <Settings guildId={guildId} area={area} />
      )}
    </>
  );
}

function Browse({ guildId, entry }: { guildId: string; entry: ModuleView }): ReactElement {
  const { viewSearch } = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <ActiveView
      entry={entry}
      guildId={guildId}
      search={viewSearch}
      onSearch={(patch) => void navigate(viewSearchUpdate(patch))}
    />
  );
}

function Settings({
  guildId,
  area,
}: {
  guildId: string;
  area: AreaEntry | undefined;
}): ReactElement {
  const form = useModuleForm(guildId, 'leveling', true);

  if (area === undefined) return <AreaHub areas={AREAS} config={form.config} />;

  return (
    <ModuleSettings form={form}>
      {area.id === 'earning' ? <EarningArea form={form} /> : null}
      {area.id === 'levelup' ? <LevelUpArea form={form} /> : null}
      {area.id === 'rewards' ? <RewardsArea form={form} /> : null}
      {area.id === 'card' ? <CardArea form={form} /> : null}
    </ModuleSettings>
  );
}

function EarningArea({ form }: { form: ModuleForm }): ReactElement {
  return (
    <>
      <SectionCard id="leveling:message" title="Message XP">
        <XpRange form={form} />
        <Duration path="messageCooldown" label="Message cooldown" defaultValue="60s" />
      </SectionCard>

      <SectionCard id="leveling:voice" title="Voice XP">
        <Num
          path="voiceXpPerMinute"
          label="Voice XP per minute"
          help="Credited when the member leaves the voice channel, not during"
          min={0}
          max={100}
          defaultValue={5}
        />
        <ChannelField path="afkChannelId" label="AFK channel" channelTypes={[2, 13]} optional />
      </SectionCard>

      <SectionCard id="leveling:exclusions" title="Exclusions">
        <Tokens
          path="excludedChannelIds"
          kind="channel-id"
          label="Excluded channels"
          channelTypes={POSTABLE_CHANNEL_TYPES}
          maxItems={50}
        />
        <Tokens path="excludedRoleIds" kind="role-id" label="Excluded roles" maxItems={50} />
      </SectionCard>
    </>
  );
}

// The rule rejecting an inverted range sits on the config schema, not the form schema, so without
// this the only thing that reports it is the API refusing the save.
function XpRange({ form }: { form: ModuleForm }): ReactElement {
  const min = form.value('xpPerMessageMin', 15);
  const max = form.value('xpPerMessageMax', 25);
  const inverted = typeof min === 'number' && typeof max === 'number' && min > max;

  const { report } = form;

  useEffect(() => {
    if (!inverted) {
      report('xpPerMessageMin', null);
      return;
    }

    report(
      'xpPerMessageMin',
      `“XP per message (minimum)” must not exceed the maximum (${String(max)}) — the two bounds ` +
        'are a range to roll inside, and an inverted one describes no range at all.',
    );

    return () => report('xpPerMessageMin', null);
  }, [report, inverted, max]);

  return (
    <>
      <Num
        path="xpPerMessageMin"
        label="XP per message (minimum)"
        min={0}
        max={1000}
        defaultValue={15}
      />
      <Num
        path="xpPerMessageMax"
        label="XP per message (maximum)"
        min={0}
        max={1000}
        defaultValue={25}
      />
    </>
  );
}

function LevelUpArea({ form }: { form: ModuleForm }): ReactElement {
  const levelUpMessage = form.value('levelUpMessage', EMPTY_MESSAGE);

  // The builder validates against core's messageSchema, which allows any button; the stored field
  // is narrower and takes link buttons only. Gated here so a finished non-link button stops Save
  // rather than rejecting every other Leveling edit at the API.
  usePanelSchema('levelUpMessage', 'Level-up message', levelUpMessageSchema, levelUpMessage);

  return (
    <>
      <SectionCard id="leveling:announce" title="Level-up announcement">
        <ChannelField
          path="levelUpChannelId"
          label="Level-up channel"
          help="Empty posts in the member’s channel, silencing voice level-ups"
          channelTypes={ANNOUNCE_CHANNEL_TYPES}
          optional
        />
      </SectionCard>

      <SectionCard id="leveling:panel:levelUpMessage" title="Level-up message">
        <LevelUpMessageEditor
          message={levelUpMessage}
          onChange={(next) => form.set('levelUpMessage', next)}
          channels={form.channels}
          roles={form.roles}
        />
      </SectionCard>
    </>
  );
}

function RewardsArea({ form }: { form: ModuleForm }): ReactElement {
  const rewards = form.value('roleRewards', []) as RoleReward[];
  usePanelSchema('roleRewards', 'Role rewards', roleRewardsSchema, rewards);

  return (
    <>
      <SectionCard id="leveling:rewards" title="Role rewards">
        <Choice
          path="rewardMode"
          label="Reward mode"
          options={['stack', 'replace']}
          defaultValue="stack"
        />
      </SectionCard>

      <SectionCard id="leveling:panel:roleRewards" title={null}>
        <RoleRewardsEditor
          rewards={rewards}
          roles={form.roles}
          onChange={(next) => form.set('roleRewards', next)}
        />
      </SectionCard>
    </>
  );
}

function CardArea({ form }: { form: ModuleForm }): ReactElement {
  return (
    <>
      <SectionCard id="leveling:card" title="Rank card">
        <Toggle path="rankCard" label="Rank card" defaultValue={false} />
        <Choice
          path="cardPreset"
          label="Card style"
          options={['midnight', 'aurora', 'parchment']}
          defaultValue="midnight"
        />
        <Colour
          path="cardAccent"
          label="Accent colour"
          help="Colours the progress bar, the rank number and the avatar ring"
        />
        <Text
          path="cardBackgroundUrl"
          label="Background image"
          help="Only images hosted on Discord’s CDN load"
          maxLength={2048}
          optional
        />
        <Toggle path="cardShowRank" label="Show the rank number" defaultValue={true} />
        <Toggle path="cardShowPercent" label="Show progress percentage" defaultValue={true} />
        <Toggle path="cardShowTotalXp" label="Show total XP" defaultValue={true} />
      </SectionCard>

      <SectionCard id="leveling:panel:preview" title="Rank card preview">
        <RankCardPreview config={form.live} guildId={form.guildId} />
      </SectionCard>
    </>
  );
}
