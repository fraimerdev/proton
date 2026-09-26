import type { CloseMode, Closing } from '@proton/module-moderation/config';
import type { ReactElement } from 'react';
import { ChannelPicker } from '../../../components/discord/channel-picker.tsx';
import { DurationInput } from '../../../components/discord/inputs.tsx';
import { MemberCell, MemberProvider, useMember } from '../../../components/discord/member.tsx';
import { MemberPicker } from '../../../components/discord/member-picker.tsx';
import { LimitCounter, useRecent } from '../../../components/ui/collection.tsx';
import { cx, IconButton, SegmentedControl, Switch } from '../../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../../components/ui/layout.tsx';
import {
  ChannelSection,
  EvidenceSection,
  LimitsSection,
  MethodsSection,
  ReasonsSection,
  ReportersSection,
  type SectionProps,
  setReports,
} from './sections.tsx';

type Outcome = 'accepted' | 'dismissed';

const BLOCKED_MAX = 100;
const DAY_MS = 86_400_000;
const DEFAULT_DELAY = '1h';

const CLOSE_MODES = [
  { value: 'keep', label: 'Keep' },
  { value: 'move', label: 'Move' },
  { value: 'delete', label: 'Delete' },
] as const satisfies readonly { value: CloseMode; label: string }[];

const CLOSE_NOTES: Readonly<Record<CloseMode, string>> = {
  keep: 'The card stays in the report channel, updated with the decision and without its buttons.',
  move: 'Proton posts the finished card in another channel, then deletes the original and its copy.',
  delete: 'Proton deletes the card and the copied message from the report channel.',
};

const OUTCOME_TITLES: Readonly<Record<Outcome, string>> = {
  accepted: 'Accepted reports',
  dismissed: 'Dismissed reports',
};

function ClosingRows({
  guildId,
  form,
  problems,
  outcome,
}: SectionProps & { outcome: Outcome }): ReactElement {
  const closing: Closing = form.value.reports.closing[outcome];
  const path = `reports.closing.${outcome}`;
  const channelError = problems.at(`${path}.channelId`);
  const title = OUTCOME_TITLES[outcome];

  return (
    <Rows>
      <SettingRow
        title={title}
        description={CLOSE_NOTES[closing.mode]}
        error={problems.at(`${path}.mode`)}
      >
        <SegmentedControl
          label={`What happens to ${title.toLowerCase()}`}
          value={closing.mode}
          options={CLOSE_MODES}
          onChange={(next) => form.set(`${path}.mode`, next)}
        />
      </SettingRow>

      {closing.mode === 'move' ? (
        <SettingRow
          title="Move to"
          description="Needs Send Messages and Embed Links there."
          error={channelError}
        >
          <ChannelPicker
            guildId={guildId}
            label={`Channel for ${title.toLowerCase()}`}
            value={closing.channelId ?? null}
            allowNone={false}
            invalid={channelError !== undefined}
            onChange={(next) => {
              if (next !== null) form.set(`${path}.channelId`, next);
            }}
          />
        </SettingRow>
      ) : null}

      {closing.mode !== 'keep' ? (
        <SettingRow
          title="Wait first"
          description="Leaves the decided card where it is for a while before it goes."
          note="Moving and deleting need Manage Messages in the report channel."
        >
          <Switch
            label={`Wait before closing ${title.toLowerCase()}`}
            checked={closing.delay !== null}
            onChange={(next) => form.set(`${path}.delay`, next ? DEFAULT_DELAY : null)}
          />
        </SettingRow>
      ) : null}

      {closing.mode !== 'keep' && closing.delay !== null ? (
        <SettingRow title="Wait" error={problems.at(`${path}.delay`)}>
          <DurationInput
            label={`Wait before closing ${title.toLowerCase()}`}
            value={closing.delay}
            max={30 * DAY_MS}
            units={['m', 'h', 'd']}
            onChange={(next) => form.set(`${path}.delay`, next)}
          />
        </SettingRow>
      ) : null}
    </Rows>
  );
}

function BlockedRow({
  id,
  className,
  onUnblock,
}: {
  id: string;
  className: string | undefined;
  onUnblock: () => void;
}): ReactElement {
  const member = useMember(id);

  return (
    <div className={cx('moderation-report-blocked', className)}>
      <MemberCell userId={id} />
      <IconButton
        tone="danger-quiet"
        size="sm"
        icon="trash"
        label={`Unblock ${member?.displayName ?? id}`}
        onClick={onUnblock}
      />
    </div>
  );
}

function BlockedReporters({ guildId, form, problems }: SectionProps): ReactElement {
  const recent = useRecent();
  const blocked = form.value.reports.blockedUserIds;
  const full = blocked.length >= BLOCKED_MAX;

  const setBlocked = (next: string[]): void =>
    setReports(form, (current) => ({ ...current, blockedUserIds: next }));

  return (
    <Section
      label="Blocked reporters"
      note={<LimitCounter used={blocked.length} ceiling={BLOCKED_MAX} label="blocked members" />}
    >
      <MemberProvider guildId={guildId} userIds={blocked}>
        <Rows>
          <SettingRow
            title="Block a member"
            description="Members on this list can’t file reports. Proton tells them staff blocked them."
            error={problems.at('reports.blockedUserIds')}
          >
            {full ? (
              <span className="text-muted text-sm">List full</span>
            ) : (
              <MemberPicker
                guildId={guildId}
                label="Block a member from reporting"
                placeholder="Choose a member"
                value={null}
                onChange={(id) => {
                  if (id === null || blocked.includes(id)) return;
                  recent.mark(id);
                  setBlocked([...blocked, id]);
                }}
              />
            )}
          </SettingRow>

          {blocked.map((id) => (
            <BlockedRow
              key={id}
              id={id}
              className={recent.enter(id)}
              onUnblock={() => setBlocked(blocked.filter((held) => held !== id))}
            />
          ))}
        </Rows>
      </MemberProvider>
    </Section>
  );
}

export function ReportSettingsArea(props: SectionProps): ReactElement {
  const { form, problems } = props;
  const reports = form.value.reports;

  return (
    <>
      <Section>
        <Rows>
          <SettingRow
            title="Accept new reports"
            description="Off: members who try to report are told reports are off. Open reports stay in the queue for staff, and automation stops starting new runs."
            error={problems.at('reports.enabled')}
          >
            <Switch
              label="Accept new reports"
              checked={reports.enabled}
              onChange={(next) => form.set('reports.enabled', next)}
            />
          </SettingRow>
        </Rows>
      </Section>

      <MethodsSection {...props} />
      <ChannelSection {...props} />
      <ReasonsSection form={form} problems={problems} />
      <EvidenceSection form={form} problems={problems} />
      <ReportersSection {...props} />
      <LimitsSection {...props} />

      <Section
        label="Closing"
        intro="What happens to a report’s card once staff decide. The report and its history are always kept."
      >
        <ClosingRows {...props} outcome="accepted" />
        <ClosingRows {...props} outcome="dismissed" />
      </Section>

      <BlockedReporters {...props} />
    </>
  );
}
