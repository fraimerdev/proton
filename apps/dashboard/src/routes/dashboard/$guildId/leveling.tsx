import {
  EMPTY_MESSAGE,
  type LeaderboardResult,
  leaderboardQuerySchema,
  type ModuleSummary,
} from '@proton/core';
import {
  levelUpMessageSchema,
  type RoleReward,
  roleRewardsSchema,
} from '@proton/module-leveling/config';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, lazyRouteComponent, useNavigate } from '@tanstack/react-router';
import { type ReactElement, useEffect } from 'react';
import { FieldRow, SectionCard, SettingsGrid } from '../../../components/form/section.tsx';
import { CardShow, CardShows } from '../../../components/leveling/card-shows.tsx';
import { RoleRewardsEditor } from '../../../components/leveling/role-rewards.tsx';
import { XpCurve } from '../../../components/leveling/xp-curve.tsx';
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
  ModuleChrome,
  ModuleSettings,
  tabsFor,
} from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';
import type { ModuleView, ViewEntry } from '../../../components/module/views.ts';
import { viewSearchUpdate } from '../../../components/module/views.ts';
import { Icon } from '../../../components/shell/icon.tsx';
import { moduleState } from '../../../components/shell/module-meta.ts';
import { useToggleModule } from '../../../components/shell/module-toggle.tsx';
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
          tabs={tabsFor(VIEWS, search.view, area?.id, AREAS)}
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

  return (
    <ModuleSettings form={form}>
      <OffBand summary={form.summary} />

      {area?.id === 'earning' ? <EarningArea form={form} /> : null}
      {area?.id === 'levelup' ? <LevelUpArea form={form} /> : null}
      {area?.id === 'rewards' ? <RewardsArea form={form} /> : null}
      {area?.id === 'card' ? <CardArea form={form} /> : null}
    </ModuleSettings>
  );
}

function OffBand({ summary }: { summary: ModuleSummary }): ReactElement | null {
  const toggle = useToggleModule();
  if (moduleState(summary) !== 'off') return null;

  return (
    <div className="module-off">
      <Icon name="lightning-slash" />
      <p className="module-off-text">
        {summary.name} is switched off. These settings are saved, and nothing runs in this server
        until you switch it on.
      </p>
      <button type="button" className="button button-quiet" onClick={() => toggle(summary, true)}>
        Switch {summary.name} on
      </button>
    </div>
  );
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function Curve({ form }: { form: ModuleForm }): ReactElement {
  return (
    <XpCurve
      rewards={form.value('roleRewards', []) as RoleReward[]}
      roles={form.roles}
      xpMin={num(form.value('xpPerMessageMin', 15), 15)}
      xpMax={num(form.value('xpPerMessageMax', 25), 25)}
    />
  );
}

function EarningArea({ form }: { form: ModuleForm }): ReactElement {
  return (
    <SettingsGrid>
      {/* First, and full width: a level is a number nobody can read out of a pair of XP bounds,
          and the rewards are what make the shape of it matter. */}
      <SectionCard
        id="leveling:curve"
        title="The curve"
        hint="What each level costs, and where this server’s rewards land on it."
        span="full"
      >
        <Curve form={form} />
      </SectionCard>

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
        <ChannelField
          path="afkChannelId"
          label="AFK channel"
          help="Minutes spent in this channel earn nothing"
          channelTypes={[2, 13]}
          optional
        />
      </SectionCard>

      <SectionCard
        id="leveling:exclusions"
        title="Exclusions"
        hint="Messages in these channels, and members holding these roles, earn no XP."
        span="full"
      >
        <Tokens
          path="excludedChannelIds"
          kind="channel-id"
          label="Excluded channels"
          channelTypes={POSTABLE_CHANNEL_TYPES}
          maxItems={50}
        />
        <Tokens path="excludedRoleIds" kind="role-id" label="Excluded roles" maxItems={50} />
      </SectionCard>
    </SettingsGrid>
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
    <FieldRow>
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
    </FieldRow>
  );
}

function LevelUpArea({ form }: { form: ModuleForm }): ReactElement {
  const levelUpMessage = form.value('levelUpMessage', EMPTY_MESSAGE);

  // The builder validates against core's messageSchema, which allows any button; the stored field
  // is narrower and takes link buttons only. Gated here so a finished non-link button stops Save
  // rather than rejecting every other Leveling edit at the API.
  usePanelSchema('levelUpMessage', 'Level-up message', levelUpMessageSchema, levelUpMessage);

  return (
    <SettingsGrid>
      <SectionCard id="leveling:panel:levelUpMessage" title="Level-up announcement" span="full">
        <ChannelField
          path="levelUpChannelId"
          label="Level-up channel"
          help="Empty posts in the member’s channel, silencing voice level-ups"
          channelTypes={ANNOUNCE_CHANNEL_TYPES}
          optional
        />
        <LevelUpMessageEditor
          message={levelUpMessage}
          onChange={(next) => form.set('levelUpMessage', next)}
          channels={form.channels}
          roles={form.roles}
        />
      </SectionCard>
    </SettingsGrid>
  );
}

function RewardsArea({ form }: { form: ModuleForm }): ReactElement {
  const rewards = form.value('roleRewards', []) as RoleReward[];
  usePanelSchema('roleRewards', 'Role rewards', roleRewardsSchema, rewards);

  return (
    <SettingsGrid>
      {/* The plot and the editor are one region: a level typed below moves its flag above, which is
          the only way to see that level 5 and level 50 are not the same distance apart. */}
      <SectionCard id="leveling:panel:roleRewards" title="Role rewards" span="full">
        <Curve form={form} />
        <Choice
          path="rewardMode"
          label="Reward mode"
          options={['stack', 'replace']}
          defaultValue="stack"
        />
        <RoleRewardsEditor
          rewards={rewards}
          roles={form.roles}
          onChange={(next) => form.set('roleRewards', next)}
        />
      </SectionCard>
    </SettingsGrid>
  );
}

function CardArea({ form }: { form: ModuleForm }): ReactElement {
  return (
    <SettingsGrid>
      <SectionCard
        id="leveling:card"
        title="Rank card"
        hint="Whether /rank draws an image at all, and how it looks."
      >
        <Toggle path="rankCard" label="Draw a card for /rank" defaultValue={false} />
        <Choice
          path="cardPreset"
          label="Card style"
          options={['midnight', 'aurora', 'parchment']}
          defaultValue="midnight"
        />
        <Colour path="cardAccent" label="Accent colour" />
        <Text
          path="cardBackgroundUrl"
          label="Background image"
          help="Only images hosted on Discord’s CDN load"
          maxLength={2048}
          optional
        />

        {/* One decision with three parts, on the row with the rest of the card's look, rather than a
            card of its own holding three switches. */}
        <CardShows label="What the card shows">
          <CardShow path="cardShowRank" label="Rank number" />
          <CardShow path="cardShowPercent" label="Progress percentage" />
          <CardShow path="cardShowTotalXp" label="Total XP" />
        </CardShows>
      </SectionCard>

      {/* Second, so it lands beside the settings that redraw it rather than under them. Every
          control in the card beside this one changes what this picture is, and a preview at the foot
          of the page is one the admin has to scroll away from to use. */}
      <SectionCard id="leveling:panel:preview" title="Rank card preview">
        <RankCardPreview config={form.live} guildId={form.guildId} />
      </SectionCard>
    </SettingsGrid>
  );
}
