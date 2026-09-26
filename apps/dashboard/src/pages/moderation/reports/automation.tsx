import { REPORT_STATUSES, type ReportStatus } from '@proton/core';
import type { PlaceholderSurface } from '@proton/core/placeholders';
import {
  type AutomationAction,
  type AutomationRule,
  DEFAULT_STAFF_ALERT,
  type DmMessage,
  dmMessageSchema,
  type PunishKind,
  type StaffMessage,
} from '@proton/module-moderation/config';
import {
  REPORT_ALERT_SURFACE,
  REPORT_MEMBER_NOTICE_SURFACE,
} from '@proton/module-moderation/placeholders';
import type { AutomationRunView } from '@proton/module-moderation/reports-view';
import { describeRule } from '@proton/module-moderation/rule-summary';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { ChannelPicker } from '../../../components/discord/channel-picker.tsx';
import { DurationInput, humaniseDuration } from '../../../components/discord/inputs.tsx';
import { MemberCell, MemberProvider, useMember } from '../../../components/discord/member.tsx';
import {
  EditorPreviewLayout,
  MessageEditor,
  placeholderSlot,
} from '../../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../../components/discord/message-preview.tsx';
import { RoleMultiPicker, RolePicker } from '../../../components/discord/role-picker.tsx';
import { useModuleNavigate, useModuleSearch } from '../../../components/module/route.tsx';
import { TestMessage } from '../../../components/module/test-message.tsx';
import {
  CollectionHeader,
  LimitCounter,
  MetaSeparator,
} from '../../../components/ui/collection.tsx';
import {
  Badge,
  Button,
  Checkbox,
  IconButton,
  NumberStepper,
  SegmentedControl,
  Select,
  Switch,
  TextInput,
} from '../../../components/ui/controls.tsx';
import { EmptyState, LoadingArea, StatusBanner } from '../../../components/ui/feedback.tsx';
import { NavigationRow, Rows, Section, SettingRow } from '../../../components/ui/layout.tsx';
import { Pagination } from '../../../components/ui/table.tsx';
import { readFailure } from '../../../lib/errors.ts';
import { type MessagePreview, previewMessage } from '../../../lib/placeholder-preview.ts';
import { channelsQuery, rolesQuery } from '../../../lib/queries.ts';
import type { ModerationForm, Problems } from '../punish-shape.ts';
import { automationRunsQuery } from './queries.ts';
import { readableOutcome } from './queue-labels.ts';
import { setReports, useReportNames } from './sections.tsx';
import { swapped } from './shape.ts';
import { useNow, When } from './when.tsx';

type ActionKind = AutomationAction['kind'];
type RunStatus = AutomationRunView['status'];
type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const RULES_MAX = 10;
const ACTIONS_MAX = 5;
const NAME_MAX = 60;
const REASON_MAX = 512;
const ALERT_ROLES_MAX = 10;
const CONDITION_MAX = 100;
const RUNS_PAGE_SIZE = 10;
const DAY_MS = 86_400_000;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 10;
const ALL_RUNS = 'all';

const ACTION_LABELS: Readonly<Record<ActionKind, string>> = {
  alert: 'Post a staff alert',
  dm: 'Message the reported member',
  punish: 'Punish the reported member',
  add_role: 'Give a role',
  remove_role: 'Take a role away',
};

const ACTION_OPTIONS = (Object.keys(ACTION_LABELS) as ActionKind[]).map((kind) => ({
  value: kind,
  label: ACTION_LABELS[kind],
}));

const STATUS_LABELS: Readonly<Record<ReportStatus, string>> = {
  open: 'Open',
  in_review: 'In review',
  accepted: 'Accepted',
  dismissed: 'Dismissed',
};

const PUNISH_OPTIONS = [
  { value: 'warn', label: 'Warn' },
  { value: 'timeout', label: 'Time out' },
  { value: 'kick', label: 'Kick' },
  { value: 'ban', label: 'Ban' },
] as const satisfies readonly { value: PunishKind; label: string }[];

const NOTIFY_OPTIONS = [
  { value: 'inherit', label: 'As Member notifications says' },
  { value: 'send', label: 'Always' },
  { value: 'skip', label: 'Never' },
] as const;

const LENGTH_OPTIONS = [
  { value: 'default', label: 'Server default' },
  { value: 'custom', label: 'Custom' },
] as const;

const MATCH_OPTIONS = [
  { value: 'all', label: 'All of them' },
  { value: 'any', label: 'Any of them' },
] as const;

const RUN_STATUS: Readonly<Record<RunStatus, { label: string; tone: Tone }>> = {
  running: { label: 'Running', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
  partial: { label: 'Partly done', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const RUN_STATUSES = Object.keys(RUN_STATUS) as RunStatus[];

const RUN_PROBLEMS = 'problem';

const RUN_FILTERS = [
  { value: ALL_RUNS, label: 'All runs' },
  { value: RUN_PROBLEMS, label: 'Failed or partly done' },
  { value: 'failed', label: 'Failed' },
  { value: 'partial', label: 'Partly done' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'done', label: 'Done' },
  { value: 'running', label: 'Running' },
];

const OUTCOME_KINDS: Readonly<Record<string, string>> = {
  alert: 'Staff alert',
  dm: 'DM',
  punish: 'Punishment',
  add_role: 'Give role',
  remove_role: 'Take role',
};

const RISK =
  'This rule punishes members before anyone reviews the reports. A group of members can file ' +
  'false reports together to get someone punished, so keep the thresholds high and prefer a staff ' +
  'alert where you can.';

const DM_WARNING =
  'This tells the member they were reported. It never names who reported them or what they wrote.';

const CONTENT_DESCRIPTION = 'Supports Discord markdown and placeholders. Type { to add one.';

const LAYOUT_NOTE =
  'This message is a components layout, which this editor can’t change. Remove it to write text ' +
  'and an embed instead.';

const SILENT = { everyone: false, roles: false, users: false };

const DEFAULT_NOTICE: DmMessage = dmMessageSchema.parse({
  mentions: SILENT,
  embeds: [
    {
      title: 'A note from {server.name}',
      description:
        'Staff have received several reports about your recent behaviour. Please read the ' +
        'server rules. Staff may act if it continues.',
    },
  ],
});

function newRuleId(taken: readonly { id: string }[]): string {
  const ids = new Set(taken.map((item) => item.id.toLowerCase()));

  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
    const id = Array.from(bytes, (byte) => ID_ALPHABET.charAt(byte % ID_ALPHABET.length)).join('');
    if (!ids.has(id)) return id;
  }
}

let lastActionKey = 0;

function actionKeys(count: number): string[] {
  return Array.from({ length: count }, () => {
    lastActionKey += 1;
    return `action:${lastActionKey}`;
  });
}

function newAction(kind: ActionKind): AutomationAction {
  switch (kind) {
    case 'alert':
      return { kind, roleIds: [], message: DEFAULT_STAFF_ALERT };
    case 'dm':
      return { kind, message: DEFAULT_NOTICE };
    case 'punish':
      return {
        kind,
        punishment: 'timeout',
        duration: null,
        reason: 'Reported by several members',
        notify: 'inherit',
      };
    case 'add_role':
    case 'remove_role':
      return { kind, roleId: '' };
  }
}

function newRule(id: string): AutomationRule {
  return {
    id,
    name: 'New rule',
    enabled: true,
    match: 'all',
    window: '24h',
    statuses: ['open', 'in_review'],
    conditions: { reports: 3, reporters: null, unreviewedFor: null },
    actions: [newAction('alert')],
    acknowledgedRisk: false,
  };
}

function isPunitive(rule: AutomationRule): boolean {
  return rule.actions.some((action) => action.kind === 'punish');
}

function Aside({
  danger = false,
  children,
}: {
  danger?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <span className={`moderation-aside text-sm ${danger ? 'text-danger' : 'text-muted'}`}>
      {children}
    </span>
  );
}

interface AreaProps {
  guildId: string;
  moduleId: string;
  form: ModerationForm;
  problems: Problems;
}

export function ReportAutomationArea({
  guildId,
  moduleId,
  form,
  problems,
}: AreaProps): ReactElement {
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, moduleId);
  const rules = form.value.reports.automation;
  const index = rules.findIndex((rule) => rule.id === search.id);

  if (search.id !== undefined && index >= 0) {
    return (
      <RuleEditor
        key={search.id}
        guildId={guildId}
        form={form}
        problems={problems}
        index={index}
        onBack={() => go({ id: undefined })}
      />
    );
  }

  return (
    <>
      <RuleList guildId={guildId} moduleId={moduleId} form={form} problems={problems} />
      <RecentRuns guildId={guildId} />
    </>
  );
}

function RuleList({ guildId, moduleId, form, problems }: AreaProps): ReactElement {
  const go = useModuleNavigate(guildId, moduleId);
  const names = useReportNames(guildId);
  const config = form.value;
  const rules = config.reports.automation;
  const full = rules.length >= RULES_MAX;

  const add = (): void => {
    const id = newRuleId(rules);
    setReports(form, (current) => ({
      ...current,
      automation: [...current.automation, newRule(id)],
    }));
    go({ id });
  };

  return (
    <Section>
      <CollectionHeader
        title="Rules"
        used={rules.length}
        ceiling={RULES_MAX}
        limitLabel="rules"
        actions={
          rules.length > 0 && !full ? (
            <Button size="sm" icon="plus" onClick={add}>
              Add rule
            </Button>
          ) : undefined
        }
      />

      <p className="section-intro">
        Rules act when reports about one member pile up. A rule acts once, then again only when new
        reports arrive.
      </p>

      {rules.length === 0 ? (
        <EmptyState
          inset
          icon="pulse"
          title="No rules"
          actions={
            <Button tone="primary" size="sm" icon="plus" onClick={add}>
              Add rule
            </Button>
          }
        >
          Nothing happens automatically; staff review every report.
        </EmptyState>
      ) : (
        <Rows>
          {rules.map((rule, index) => {
            const broken = problems.paths.some((path) =>
              path.startsWith(`reports.automation.${index}`),
            );

            return (
              <NavigationRow
                key={rule.id}
                guildId={guildId}
                moduleId={moduleId}
                search={{ area: 'reports-automation', id: rule.id }}
                icon={isPunitive(rule) ? 'gavel' : 'pulse'}
                title={rule.name.trim() === '' ? 'Unnamed rule' : rule.name}
                description={describeRule(rule, config, names)}
                aside={
                  broken ? (
                    <Aside danger>Needs fixing</Aside>
                  ) : (
                    <Aside>{rule.enabled ? 'On' : 'Off'}</Aside>
                  )
                }
              />
            );
          })}
        </Rows>
      )}
    </Section>
  );
}

function ConditionRow({
  title,
  description,
  on,
  error,
  onToggle,
  children,
}: {
  title: string;
  description: string;
  on: boolean;
  error: string | undefined;
  onToggle: (next: boolean) => void;
  children: ReactNode;
}): ReactElement {
  return (
    <SettingRow title={title} description={description} error={error}>
      <span className="moderation-report-condition">
        {on ? children : null}
        <Switch label={title} checked={on} onChange={onToggle} />
      </span>
    </SettingRow>
  );
}

function RuleEditor({
  guildId,
  form,
  problems,
  index,
  onBack,
}: Omit<AreaProps, 'moduleId'> & { index: number; onBack: () => void }): ReactElement | null {
  const names = useReportNames(guildId);
  const config = form.value;
  const rule = config.reports.automation[index];
  const count = rule?.actions.length ?? 0;
  const [keys, setKeys] = useState<readonly string[]>(() => actionKeys(count));

  useEffect(() => {
    if (keys.length !== count) setKeys(actionKeys(count));
  }, [keys.length, count]);

  if (rule === undefined) return null;

  const path = `reports.automation.${index}`;
  const { conditions } = rule;

  const setRule = (change: (current: AutomationRule) => AutomationRule): void =>
    setReports(form, (current) => ({
      ...current,
      automation: current.automation.map((held, at) => (at === index ? change(held) : held)),
    }));

  const setActions = (change: (current: AutomationAction[]) => AutomationAction[]): void =>
    setRule((current) => ({ ...current, actions: change(current.actions) }));

  const addAction = (kind: ActionKind): void => {
    setActions((current) => [...current, newAction(kind)]);
    setKeys((current) => [...current, ...actionKeys(1)]);
  };

  const removeAction = (at: number): void => {
    setActions((current) => current.filter((_, held) => held !== at));
    setKeys((current) => current.filter((_, held) => held !== at));
  };

  const remove = (): void => {
    setReports(form, (current) => ({
      ...current,
      automation: current.automation.filter((_, at) => at !== index),
    }));
    onBack();
  };

  const toggleStatus = (status: ReportStatus, next: boolean): void =>
    setRule((current) => ({
      ...current,
      statuses: next
        ? REPORT_STATUSES.filter((held) => held === status || current.statuses.includes(held))
        : current.statuses.filter((held) => held !== status),
    }));

  const move = (at: number, delta: number): void => {
    setActions((current) => swapped(current, at, at + delta));
    setKeys((current) => swapped(current, at, at + delta));
  };

  const nameError = problems.at(`${path}.name`);
  const punitive = isPunitive(rule);

  return (
    <>
      <div className="moderation-report-back-row">
        <Button tone="ghost" size="sm" icon="caret-left" onClick={onBack}>
          All rules
        </Button>
      </div>

      <Section label="Rule">
        <Rows>
          <SettingRow title="Name" error={nameError}>
            <TextInput
              width="lg"
              aria-label="Rule name"
              maxLength={NAME_MAX}
              invalid={nameError !== undefined}
              value={rule.name}
              onChange={(event) => form.set(`${path}.name`, event.currentTarget.value)}
            />
          </SettingRow>

          <SettingRow title="On">
            <Switch
              label="Rule on"
              checked={rule.enabled}
              onChange={(next) => form.set(`${path}.enabled`, next)}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section
        label="When"
        intro="Proton counts the reports about each member separately. Turn on the conditions this rule needs."
      >
        <Rows>
          <ConditionRow
            title="Reports"
            description="The same member is reported at least this many times."
            on={conditions.reports !== null}
            error={problems.at(`${path}.conditions.reports`)}
            onToggle={(next) => form.set(`${path}.conditions.reports`, next ? 3 : null)}
          >
            <NumberStepper
              label="Reports needed"
              value={conditions.reports}
              min={1}
              max={CONDITION_MAX}
              onChange={(next) =>
                form.set(`${path}.conditions.reports`, next ?? conditions.reports)
              }
            />
          </ConditionRow>

          <ConditionRow
            title="Different reporters"
            description="At least this many different members report the same person."
            on={conditions.reporters !== null}
            error={problems.at(`${path}.conditions.reporters`)}
            onToggle={(next) => form.set(`${path}.conditions.reporters`, next ? 3 : null)}
          >
            <NumberStepper
              label="Different reporters needed"
              value={conditions.reporters}
              min={1}
              max={CONDITION_MAX}
              onChange={(next) =>
                form.set(`${path}.conditions.reporters`, next ?? conditions.reporters)
              }
            />
          </ConditionRow>

          <ConditionRow
            title="Waiting unclaimed"
            description="A report stays open without anyone claiming it for this long."
            on={conditions.unreviewedFor !== null}
            error={problems.at(`${path}.conditions.unreviewedFor`)}
            onToggle={(next) => form.set(`${path}.conditions.unreviewedFor`, next ? '1h' : null)}
          >
            <DurationInput
              label="Unclaimed for"
              value={conditions.unreviewedFor ?? '1h'}
              max={30 * DAY_MS}
              units={['m', 'h', 'd']}
              onChange={(next) => form.set(`${path}.conditions.unreviewedFor`, next)}
            />
          </ConditionRow>
        </Rows>

        {problems.at(`${path}.conditions`) !== undefined ? (
          <p className="field-error moderation-report-error" role="alert">
            {problems.at(`${path}.conditions`)}
          </p>
        ) : null}

        <Rows>
          <SettingRow
            title="Conditions needed"
            description="When more than one condition is on."
            error={problems.at(`${path}.match`)}
          >
            <SegmentedControl
              label="Conditions needed"
              value={rule.match}
              options={MATCH_OPTIONS}
              onChange={(next) => form.set(`${path}.match`, next)}
            />
          </SettingRow>

          <SettingRow
            title="Window"
            description="Only reports filed within this time count."
            error={problems.at(`${path}.window`)}
          >
            <DurationInput
              label="Window"
              value={rule.window}
              max={90 * DAY_MS}
              units={['m', 'h', 'd', 'w']}
              onChange={(next) => form.set(`${path}.window`, next)}
            />
          </SettingRow>

          <SettingRow
            stacked
            title="Reports that count"
            description="Reports in these states count toward the conditions."
            error={
              rule.statuses.length === 0 ? 'Pick at least one.' : problems.at(`${path}.statuses`)
            }
          >
            <span className="moderation-report-checks">
              {REPORT_STATUSES.map((status) => (
                <span key={status} className="moderation-report-check">
                  <Checkbox
                    label={`Count ${STATUS_LABELS[status].toLowerCase()} reports`}
                    checked={rule.statuses.includes(status)}
                    onChange={(next) => toggleStatus(status, next)}
                  />
                  <span aria-hidden>{STATUS_LABELS[status]}</span>
                </span>
              ))}
            </span>
          </SettingRow>
        </Rows>
      </Section>

      <Section
        label="Then"
        note={<LimitCounter used={rule.actions.length} ceiling={ACTIONS_MAX} label="actions" />}
        actions={
          rule.actions.length < ACTIONS_MAX ? (
            <Select
              aria-label="Add an action"
              placeholder="Add action"
              width="md"
              value={undefined}
              options={ACTION_OPTIONS}
              onChange={(kind) => addAction(kind as ActionKind)}
            />
          ) : undefined
        }
      >
        <p className="section-intro">Proton does these in order.</p>

        {rule.actions.length === 0 ? (
          <EmptyState inset icon="pulse" title="No actions">
            {problems.at(`${path}.actions`) ?? 'Add what Proton should do when the rule is met.'}
          </EmptyState>
        ) : (
          rule.actions.map((action, at) => (
            <ActionBlock
              key={(keys.length === count ? keys[at] : undefined) ?? `pending:${at}`}
              guildId={guildId}
              form={form}
              problems={problems}
              action={action}
              path={`${path}.actions.${at}`}
              ruleIndex={index}
              position={at}
              count={rule.actions.length}
              onMove={(delta) => move(at, delta)}
              onRemove={() => removeAction(at)}
              onChange={(next) =>
                setActions((current) => current.map((held, spot) => (spot === at ? next : held)))
              }
            />
          ))
        )}
      </Section>

      {punitive ? (
        <Section label="Risk">
          <div className="moderation-report-banner">
            <StatusBanner tone="warning">{RISK}</StatusBanner>
          </div>
          <Rows>
            <SettingRow
              title="I understand the risk"
              description="Proton won’t save a rule that punishes until this is ticked."
              error={problems.at(`${path}.acknowledgedRisk`)}
            >
              <Checkbox
                label="I understand that false reports can get members punished"
                checked={rule.acknowledgedRisk}
                onChange={(next) => form.set(`${path}.acknowledgedRisk`, next)}
              />
            </SettingRow>
          </Rows>
        </Section>
      ) : null}

      <Section label="Summary">
        <p className="moderation-report-summary" aria-live="polite">
          {describeRule(rule, config, names)}
        </p>
      </Section>

      <div className="moderation-report-danger-row">
        <Button tone="danger-quiet" icon="trash" onClick={remove}>
          Delete rule
        </Button>
      </div>
    </>
  );
}

interface TestTarget {
  ruleIndex: number;
  actionIndex: number;
}

interface ActionProps {
  guildId: string;
  form: ModerationForm;
  problems: Problems;
  action: AutomationAction;
  path: string;
  ruleIndex: number;
  position: number;
  count: number;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onChange: (next: AutomationAction) => void;
}

function ActionRows({
  guildId,
  form,
  problems,
  action,
  path,
  ruleIndex,
  position,
  count,
  editing,
  onMove,
  onRemove,
  onToggle,
  onChange,
}: ActionProps & { editing: boolean; onToggle: () => void }): ReactElement {
  const number = position + 1;
  const test = { ruleIndex, actionIndex: position };

  return (
    <Rows>
      <SettingRow
        title={
          <span className="moderation-report-action-title">
            <span className="moderation-preset-index">{number}</span>
            {ACTION_LABELS[action.kind]}
          </span>
        }
        error={problems.at(path)}
      >
        <span className="moderation-preset-actions">
          <IconButton
            tone="ghost"
            size="sm"
            icon="caret-up"
            label={`Move action ${number} up`}
            disabled={position === 0}
            onClick={() => onMove(-1)}
          />
          <IconButton
            tone="ghost"
            size="sm"
            icon="caret-down"
            label={`Move action ${number} down`}
            disabled={position === count - 1}
            onClick={() => onMove(1)}
          />
          <IconButton
            tone="danger-quiet"
            size="sm"
            icon="trash"
            label={`Remove action ${number}`}
            onClick={onRemove}
          />
        </span>
      </SettingRow>

      {action.kind === 'alert' ? (
        <AlertFields
          guildId={guildId}
          form={form}
          problems={problems}
          action={action}
          path={path}
          test={test}
          editing={editing}
          onToggle={onToggle}
          onChange={onChange}
        />
      ) : null}

      {action.kind === 'dm' ? (
        <MessageRow
          guildId={guildId}
          form={form}
          problems={problems}
          kind="dm"
          message={action.message}
          path={`${path}.message`}
          note={DM_WARNING}
          test={test}
          channelId={null}
          editing={editing}
          onToggle={onToggle}
        />
      ) : null}

      {action.kind === 'punish' ? (
        <PunishFields
          form={form}
          problems={problems}
          action={action}
          path={path}
          onChange={onChange}
        />
      ) : null}

      {action.kind === 'add_role' || action.kind === 'remove_role' ? (
        <SettingRow
          title="Role"
          description={
            action.kind === 'add_role'
              ? 'Given to the reported member. Needs Manage Roles, and a role below Proton’s.'
              : 'Taken from the reported member. Needs Manage Roles, and a role below Proton’s.'
          }
          error={action.roleId === '' ? 'Choose a role.' : problems.at(`${path}.roleId`)}
        >
          <RolePicker
            guildId={guildId}
            label={action.kind === 'add_role' ? 'Role to give' : 'Role to take away'}
            value={action.roleId === '' ? null : action.roleId}
            allowNone={false}
            invalid={action.roleId === ''}
            onChange={(roleId) => {
              if (roleId !== null) onChange({ ...action, roleId });
            }}
          />
        </SettingRow>
      ) : null}
    </Rows>
  );
}

function ActionBlock(props: ActionProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const { guildId, form, problems, action, path, onChange } = props;

  return (
    <>
      <ActionRows {...props} editing={editing} onToggle={() => setEditing((open) => !open)} />

      {editing && (action.kind === 'alert' || action.kind === 'dm') ? (
        <MessageEditorBlock
          guildId={guildId}
          form={form}
          problems={problems}
          kind={action.kind}
          message={action.message}
          path={`${path}.message`}
          roleIds={action.kind === 'alert' ? action.roleIds : []}
          onClose={() => setEditing(false)}
          onChange={(message) => onChange({ ...action, message })}
        />
      ) : null}
    </>
  );
}

function AlertFields({
  guildId,
  form,
  problems,
  action,
  path,
  test,
  editing,
  onToggle,
  onChange,
}: {
  guildId: string;
  form: ModerationForm;
  problems: Problems;
  action: Extract<AutomationAction, { kind: 'alert' }>;
  path: string;
  test: TestTarget;
  editing: boolean;
  onToggle: () => void;
  onChange: (next: AutomationAction) => void;
}): ReactElement {
  return (
    <>
      <SettingRow
        title="Channel"
        description="Needs Send Messages and Embed Links there."
        error={problems.at(`${path}.channelId`)}
      >
        <ChannelPicker
          guildId={guildId}
          label="Alert channel"
          value={action.channelId ?? null}
          noneLabel="The report channel"
          placeholder="The report channel"
          onChange={(next) => {
            const { channelId: _dropped, ...rest } = action;
            onChange(next === null ? rest : { ...rest, channelId: next });
          }}
        />
      </SettingRow>

      <SettingRow
        stacked
        title="Roles to mention"
        description="Mentioned at the top of the alert."
        error={problems.at(`${path}.roleIds`)}
      >
        <RoleMultiPicker
          guildId={guildId}
          label="Add a role to mention"
          value={action.roleIds}
          max={ALERT_ROLES_MAX}
          onChange={(roleIds) =>
            onChange({
              ...action,
              roleIds,
              message:
                roleIds.length > 0 && !action.message.mentions.roles
                  ? { ...action.message, mentions: { ...action.message.mentions, roles: true } }
                  : action.message,
            })
          }
        />
      </SettingRow>

      <MessageRow
        guildId={guildId}
        form={form}
        problems={problems}
        kind="alert"
        message={action.message}
        path={`${path}.message`}
        test={test}
        channelId={action.channelId ?? form.value.reports.channelId ?? null}
        editing={editing}
        onToggle={onToggle}
      />
    </>
  );
}

function PunishFields({
  form,
  problems,
  action,
  path,
  onChange,
}: {
  form: ModerationForm;
  problems: Problems;
  action: Extract<AutomationAction, { kind: 'punish' }>;
  path: string;
  onChange: (next: AutomationAction) => void;
}): ReactElement {
  const { types } = form.value.punish;
  const timed = action.punishment === 'timeout' || action.punishment === 'ban';
  const serverDefault =
    action.punishment === 'timeout'
      ? humaniseDuration(types.timeout.defaultDuration)
      : types.ban.defaultDuration === null
        ? 'permanent'
        : humaniseDuration(types.ban.defaultDuration);
  const reasonError = problems.at(`${path}.reason`);

  return (
    <>
      <SettingRow title="Punishment" error={problems.at(`${path}.punishment`)}>
        <Select
          aria-label="Punishment"
          width="sm"
          value={action.punishment}
          options={PUNISH_OPTIONS}
          onChange={(value) =>
            onChange({ ...action, punishment: value as PunishKind, duration: null })
          }
        />
      </SettingRow>

      {timed ? (
        <SettingRow
          stacked
          title="Length"
          description={`Server default: ${serverDefault}, from Punish settings.`}
          error={problems.at(`${path}.duration`)}
        >
          <span className="moderation-report-condition">
            <SegmentedControl
              label="Punishment length"
              value={action.duration === null ? 'default' : 'custom'}
              options={LENGTH_OPTIONS}
              onChange={(next) =>
                onChange({
                  ...action,
                  duration: next === 'default' ? null : action.punishment === 'ban' ? '7d' : '1h',
                })
              }
            />
            {action.duration !== null ? (
              <DurationInput
                label="Punishment length"
                value={action.duration}
                max={action.punishment === 'timeout' ? 28 * DAY_MS : 365 * DAY_MS}
                units={['m', 'h', 'd', 'w']}
                onChange={(duration) => onChange({ ...action, duration })}
              />
            ) : null}
          </span>
        </SettingRow>
      ) : null}

      <SettingRow
        stacked
        title="Reason"
        description="Shown to the member and in Discord’s audit log."
        error={reasonError}
      >
        <TextInput
          width="full"
          aria-label="Punishment reason"
          maxLength={REASON_MAX}
          invalid={reasonError !== undefined}
          value={action.reason}
          onChange={(event) => onChange({ ...action, reason: event.currentTarget.value })}
        />
      </SettingRow>

      <SettingRow
        title="Tell the member"
        description="Whether the member gets the punishment message from Member notifications."
        error={problems.at(`${path}.notify`)}
      >
        <Select
          aria-label="Tell the member"
          width="md"
          value={action.notify}
          options={NOTIFY_OPTIONS}
          onChange={(value) =>
            onChange({ ...action, notify: value as (typeof NOTIFY_OPTIONS)[number]['value'] })
          }
        />
      </SettingRow>
    </>
  );
}

function previewSample<F>(
  surface: PlaceholderSurface<F>,
  message: StaffMessage,
): MessagePreview<StaffMessage> | null {
  const sample = surface.samples[0];
  return sample === undefined ? null : previewMessage(surface, message, sample);
}

function messageSummary(message: StaffMessage | DmMessage): string {
  const embed = message.embeds[0];
  const text = embed?.title ?? embed?.description ?? message.content ?? '';
  const line = text.split('\n')[0]?.trim() ?? '';

  if (line === '') return message.v2.length > 0 ? 'A components layout' : 'Empty message';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function messageProblem(problems: Problems, path: string): string | undefined {
  if (problems.at(path) !== undefined) return problems.at(path);

  const nested = problems.paths.find((candidate) => candidate.startsWith(`${path}.`));
  return nested === undefined ? undefined : problems.at(nested);
}

function MessageRow({
  guildId,
  form,
  problems,
  kind,
  message,
  path,
  note,
  test,
  channelId,
  editing,
  onToggle,
}: {
  guildId: string;
  form: ModerationForm;
  problems: Problems;
  kind: 'alert' | 'dm';
  message: StaffMessage | DmMessage;
  path: string;
  note?: string | undefined;
  test: TestTarget;
  channelId: string | null;
  editing: boolean;
  onToggle: () => void;
}): ReactElement {
  const error = messageProblem(problems, path);

  return (
    <SettingRow title="Message" description={messageSummary(message)} note={note} error={error}>
      <span className="moderation-report-message-actions">
        <TestMessage
          key={`${test.ruleIndex}:${test.actionIndex}`}
          guildId={guildId}
          moduleId="moderation"
          simulations={form.view.simulations}
          simulationId={
            kind === 'alert' ? REPORT_ALERT_SURFACE.id : REPORT_MEMBER_NOTICE_SURFACE.id
          }
          draft={form.value as unknown as Record<string, unknown>}
          dirty={form.dirty}
          fixed={{ ruleIndex: test.ruleIndex, actionIndex: test.actionIndex }}
          configuredChannelId={channelId}
        />
        <Button size="sm" aria-expanded={editing} onClick={onToggle}>
          {editing ? 'Close editor' : 'Edit message'}
        </Button>
      </span>
    </SettingRow>
  );
}

function MessageEditorBlock({
  guildId,
  form,
  problems,
  kind,
  message,
  path,
  roleIds,
  onClose,
  onChange,
}: {
  guildId: string;
  form: ModerationForm;
  problems: Problems;
  kind: 'alert' | 'dm';
  message: StaffMessage | DmMessage;
  path: string;
  roleIds: readonly string[];
  onClose: () => void;
  onChange: (next: StaffMessage) => void;
}): ReactElement {
  const surface = kind === 'alert' ? REPORT_ALERT_SURFACE : REPORT_MEMBER_NOTICE_SURFACE;
  const roles = useQuery({ ...rolesQuery(guildId), enabled: roleIds.length > 0 });

  const preview = useMemo(() => {
    const rendered =
      kind === 'alert'
        ? previewSample(REPORT_ALERT_SURFACE, message)
        : previewSample(REPORT_MEMBER_NOTICE_SURFACE, message);
    const pinged = kind === 'alert' && message.mentions.roles && roleIds.length > 0;
    if (rendered === null || !pinged) return rendered;

    const names = new Map(rendered.mentionNames);
    for (const role of roles.data ?? []) names.set(role.id, role.name);

    const pings = roleIds.map((roleId) => `<@&${roleId}>`).join(' ');
    const content = rendered.message.content;

    return {
      ...rendered,
      mentionNames: names,
      message: { ...rendered.message, content: content ? `${pings}\n${content}` : pings },
    };
  }, [message, kind, roleIds, roles.data]);

  const hasLayout = message.v2.length > 0;

  const editor = hasLayout ? (
    <Section label="Layout" intro={LAYOUT_NOTE}>
      <Rows>
        <SettingRow title="Components layout">
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
    <MessageEditor
      guildId={guildId}
      value={message}
      allow={{ components: false, mentions: false }}
      placeholders={placeholderSlot(surface, form.templateDiagnosticsAt)}
      contentLabel="Message text"
      contentDescription={CONTENT_DESCRIPTION}
      errorAt={problems.at}
      pathPrefix={path}
      onChange={(next) => onChange({ ...message, ...next })}
    />
  );

  return (
    <div className="moderation-report-message-editor">
      <EditorPreviewLayout
        editor={editor}
        previewTitle={kind === 'alert' ? 'What staff see' : 'What the member receives'}
        preview={
          <div className="stack stack-10">
            {kind === 'dm' ? <StatusBanner tone="warning">{DM_WARNING}</StatusBanner> : null}
            <DiscordPreview
              message={preview?.message ?? message}
              mentionNames={preview?.mentionNames}
              now={preview?.now}
              empty="This message is empty, so nothing is sent."
            />
            {preview !== null ? <p className="text-xs text-muted">{preview.caption}</p> : null}
            {preview?.problem !== undefined ? (
              <p className="text-xs text-danger">
                Filled in for this sample, the message could not be sent. The preview shows it as
                written.
              </p>
            ) : null}
          </div>
        }
      />
      <div className="moderation-report-message-close">
        <Button size="sm" onClick={onClose}>
          Close editor
        </Button>
      </div>
    </div>
  );
}

function RunRow({
  run,
  now,
  names,
}: {
  run: AutomationRunView;
  now: number;
  names: ReadonlyMap<string, string>;
}): ReactElement {
  const status = RUN_STATUS[run.status];
  const outcomes = [...run.outcomes].sort((a, b) => a.index - b.index);
  const target = useMember(run.targetId);
  const mentionNames = useMemo(
    () => (target === undefined ? names : new Map([...names, [run.targetId, target.displayName]])),
    [names, target, run.targetId],
  );

  return (
    <div className="moderation-report-run">
      <div className="moderation-report-run-head">
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="moderation-report-run-rule">{run.ruleName}</span>
        <MetaSeparator />
        <MemberCell userId={run.targetId} />
        <span className="moderation-report-run-time text-muted text-xs">
          <When at={run.createdAt} now={now} />
        </span>
      </div>

      {outcomes.length > 0 ? (
        <ol className="moderation-report-outcomes">
          {outcomes.map((outcome) => (
            <li
              key={`${outcome.index}:${outcome.at}`}
              className="moderation-report-outcome"
              data-ok={outcome.ok ? '' : undefined}
            >
              <span className="moderation-report-outcome-step">
                {`${outcome.index + 1}. ${OUTCOME_KINDS[outcome.kind] ?? outcome.kind}`}
              </span>
              <span className={outcome.ok ? 'text-secondary' : 'text-danger'}>
                {readableOutcome(outcome.message, mentionNames, now)}
                {outcome.caseId !== undefined ? (
                  <span className="mono text-muted">{` · Case ${outcome.caseId}`}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : run.status === 'running' ? null : (
        <p className="moderation-report-outcome text-muted">No steps were recorded.</p>
      )}
    </div>
  );
}

function runFilterOf(value: string | undefined): RunStatus | typeof RUN_PROBLEMS | undefined {
  if (value === RUN_PROBLEMS) return RUN_PROBLEMS;
  return RUN_STATUSES.find((candidate) => candidate === value);
}

function RecentRuns({ guildId }: { guildId: string }): ReactElement {
  const search = useModuleSearch();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<string>(() => runFilterOf(search.status) ?? ALL_RUNS);
  const channels = useQuery(channelsQuery(guildId));
  const roles = useQuery(rolesQuery(guildId));

  const status = runFilterOf(filter);

  const runs = useQuery(
    automationRunsQuery(guildId, {
      ...(status !== undefined ? { status } : {}),
      page,
      pageSize: RUNS_PAGE_SIZE,
    }),
  );
  const now = useNow(runs.dataUpdatedAt);

  const list = runs.data?.runs ?? [];
  const members = useMemo(() => [...new Set(list.map((run) => run.targetId))], [list]);

  const names = useMemo(() => {
    const known = new Map<string, string>();
    for (const role of roles.data ?? []) known.set(role.id, role.name);
    for (const channel of channels.data ?? []) known.set(channel.id, channel.name);
    return known;
  }, [roles.data, channels.data]);

  return (
    <Section
      label="Recent runs"
      actions={
        <Select
          aria-label="Show runs"
          width="sm"
          value={filter}
          options={RUN_FILTERS}
          onChange={(value) => {
            setFilter(value);
            setPage(1);
          }}
        />
      }
    >
      {runs.isPending ? (
        <LoadingArea label="Loading automation runs" minHeight={120} />
      ) : runs.error !== null ? (
        <StatusBanner tone="danger" live="polite">
          {readFailure(runs.error, 'the automation runs')}
        </StatusBanner>
      ) : list.length === 0 ? (
        <EmptyState inset icon="pulse" title="No runs">
          {status === undefined
            ? 'Runs appear here once a rule is met.'
            : 'No runs match this filter.'}
        </EmptyState>
      ) : (
        <MemberProvider guildId={guildId} userIds={members}>
          <Rows>
            {list.map((run) => (
              <RunRow key={run.id} run={run} now={now} names={names} />
            ))}
          </Rows>
          {runs.data !== undefined && runs.data.total > RUNS_PAGE_SIZE ? (
            <div className="table-foot moderation-report-runs-foot">
              <Pagination
                page={page}
                pageSize={RUNS_PAGE_SIZE}
                total={runs.data.total}
                noun="runs"
                onPageChange={setPage}
              />
            </div>
          ) : null}
        </MemberProvider>
      )}
    </Section>
  );
}
