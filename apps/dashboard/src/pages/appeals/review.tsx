import type { ReactElement } from 'react';
import { ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import { LimitCounter } from '../../components/ui/collection.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { type AppealsForm, REVIEW_CHANNEL_TYPES, setOptional } from './shape.ts';

const REVIEWERS_MAX = 25;

const NO_REVIEWERS = 'Only members with Manage Server can decide appeals.';

export function ReviewArea({
  form,
  guildId,
}: {
  form: AppealsForm;
  guildId: string;
}): ReactElement {
  const config = form.value;

  const stranded = config.reviewChannelId
    ? 0
    : config.panels.filter((panel) => panel.enabled && panel.reviewChannelId === undefined).length;

  return (
    <Section label="Decisions">
      <Rows>
        <SettingRow
          title="Default review channel"
          description="Where appeals are posted when their form has no review channel."
          error={form.errorAt('reviewChannelId')}
          note={
            stranded === 0
              ? undefined
              : `${stranded} ${stranded === 1 ? 'form has' : 'forms have'} no review channel either, so appeals sent through ${stranded === 1 ? 'it' : 'them'} have nowhere to go.`
          }
        >
          <ChannelPicker
            guildId={guildId}
            label="Default review channel"
            noneLabel="No channel"
            placeholder="Choose a channel"
            types={REVIEW_CHANNEL_TYPES}
            invalid={form.errorAt('reviewChannelId') !== undefined}
            value={config.reviewChannelId ?? null}
            onChange={(next) =>
              form.setValue((current) => setOptional(current, 'reviewChannelId', next ?? ''))
            }
          />
        </SettingRow>

        <SettingRow
          stacked
          title="Reviewer roles"
          badge={
            <LimitCounter
              used={config.reviewerRoleIds.length}
              ceiling={REVIEWERS_MAX}
              label="roles"
            />
          }
          description="Members with these roles or Manage Server can accept or turn down appeals on every form."
          error={form.errorAt('reviewerRoleIds')}
          note={config.reviewerRoleIds.length === 0 ? NO_REVIEWERS : undefined}
        >
          <RoleMultiPicker
            guildId={guildId}
            label="Reviewer roles"
            max={REVIEWERS_MAX}
            requireAssignable={false}
            invalid={form.errorAt('reviewerRoleIds') !== undefined}
            value={config.reviewerRoleIds}
            onChange={(next) => form.setValue((current) => ({ ...current, reviewerRoleIds: next }))}
          />
        </SettingRow>
      </Rows>

      <p className="appeals-note">
        Appeals are accepted or turned down on the card Proton posts in the review channel, not in
        the dashboard.
      </p>
    </Section>
  );
}
