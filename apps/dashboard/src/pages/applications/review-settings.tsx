import {
  type FormConfig,
  type ReviewConfig,
  reviewChannelFor,
  teamFor,
} from '@proton/module-applications/config';
import type { Audience } from '@proton/module-applications/view';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import {
  ChannelName,
  ChannelPicker,
  useChannelIndex,
} from '../../components/discord/channel-picker.tsx';
import { RoleMultiPicker, RoleName } from '../../components/discord/role-picker.tsx';
import { ModuleLink } from '../../components/module/route.tsx';
import { TestMessage } from '../../components/module/test-message.tsx';
import { Chip, SegmentedControl, Switch } from '../../components/ui/controls.tsx';
import { LoadingArea, StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import type { GuildRole } from '../../lib/discord.ts';
import { readFailure } from '../../lib/errors.ts';
import { rolesQuery } from '../../lib/queries.ts';
import { reviewAudienceQuery } from './admin-queries.ts';
import { type ApplicationsForm, joinAnd, updateFormAt, withOptional } from './shape.ts';

export const REVIEW_CHANNEL_TYPES = [0, 5, 11, 12] as const;

const TEAM_MODES = [
  { value: 'default', label: 'Server default' },
  { value: 'form', label: 'This form only' },
] as const;

const CARD_MODES = [
  { value: 'none', label: 'None' },
  { value: 'summary', label: 'Summary' },
  { value: 'full', label: 'Full answers' },
] as const;

const CARD_MODE_TEXT: Readonly<Record<ReviewConfig['cardAnswers'], string>> = {
  none: 'The card shows who applied and when. Staff read the answers in the dashboard.',
  summary: 'The card shows the first three answers, shortened. The rest stay in the dashboard.',
  full: 'The card shows every answer. Only use this in a channel just the review team can read.',
};

const NO_CHANNEL =
  'No review channel is set here or under Settings, so no review card is posted. Staff can still ' +
  'review in the dashboard.';

const SAVED_TEAM = 'Checked against the saved review team. Save to check your changes.';

const LEAKY_CHANNEL =
  'People outside the review team can read this channel, so Proton won’t post answers there. ' +
  'Cards show only the application’s details.';

function roleNames(ids: readonly string[], roles: readonly GuildRole[] | undefined): string[] {
  const byId = new Map((roles ?? []).map((role) => [role.id, role.name]));
  return ids.map((id) => `@${byId.get(id) ?? 'deleted role'}`);
}

function AudienceSummary({
  audience,
  roles,
}: {
  audience: Audience;
  roles: readonly GuildRole[] | undefined;
}): ReactElement {
  const byId = new Map((roles ?? []).map((role) => [role.id, role]));

  if (audience.everyone) {
    return <span className="text-sm text-secondary">Everyone in the server can read it.</span>;
  }

  return (
    <div className="stack stack-6">
      {audience.roleIds.length === 0 ? (
        <span className="text-sm text-secondary">No role can read it on its own.</span>
      ) : (
        <span className="chip-list">
          {audience.roleIds.map((id) => (
            <Chip key={id}>
              <RoleName role={byId.get(id)} id={id} />
            </Chip>
          ))}
        </span>
      )}
      {audience.administratorRoleIds.length > 0 ? (
        <span className="text-xs text-muted">
          Also {joinAnd(roleNames(audience.administratorRoleIds, roles))}, which{' '}
          {audience.administratorRoleIds.length === 1 ? 'has' : 'have'} Administrator.
        </span>
      ) : null}
      {audience.memberCount > 0 ? (
        <span className="text-xs text-muted">
          {audience.memberCount} {audience.memberCount === 1 ? 'member has' : 'members have'} their
          own access too.
        </span>
      ) : null}
    </div>
  );
}

export function ReviewTab({
  form,
  guildId,
  moduleId,
  index,
  current,
  saved,
}: {
  form: ApplicationsForm;
  guildId: string;
  moduleId: string;
  index: number;
  current: FormConfig;
  saved: boolean;
}): ReactElement {
  const config = form.value;
  const review = current.review;
  const path = `forms.${index}.review`;

  const channelId = reviewChannelFor(config, current) ?? null;
  const { byId } = useChannelIndex(guildId);
  const roles = useQuery(rolesQuery(guildId));
  const audience = useQuery(
    reviewAudienceQuery(guildId, channelId, saved ? current.id : undefined),
  );

  const team = teamFor(config, current);
  const teamRoles = [...team.reviewerRoleIds, ...team.deciderRoleIds, ...team.viewerRoleIds];

  const set = (patch: Partial<ReviewConfig>): void =>
    updateFormAt(form, index, (value) => ({ ...value, review: { ...value.review, ...patch } }));

  const outsiders = audience.data === undefined ? [] : audience.data.outsideTeam;
  const leaky =
    audience.data !== undefined && (audience.data.everyone || audience.data.outsideTeam.length > 0);
  const channelName = channelId === null ? undefined : byId.get(channelId)?.name;

  return (
    <>
      <Section
        label="Review team"
        help="Server owners and members with Administrator or Manage Server can always review and decide."
      >
        <Rows>
          <SettingRow
            title="Team"
            description={
              review.useDefaultTeam ? (
                <>
                  Uses the reviewers set under{' '}
                  <ModuleLink guildId={guildId} moduleId={moduleId} search={{ area: 'settings' }}>
                    Settings
                  </ModuleLink>
                  .
                </>
              ) : (
                'Only these roles review this form.'
              )
            }
            note={
              review.useDefaultTeam && teamRoles.length === 0
                ? 'The default team has no roles yet, so only admins can review.'
                : undefined
            }
          >
            <SegmentedControl
              label="Review team"
              options={TEAM_MODES}
              value={review.useDefaultTeam ? 'default' : 'form'}
              onChange={(next) => set({ useDefaultTeam: next === 'default' })}
            />
          </SettingRow>

          {review.useDefaultTeam ? null : (
            <>
              <SettingRow
                stacked
                title="Reviewers"
                description="Read, claim, comment on and vote on applications."
                error={form.errorAt(`${path}.reviewerRoleIds`)}
              >
                <RoleMultiPicker
                  guildId={guildId}
                  label="Add a reviewer role"
                  max={25}
                  requireAssignable={false}
                  value={review.reviewerRoleIds}
                  onChange={(reviewerRoleIds) => set({ reviewerRoleIds })}
                />
              </SettingRow>
              <SettingRow
                stacked
                title="Deciders"
                description="Accept or reject. When empty, reviewers decide."
                error={form.errorAt(`${path}.deciderRoleIds`)}
              >
                <RoleMultiPicker
                  guildId={guildId}
                  label="Add a decider role"
                  max={25}
                  requireAssignable={false}
                  value={review.deciderRoleIds}
                  onChange={(deciderRoleIds) => set({ deciderRoleIds })}
                />
              </SettingRow>
              <SettingRow
                stacked
                title="Viewers"
                description="Read applications without reviewing them."
                error={form.errorAt(`${path}.viewerRoleIds`)}
              >
                <RoleMultiPicker
                  guildId={guildId}
                  label="Add a viewer role"
                  max={25}
                  requireAssignable={false}
                  value={review.viewerRoleIds}
                  onChange={(viewerRoleIds) => set({ viewerRoleIds })}
                />
              </SettingRow>
            </>
          )}
        </Rows>
      </Section>

      <Section
        label="Review channel"
        actions={
          <TestMessage
            guildId={guildId}
            moduleId="applications"
            simulations={form.view.simulations}
            simulationId="applications.review_card"
            draft={config as unknown as Record<string, unknown>}
            dirty={form.dirty}
            fixed={{ formIndex: index }}
            configuredChannelId={channelId}
            label="Test review card"
          />
        }
      >
        <Rows>
          <SettingRow
            title="Channel"
            description="Where Proton posts a review card for each application."
            note={channelId === null ? NO_CHANNEL : undefined}
            error={form.errorAt(`${path}.channelId`)}
          >
            <ChannelPicker
              guildId={guildId}
              label="Review channel"
              noneLabel="Use the default"
              placeholder="Use the default"
              types={REVIEW_CHANNEL_TYPES}
              value={review.channelId ?? null}
              onChange={(next) =>
                updateFormAt(form, index, (value) => ({
                  ...value,
                  review: withOptional(value.review, 'channelId', next ?? undefined),
                }))
              }
            />
          </SettingRow>

          <SettingRow
            stacked
            title="Answers on the card"
            description={CARD_MODE_TEXT[review.cardAnswers]}
          >
            <SegmentedControl
              label="Answers on the card"
              options={CARD_MODES}
              value={review.cardAnswers}
              onChange={(cardAnswers) => set({ cardAnswers })}
            />
          </SettingRow>

          {channelId !== null ? (
            <SettingRow
              stacked
              title={
                <>
                  Who can read{' '}
                  <ChannelName channel={byId.get(channelId)} id={channelId} guildId={guildId} />
                </>
              }
              helpLabel="Who can read the review channel"
              help="Worked out from the channel’s own permission settings. Anyone who can read the channel can read what the card shows, whatever the dashboard allows."
              note={form.dirty ? SAVED_TEAM : undefined}
            >
              {audience.isPending ? (
                <LoadingArea label="Checking the channel" minHeight={48} size="sm" />
              ) : audience.isError ? (
                <span className="text-sm text-danger">
                  {readFailure(audience.error, 'who can read this channel')}
                </span>
              ) : audience.data !== undefined ? (
                <AudienceSummary audience={audience.data} roles={roles.data} />
              ) : null}
            </SettingRow>
          ) : null}

          <SettingRow
            stacked
            title="Ping roles"
            description="Mentioned in the review channel when an application arrives."
            error={form.errorAt(`${path}.pingRoleIds`)}
          >
            <RoleMultiPicker
              guildId={guildId}
              label="Add a role to ping"
              max={10}
              requireAssignable={false}
              value={review.pingRoleIds}
              onChange={(pingRoleIds) => set({ pingRoleIds })}
            />
          </SettingRow>
        </Rows>

        {review.cardAnswers !== 'none' && leaky ? (
          <div className="applications-section-banner">
            <StatusBanner tone="warning" title="Answers need a private channel">
              {LEAKY_CHANNEL}{' '}
              {audience.data?.everyone
                ? `Everyone in the server can read ${channelName === undefined ? 'this channel' : `#${channelName}`}.`
                : `${joinAnd(roleNames(outsiders, roles.data))} ${outsiders.length === 1 ? 'isn’t' : 'aren’t'} on the review team but can read ${channelName === undefined ? 'this channel' : `#${channelName}`}.`}
            </StatusBanner>
          </div>
        ) : null}
      </Section>

      <Section label="Decisions">
        <Rows>
          <SettingRow
            title="Two reviewers"
            description="A decision needs a second reviewer who voted the same way. Nobody reviews their own application."
            help="Members with the reopen role can decide without a second vote. Proton records when they do."
          >
            <Switch
              label="Two reviewers"
              checked={review.requireTwoReviewers}
              onChange={(requireTwoReviewers) => set({ requireTwoReviewers })}
            />
          </SettingRow>
          <SettingRow
            title="Scores"
            description="Reviewers give a score from 1 to 5 with their vote. Scores inform a decision and never make one."
          >
            <Switch
              label="Scores"
              checked={review.scoring}
              onChange={(scoring) => set({ scoring })}
            />
          </SettingRow>
        </Rows>
      </Section>
    </>
  );
}
