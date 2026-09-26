import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import { NumberStepper } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { REVIEW_CHANNEL_TYPES } from './review-settings.tsx';
import { type ApplicationsForm, withOptional } from './shape.ts';

type RoleKey =
  | 'reviewerRoleIds'
  | 'deciderRoleIds'
  | 'viewerRoleIds'
  | 'overrideRoleIds'
  | 'exportRoleIds'
  | 'deleteRoleIds';

type NumberKey =
  | 'draftExpiryDays'
  | 'retentionDays'
  | 'followUpDeadlineDays'
  | 'reviewReminderHours';

const TEAM: readonly { key: RoleKey; title: string; description: string; help?: string }[] = [
  {
    key: 'reviewerRoleIds',
    title: 'Reviewers',
    description: 'Read, claim, comment on and vote on applications.',
  },
  {
    key: 'deciderRoleIds',
    title: 'Deciders',
    description: 'Accept or reject. When empty, reviewers decide.',
  },
  {
    key: 'viewerRoleIds',
    title: 'Viewers',
    description: 'Read applications without reviewing them.',
  },
];

const POWERS: readonly { key: RoleKey; title: string; description: string; help: string }[] = [
  {
    key: 'overrideRoleIds',
    title: 'Reopen',
    description: 'Reopen accepted or rejected applications, on every form.',
    help: 'Reopening needs a reason and never reruns the roles or messages from the first decision. This role can also decide without a second reviewer on forms that need two.',
  },
  {
    key: 'exportRoleIds',
    title: 'Export',
    description: 'Download the applications they can read, as CSV or JSON.',
    help: 'Downloaded copies can’t be recalled, so give this only to people you trust with applicants’ answers.',
  },
  {
    key: 'deleteRoleIds',
    title: 'Delete',
    description: 'Permanently delete applications and their answers.',
    help: 'Deleting removes the answers, notes and review card for good. Only a record that an application existed is kept.',
  },
];

const ADMINS_NOTE =
  'Server owners and members with Administrator or Manage Server can always do all of this.';

function RolesRow({
  form,
  guildId,
  role,
}: {
  form: ApplicationsForm;
  guildId: string;
  role: { key: RoleKey; title: string; description: string; help?: string | undefined };
}): ReactElement {
  const value = form.value[role.key];

  return (
    <SettingRow
      stacked
      title={role.title}
      description={role.description}
      help={role.help}
      error={form.errorAt(role.key)}
    >
      <RoleMultiPicker
        guildId={guildId}
        label={`Add a ${role.title.toLowerCase()} role`}
        max={25}
        requireAssignable={false}
        invalid={form.errorAt(role.key) !== undefined}
        value={value}
        onChange={(next) => form.setValue((current) => ({ ...current, [role.key]: next }))}
      />
    </SettingRow>
  );
}

export function SettingsArea({
  form,
  guildId,
}: {
  form: ApplicationsForm;
  guildId: string;
}): ReactElement {
  const config = form.value;

  const setNumber = (key: NumberKey, fallback: number) => (next: number | null) =>
    form.setValue((current) => ({ ...current, [key]: next ?? fallback }));

  const unrouted = config.forms.filter(
    (entry) => !entry.archived && entry.review.channelId === undefined,
  );
  const stranded = config.reviewChannelId === undefined ? unrouted.length : 0;

  return (
    <>
      <Section label="Review" intro={ADMINS_NOTE}>
        <Rows>
          <SettingRow
            title="Default review channel"
            description="Where review cards go for forms without their own channel."
            error={form.errorAt('reviewChannelId')}
            note={
              stranded === 0
                ? undefined
                : `${stranded} ${stranded === 1 ? 'form has' : 'forms have'} no channel of ${stranded === 1 ? 'its' : 'their'} own either, so no review card is posted for ${stranded === 1 ? 'it' : 'them'}. Staff can still review in the dashboard.`
            }
          >
            <ChannelPicker
              guildId={guildId}
              label="Default review channel"
              noneLabel="No channel"
              types={REVIEW_CHANNEL_TYPES}
              value={config.reviewChannelId ?? null}
              onChange={(next) =>
                form.setValue((current) =>
                  withOptional(current, 'reviewChannelId', next ?? undefined),
                )
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section
        label="Default review team"
        help="Used by every form set to the server default. A form can have its own team instead, under its Review tab."
      >
        <Rows>
          {TEAM.map((role) => (
            <RolesRow key={role.key} form={form} guildId={guildId} role={role} />
          ))}
        </Rows>
      </Section>

      <Section label="Other powers">
        <Rows>
          {POWERS.map((role) => (
            <RolesRow key={role.key} form={form} guildId={guildId} role={role} />
          ))}
        </Rows>
      </Section>

      <Section label="Timing and retention">
        <Rows>
          <SettingRow
            title="Delete unsent drafts after"
            description="Drafts nobody has touched for this long are deleted."
            error={form.errorAt('draftExpiryDays')}
          >
            <NumberStepper
              label="Delete unsent drafts after"
              unit="days"
              width={148}
              min={1}
              max={90}
              value={config.draftExpiryDays}
              onChange={setNumber('draftExpiryDays', 30)}
            />
          </SettingRow>

          <SettingRow
            title="Keep answers after a decision"
            description="Answers, notes, follow-ups and the decision reason are then erased."
            help="What stays: the reference number, form, status, dates and who decided. Nothing anyone wrote is kept."
            error={form.errorAt('retentionDays')}
          >
            <NumberStepper
              label="Keep answers after a decision"
              unit="days"
              width={148}
              min={7}
              max={365}
              value={config.retentionDays}
              onChange={setNumber('retentionDays', 30)}
            />
          </SettingRow>

          <SettingRow
            title="Time to answer staff"
            description="How long an applicant has to answer a question from staff before the application expires. 0 means no limit."
            error={form.errorAt('followUpDeadlineDays')}
          >
            <NumberStepper
              label="Time to answer staff"
              unit="days"
              width={148}
              min={0}
              max={60}
              value={config.followUpDeadlineDays}
              onChange={setNumber('followUpDeadlineDays', 14)}
            />
          </SettingRow>

          <SettingRow
            title="Remind reviewers after"
            description="Post a reminder in the review channel when an application waits this long. It never decides anything. 0 turns reminders off."
            error={form.errorAt('reviewReminderHours')}
          >
            <NumberStepper
              label="Remind reviewers after"
              unit="hours"
              width={148}
              min={0}
              max={336}
              value={config.reviewReminderHours}
              onChange={setNumber('reviewReminderHours', 48)}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Elsewhere">
        <Rows>
          <SettingRow
            title="Commands"
            description={
              <>
                Rename /apply and /applications or change who sees them on the{' '}
                <Link to="/dashboard/$guildId/commands" params={{ guildId }} search={{}}>
                  Commands
                </Link>{' '}
                page.
              </>
            }
          />
          <SettingRow
            title="Review page for staff"
            description="Reviewers who don’t have Manage Server review applications on their own page. Share this link with them."
          >
            <a className="button button-secondary button-sm" href={`/review/${guildId}`}>
              Open review page
            </a>
          </SettingRow>
        </Rows>
      </Section>
    </>
  );
}
