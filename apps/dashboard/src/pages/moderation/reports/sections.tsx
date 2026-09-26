import { formatComponentEmoji, parseComponentEmoji } from '@proton/core';
import {
  type ChannelMode,
  COMMAND_OFF_HINT,
  METHOD_OFF_HINT,
  type ReporterMode,
  type ReportReason,
  type ReportsConfig,
} from '@proton/module-moderation/config';
import type { RuleNames } from '@proton/module-moderation/rule-summary';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChannelMultiPicker, ChannelPicker } from '../../../components/discord/channel-picker.tsx';
import { EmojiPicker } from '../../../components/discord/emoji-picker.tsx';
import { DurationInput } from '../../../components/discord/inputs.tsx';
import { RoleMultiPicker } from '../../../components/discord/role-picker.tsx';
import { CollectionHeader, useRecent } from '../../../components/ui/collection.tsx';
import {
  Button,
  cx,
  IconButton,
  NumberStepper,
  SegmentedControl,
  Select,
  Switch,
  TextInput,
} from '../../../components/ui/controls.tsx';
import { EmptyState, StatusBanner } from '../../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../../components/ui/layout.tsx';
import { channelsQuery, rolesQuery } from '../../../lib/queries.ts';
import type { ModerationForm, Problems } from '../punish-shape.ts';
import { reactionNeedsMore } from './shape.ts';

export interface SectionProps {
  guildId: string;
  form: ModerationForm;
  problems: Problems;
}

const DEFAULT_EMOJI = '🚩';
const NO_REASON = '';
const REASONS_MAX = 25;
const REASON_LABEL_MAX = 100;
const REASON_DESCRIPTION_MAX = 100;
const ROLES_MAX = 25;
const NOTIFY_ROLES_MAX = 10;
const REACTION_CHANNELS_MAX = 50;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 10;
const DAY_MS = 86_400_000;

const METHOD_ROWS = [
  {
    field: 'command',
    title: '/report',
    description:
      'A slash command. Members pick who to report and can add a message link and a file.',
  },
  {
    field: 'userMenu',
    title: 'Report user',
    description: 'In a member’s menu under Apps. Opens the same form as /report.',
  },
  {
    field: 'messageMenu',
    title: 'Report message',
    description: 'In a message’s menu under Apps. Proton keeps a copy of the message as it was.',
  },
] as const;

const REACTION_VISIBLE =
  'A reaction is public: until Proton removes it, anyone who can see the message can see it and ' +
  'who added it.';

const FALLBACK_VISIBLE =
  'Everyone in the channel can see the prompt and who it’s for. It’s deleted after 2 minutes.';

const CHANNEL_MODES = [
  { value: 'all', label: 'All channels' },
  { value: 'only', label: 'Only these' },
  { value: 'except', label: 'All except' },
] as const satisfies readonly { value: ChannelMode; label: string }[];

const REPORTER_MODES = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'only', label: 'Only these roles' },
  { value: 'except', label: 'Everyone except' },
] as const satisfies readonly { value: ReporterMode; label: string }[];

const REPORTER_NOTES: Readonly<Record<ReporterMode, string>> = {
  everyone: 'Default. Anyone in the server can report.',
  only: 'Only members with at least one of these roles can report. Administrators always can.',
  except: 'Members with any of these roles can’t report. Administrators always can.',
};

const COPY_PRIVACY =
  'Copies stay in the report channel until staff or closing delete them. Proton’s own snapshot ' +
  'of the message is removed 30 days after the report is resolved, or 90 days after it was filed.';

function newReasonId(reasons: readonly ReportReason[]): string {
  const taken = new Set(reasons.map((reason) => reason.id.toLowerCase()));

  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
    const id = Array.from(bytes, (byte) => ID_ALPHABET.charAt(byte % ID_ALPHABET.length)).join('');
    if (!taken.has(id)) return id;
  }
}

export function setReports(
  form: ModerationForm,
  change: (current: ReportsConfig) => ReportsConfig,
): void {
  form.setValue((current) => ({ ...current, reports: change(current.reports) }));
}

export function useReportNames(guildId: string): RuleNames {
  const channels = useQuery(channelsQuery(guildId));
  const roles = useQuery(rolesQuery(guildId));

  return useMemo(() => {
    const channelNames = new Map(
      (channels.data ?? []).map((channel) => [channel.id, channel.name]),
    );
    const roleNames = new Map((roles.data ?? []).map((role) => [role.id, role.name]));

    return {
      channel: (channelId: string) => channelNames.get(channelId),
      role: (roleId: string) => roleNames.get(roleId),
    };
  }, [channels.data, roles.data]);
}

export function MethodsSection({ guildId, form, problems }: SectionProps): ReactElement {
  const reports = form.value.reports;
  const { methods } = reports;
  const noneOn = problems.at('reports.methods');

  return (
    <Section label="Reporting methods">
      <Rows>
        {METHOD_ROWS.map((method) => (
          <SettingRow
            key={method.field}
            title={method.title}
            description={method.description}
            note={
              methods[method.field]
                ? undefined
                : method.field === 'command'
                  ? COMMAND_OFF_HINT
                  : METHOD_OFF_HINT
            }
          >
            <Switch
              label={`Report with ${method.title}`}
              checked={methods[method.field]}
              onChange={(next) => form.set(`reports.methods.${method.field}`, next)}
            />
          </SettingRow>
        ))}

        <SettingRow
          title="Reaction"
          description="Members react to a message with an emoji to report whoever wrote it."
          note={methods.reaction ? undefined : 'Reactions with the emoji are ignored.'}
        >
          <Switch
            label="Report with a reaction"
            checked={methods.reaction}
            onChange={(next) => form.set('reports.methods.reaction', next)}
          />
        </SettingRow>
      </Rows>

      {noneOn !== undefined ? (
        <p className="field-error moderation-report-error" role="alert">
          {noneOn}
        </p>
      ) : null}

      {methods.reaction ? <ReactionRows guildId={guildId} form={form} problems={problems} /> : null}
    </Section>
  );
}

function ReactionRows({ guildId, form, problems }: SectionProps): ReactElement {
  const reports = form.value.reports;
  const { reaction } = reports;
  const asks = reactionNeedsMore(reports);

  const reasonOptions = [
    { value: NO_REASON, label: reports.requireReason ? 'Ask the member' : 'No reason' },
    ...reports.reasons.map((reason) => ({
      value: reason.id,
      label: reason.label.trim() === '' ? 'Unnamed reason' : reason.label,
    })),
  ];

  const reasonNote =
    reports.requireComment || reports.requireAttachment
      ? 'Details or a file are required, so Proton always asks the member to finish the report in a DM.'
      : reaction.reasonId === null && reports.requireReason
        ? 'Proton asks the member for a reason in a DM before it files the report.'
        : undefined;

  return (
    <>
      <div className="moderation-report-banner">
        <StatusBanner tone="warning">{REACTION_VISIBLE}</StatusBanner>
      </div>

      <Rows>
        <SettingRow
          title="Emoji"
          description="The reaction that reports a message."
          error={problems.at('reports.reaction.emoji')}
        >
          <EmojiPicker
            guildId={guildId}
            label="Report emoji"
            value={parseComponentEmoji(reaction.emoji)}
            onChange={(next) =>
              form.set(
                'reports.reaction.emoji',
                next === null ? DEFAULT_EMOJI : formatComponentEmoji(next),
              )
            }
          />
        </SettingRow>

        <SettingRow
          title="Reason"
          description="A reaction can’t carry a reason. Pick one to file these reports with it."
          note={reasonNote}
          error={problems.at('reports.reaction.reasonId')}
        >
          <Select
            aria-label="Reason for reaction reports"
            width="md"
            value={reaction.reasonId ?? NO_REASON}
            options={reasonOptions}
            onChange={(value) =>
              form.set('reports.reaction.reasonId', value === NO_REASON ? null : value)
            }
          />
        </SettingRow>

        <SettingRow
          stacked
          title="Channels"
          description="Where the reaction reports a message."
          note={
            reaction.channelMode === 'only' && reaction.channelIds.length === 0
              ? 'Add at least one channel, or reactions report nothing.'
              : undefined
          }
          error={problems.at('reports.reaction.channelIds')}
        >
          <div className="stack stack-10 moderation-report-seg">
            <SegmentedControl
              label="Channels for reaction reports"
              value={reaction.channelMode}
              options={CHANNEL_MODES}
              onChange={(next) => form.set('reports.reaction.channelMode', next)}
            />
            {reaction.channelMode !== 'all' ? (
              <ChannelMultiPicker
                guildId={guildId}
                value={reaction.channelIds}
                max={REACTION_CHANNELS_MAX}
                onChange={(next) => form.set('reports.reaction.channelIds', next)}
              />
            ) : null}
          </div>
        </SettingRow>

        <SettingRow
          title="Remove the reaction"
          description="Takes the reaction off as soon as Proton sees it. Needs Manage Messages in those channels."
        >
          <Switch
            label="Remove the report reaction"
            checked={reaction.removeReaction}
            onChange={(next) => form.set('reports.reaction.removeReaction', next)}
          />
        </SettingRow>

        {asks ? (
          <SettingRow
            title="Ask in the channel when a DM fails"
            description="If Proton can’t DM the member, it posts a short prompt for them in the channel instead."
            note={reaction.channelFallback ? FALLBACK_VISIBLE : undefined}
          >
            <Switch
              label="Ask in the channel when a DM fails"
              checked={reaction.channelFallback}
              onChange={(next) => form.set('reports.reaction.channelFallback', next)}
            />
          </SettingRow>
        ) : null}
      </Rows>
    </>
  );
}

export function ChannelSection({ guildId, form, problems }: SectionProps): ReactElement {
  const reports = form.value.reports;
  const channelError = problems.at('reports.channelId');

  return (
    <Section label="Report channel">
      <Rows>
        <SettingRow
          title="Report channel"
          description="Proton posts every new report here for staff to review."
          help="Proton needs Send Messages and Embed Links here, and names anything missing when it posts."
          error={channelError}
        >
          <ChannelPicker
            guildId={guildId}
            label="Report channel"
            value={reports.channelId ?? null}
            allowNone={false}
            invalid={channelError !== undefined}
            onChange={(next) => {
              if (next !== null) form.set('reports.channelId', next);
            }}
          />
        </SettingRow>

        <SettingRow
          stacked
          title="Roles to notify"
          description="Mentioned when a new report arrives. Leave empty to post without a mention."
          help="If a role isn’t mentionable, Proton needs Mention Everyone to mention it."
          error={problems.at('reports.notifyRoleIds')}
        >
          <RoleMultiPicker
            guildId={guildId}
            label="Add a role to notify"
            value={reports.notifyRoleIds}
            max={NOTIFY_ROLES_MAX}
            onChange={(next) => form.set('reports.notifyRoleIds', next)}
          />
        </SettingRow>
      </Rows>
    </Section>
  );
}

function ReasonRow({
  reasons,
  index,
  problems,
  focus,
  className,
  onChange,
  onMove,
  onRemove,
}: {
  reasons: readonly ReportReason[];
  index: number;
  problems: Problems;
  focus: boolean;
  className: string | undefined;
  onChange: (next: ReportReason) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}): ReactElement | null {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);

  const reason = reasons[index];
  if (reason === undefined) return null;

  const path = `reports.reasons.${index}`;
  const position = index + 1;
  const labelError = problems.at(`${path}.label`) ?? problems.at(`${path}.id`);
  const descriptionError = problems.at(`${path}.description`);

  return (
    <div className={cx('moderation-preset', className)}>
      <span className="moderation-preset-index">{position}</span>

      <div className="moderation-preset-body">
        <TextInput
          ref={input}
          width="full"
          aria-label={`Reason ${position}`}
          placeholder="What members pick, like Spam"
          maxLength={REASON_LABEL_MAX}
          invalid={labelError !== undefined}
          value={reason.label}
          onChange={(event) => onChange({ ...reason, label: event.currentTarget.value })}
        />
        {labelError !== undefined ? (
          <p className="field-error" role="alert">
            {labelError}
          </p>
        ) : null}

        <TextInput
          width="full"
          aria-label={`Description of reason ${position}`}
          placeholder="Description shown under it (optional)"
          maxLength={REASON_DESCRIPTION_MAX}
          invalid={descriptionError !== undefined}
          value={reason.description}
          onChange={(event) => onChange({ ...reason, description: event.currentTarget.value })}
        />
        {descriptionError !== undefined ? (
          <p className="field-error" role="alert">
            {descriptionError}
          </p>
        ) : null}
      </div>

      <div className="moderation-preset-actions">
        <IconButton
          tone="ghost"
          size="sm"
          icon="caret-up"
          label={`Move reason ${position} up`}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        />
        <IconButton
          tone="ghost"
          size="sm"
          icon="caret-down"
          label={`Move reason ${position} down`}
          disabled={index === reasons.length - 1}
          onClick={() => onMove(1)}
        />
        <IconButton
          tone="danger-quiet"
          size="sm"
          icon="trash"
          label={`Remove reason ${position}`}
          onClick={onRemove}
        />
      </div>
    </div>
  );
}

export function ReasonsSection({ form, problems }: Omit<SectionProps, 'guildId'>): ReactElement {
  const [focused, setFocused] = useState<string | null>(null);
  const recent = useRecent();

  const reports = form.value.reports;
  const reasons = reports.reasons;
  const full = reasons.length >= REASONS_MAX;

  const setReasons = (next: ReportReason[]): void =>
    setReports(form, (current) => ({ ...current, reasons: next }));

  const add = (): void => {
    const id = newReasonId(reasons);
    recent.mark(id);
    setFocused(id);
    setReasons([...reasons, { id, label: '', description: '' }]);
  };

  const move = (index: number, delta: number): void => {
    const next = [...reasons];
    const held = next[index];
    const other = next[index + delta];
    if (held === undefined || other === undefined) return;

    next[index] = other;
    next[index + delta] = held;
    setReasons(next);
  };

  const remove = (index: number): void =>
    setReports(form, (current) => {
      const gone = current.reasons[index];
      return {
        ...current,
        reasons: current.reasons.filter((_, at) => at !== index),
        reaction:
          gone !== undefined && current.reaction.reasonId === gone.id
            ? { ...current.reaction, reasonId: null }
            : current.reaction,
      };
    });

  return (
    <Section>
      <CollectionHeader
        title="Reasons"
        used={reasons.length}
        ceiling={REASONS_MAX}
        limitLabel="reasons"
        actions={
          reasons.length > 0 && !full ? (
            <Button size="sm" icon="plus" onClick={add}>
              Add reason
            </Button>
          ) : undefined
        }
      />

      <p className="section-intro">
        Members pick one when they report, in this order. Staff see it on the report.
      </p>

      {reasons.length === 0 ? (
        <EmptyState
          inset
          icon="list-checks"
          title="No reasons"
          actions={
            <Button tone="primary" size="sm" icon="plus" onClick={add}>
              Add reason
            </Button>
          }
        >
          {reports.allowCustomReason
            ? 'Members write their own reason.'
            : 'Add a reason, or let members write their own below.'}
        </EmptyState>
      ) : (
        <Rows>
          {reasons.map((reason, index) => (
            <ReasonRow
              key={reason.id}
              reasons={reasons}
              index={index}
              problems={problems}
              focus={focused === reason.id}
              className={recent.enter(reason.id)}
              onChange={(next) =>
                setReasons(reasons.map((current, at) => (at === index ? next : current)))
              }
              onMove={(delta) => move(index, delta)}
              onRemove={() => remove(index)}
            />
          ))}
        </Rows>
      )}
    </Section>
  );
}

function Stepper({
  form,
  path,
  value,
  min,
  max,
  label,
  width,
  invalid,
}: {
  form: ModerationForm;
  path: string;
  value: number;
  min: number;
  max: number;
  label: string;
  width?: number | undefined;
  invalid?: boolean | undefined;
}): ReactElement {
  return (
    <NumberStepper
      label={label}
      value={value}
      min={min}
      max={max}
      width={width}
      invalid={invalid}
      onChange={(next) => form.set(path, next ?? value)}
    />
  );
}

export function EvidenceSection({ form, problems }: Omit<SectionProps, 'guildId'>): ReactElement {
  const reports = form.value.reports;
  const { limits } = reports;
  const lengthError =
    problems.at('reports.limits.commentMin') ?? problems.at('reports.limits.commentMax');

  return (
    <Section label="Evidence">
      <Rows>
        <SettingRow
          title="Own reasons"
          description="Default on. Members can write a reason instead of picking one."
          error={problems.at('reports.allowCustomReason')}
        >
          <Switch
            label="Let members write their own reason"
            checked={reports.allowCustomReason}
            onChange={(next) => form.set('reports.allowCustomReason', next)}
          />
        </SettingRow>

        {reports.allowCustomReason ? (
          <SettingRow
            title="Longest own reason"
            description="Default 200 characters."
            error={problems.at('reports.limits.customReasonMax')}
          >
            <Stepper
              form={form}
              path="reports.limits.customReasonMax"
              label="Longest own reason in characters"
              value={limits.customReasonMax}
              min={20}
              max={200}
              width={124}
            />
          </SettingRow>
        ) : null}

        <SettingRow
          title="Require a reason"
          description="Default on. Members must pick a reason or write one."
          error={problems.at('reports.requireReason')}
        >
          <Switch
            label="Require a reason"
            checked={reports.requireReason}
            onChange={(next) => form.set('reports.requireReason', next)}
          />
        </SettingRow>

        <SettingRow
          title="Require details"
          description="Default off. Members must describe what happened."
          error={problems.at('reports.requireComment')}
        >
          <Switch
            label="Require details"
            checked={reports.requireComment}
            onChange={(next) =>
              setReports(form, (current) => ({
                ...current,
                requireComment: next,
                limits:
                  next && current.limits.commentMin < 1
                    ? { ...current.limits, commentMin: 1 }
                    : current.limits,
              }))
            }
          />
        </SettingRow>

        <SettingRow
          title={reports.requireComment ? 'Details length' : 'Longest details'}
          description={
            reports.requireComment
              ? 'Shortest and longest details, in characters. Default up to 1,000.'
              : 'In characters. Default 1,000.'
          }
          error={lengthError}
        >
          <span className="moderation-report-range">
            {reports.requireComment ? (
              <>
                <Stepper
                  form={form}
                  path="reports.limits.commentMin"
                  label="Shortest details in characters"
                  value={limits.commentMin}
                  min={0}
                  max={500}
                  width={112}
                  invalid={problems.at('reports.limits.commentMin') !== undefined}
                />
                <span className="text-muted text-sm">to</span>
              </>
            ) : null}
            <Stepper
              form={form}
              path="reports.limits.commentMax"
              label="Longest details in characters"
              value={limits.commentMax}
              min={50}
              max={1000}
              width={124}
              invalid={problems.at('reports.limits.commentMax') !== undefined}
            />
          </span>
        </SettingRow>

        <SettingRow
          title="Require a file"
          description="Default off. Members must attach a screenshot or another file."
          error={problems.at('reports.requireAttachment')}
        >
          <Switch
            label="Require a file"
            checked={reports.requireAttachment}
            onChange={(next) => form.set('reports.requireAttachment', next)}
          />
        </SettingRow>

        <SettingRow
          title="Files per report"
          description="Default 4. Proton stores file names and links, never the files."
          error={problems.at('reports.maxAttachments')}
        >
          <Stepper
            form={form}
            path="reports.maxAttachments"
            label="Files per report"
            value={reports.maxAttachments}
            min={1}
            max={10}
          />
        </SettingRow>

        <SettingRow
          title="Copy reported messages"
          description="Default on. Proton forwards a reported message into the report channel, so staff still have it if it’s deleted."
          help={COPY_PRIVACY}
          error={problems.at('reports.copyReportedMessage')}
        >
          <Switch
            label="Copy reported messages"
            checked={reports.copyReportedMessage}
            onChange={(next) => form.set('reports.copyReportedMessage', next)}
          />
        </SettingRow>
      </Rows>
    </Section>
  );
}

export function ReportersSection({ guildId, form, problems }: SectionProps): ReactElement {
  const reports = form.value.reports;
  const { mode, roleIds } = reports.reporters;

  return (
    <Section label="Who can report">
      <Rows>
        <SettingRow
          stacked
          title="Members who can report"
          description={REPORTER_NOTES[mode]}
          note={
            mode === 'only' && roleIds.length === 0
              ? 'Add at least one role, or only administrators can report.'
              : undefined
          }
          error={problems.at('reports.reporters.roleIds') ?? problems.at('reports.reporters')}
        >
          <div className="stack stack-10 moderation-report-seg">
            <SegmentedControl
              label="Who can report"
              value={mode}
              options={REPORTER_MODES}
              onChange={(next) => form.set('reports.reporters.mode', next)}
            />
            {mode !== 'everyone' ? (
              <RoleMultiPicker
                guildId={guildId}
                label={mode === 'only' ? 'Add a role that can report' : 'Add a role that can’t'}
                value={roleIds}
                max={ROLES_MAX}
                onChange={(next) => form.set('reports.reporters.roleIds', next)}
              />
            ) : null}
          </div>
        </SettingRow>

        <SettingRow
          stacked
          title="Immune roles"
          description="Members with these roles can’t be reported. Default: nobody is immune."
          error={problems.at('reports.immuneRoleIds')}
        >
          <RoleMultiPicker
            guildId={guildId}
            label="Add an immune role"
            value={reports.immuneRoleIds}
            max={ROLES_MAX}
            onChange={(next) => form.set('reports.immuneRoleIds', next)}
          />
        </SettingRow>

        <SettingRow
          stacked
          title="Reviewer roles"
          description="Can claim, accept and dismiss reports in Discord. Server managers always can."
          note="Reviewing doesn’t grant ban, kick or timeout. Each punishment still needs its own permission."
          error={problems.at('reports.reviewerRoleIds')}
        >
          <RoleMultiPicker
            guildId={guildId}
            label="Add a reviewer role"
            value={reports.reviewerRoleIds}
            max={ROLES_MAX}
            onChange={(next) => form.set('reports.reviewerRoleIds', next)}
          />
        </SettingRow>
      </Rows>
    </Section>
  );
}

export function LimitsSection({ guildId, form, problems }: SectionProps): ReactElement {
  const { limits } = form.value.reports;
  const cooldownError = problems.at('reports.limits.cooldown');
  const serverError = problems.at('reports.limits.maxOpenPerServer');
  const memberError = problems.at('reports.limits.maxOpenPerMember');

  return (
    <Section label="Limits">
      <Rows>
        <SettingRow
          title="Cooldown"
          description="Default 2 minutes between one member’s reports."
          error={cooldownError}
        >
          <DurationInput
            label="Cooldown"
            value={limits.cooldown}
            max={DAY_MS}
            units={['s', 'm', 'h']}
            invalid={cooldownError !== undefined}
            onChange={(next) => form.set('reports.limits.cooldown', next)}
          />
        </SettingRow>

        <SettingRow
          stacked
          title="Skip the cooldown"
          description="Members with these roles can report again straight away."
          error={problems.at('reports.limits.cooldownBypassRoleIds')}
        >
          <RoleMultiPicker
            guildId={guildId}
            label="Add a role that skips the cooldown"
            value={limits.cooldownBypassRoleIds}
            max={ROLES_MAX}
            onChange={(next) => form.set('reports.limits.cooldownBypassRoleIds', next)}
          />
        </SettingRow>

        <SettingRow
          title="Open reports in the server"
          description="Default 100. New reports are refused while this many are open."
          error={serverError}
        >
          <Stepper
            form={form}
            path="reports.limits.maxOpenPerServer"
            label="Open reports in the server"
            value={limits.maxOpenPerServer}
            min={1}
            max={1000}
            width={124}
            invalid={serverError !== undefined}
          />
        </SettingRow>

        <SettingRow
          title="Open reports about one member"
          description="Default 10. Further reports about that member are refused, and the reporter is told why."
          error={memberError}
        >
          <Stepper
            form={form}
            path="reports.limits.maxOpenPerMember"
            label="Open reports about one member"
            value={limits.maxOpenPerMember}
            min={1}
            max={100}
            invalid={memberError !== undefined}
          />
        </SettingRow>

        <SettingRow
          title="Refuse repeat reports"
          description="Default on. A member can’t report the same person or message again while their first report is open."
          error={problems.at('reports.limits.duplicateProtection')}
        >
          <Switch
            label="Refuse repeat reports"
            checked={limits.duplicateProtection}
            onChange={(next) => form.set('reports.limits.duplicateProtection', next)}
          />
        </SettingRow>
      </Rows>
    </Section>
  );
}
