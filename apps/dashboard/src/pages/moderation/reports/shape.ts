import type { Closing, ModerationConfig, ReportsConfig } from '@proton/module-moderation/config';
import { durationWords, joinWords, type RuleNames } from '@proton/module-moderation/rule-summary';

export const SETUP_STEPS = [
  { id: 'methods', label: 'Reporting methods' },
  { id: 'channel', label: 'Report channel' },
  { id: 'reasons', label: 'Reasons and evidence' },
  { id: 'reporters', label: 'Who can report' },
  { id: 'review', label: 'Review and turn on' },
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number]['id'];

export type StepState = 'current' | 'problem' | 'done' | 'todo';

export type ReportTab = 'reports-settings' | 'reports-automation' | 'reports-messages';

type Method = keyof ReportsConfig['methods'];

const METHODS: readonly Method[] = ['command', 'userMenu', 'messageMenu', 'reaction'];

const METHOD_NAMES: Readonly<Record<Method, string>> = {
  command: '/report',
  userMenu: 'Report user',
  messageMenu: 'Report message',
  reaction: 'a reaction',
};

// Most specific first: reports.limits.commentMin belongs to evidence, the rest of limits to reporters.
const STEP_PATHS: readonly (readonly [string, SetupStep])[] = [
  ['reports.methods', 'methods'],
  ['reports.reaction', 'methods'],
  ['reports.channelId', 'channel'],
  ['reports.notifyRoleIds', 'channel'],
  ['reports.reasons', 'reasons'],
  ['reports.allowCustomReason', 'reasons'],
  ['reports.requireReason', 'reasons'],
  ['reports.requireComment', 'reasons'],
  ['reports.requireAttachment', 'reasons'],
  ['reports.maxAttachments', 'reasons'],
  ['reports.copyReportedMessage', 'reasons'],
  ['reports.limits.commentMin', 'reasons'],
  ['reports.limits.commentMax', 'reasons'],
  ['reports.limits.customReasonMax', 'reasons'],
  ['reports.reporters', 'reporters'],
  ['reports.immuneRoleIds', 'reporters'],
  ['reports.reviewerRoleIds', 'reporters'],
  ['reports.limits', 'reporters'],
];

export function notSetUp(saved: ModerationConfig | null): boolean {
  return saved !== null && !saved.reports.enabled && saved.reports.channelId === undefined;
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

export function stepOfPath(path: string): SetupStep | null {
  if (!under(path, 'reports')) return null;

  for (const [prefix, step] of STEP_PATHS) {
    if (under(path, prefix)) return step;
  }

  return 'review';
}

export function stepName(label: string, state: StepState): string {
  if (state === 'problem') return `${label}, needs fixing`;
  if (state === 'done') return `${label}, done`;
  return label;
}

export function swapped<T>(list: readonly T[], at: number, to: number): T[] {
  const next = [...list];
  const held = next[at];
  const other = next[to];
  if (held === undefined || other === undefined) return next;
  next[at] = other;
  next[to] = held;
  return next;
}

export function stepIndex(step: SetupStep): number {
  return SETUP_STEPS.findIndex((candidate) => candidate.id === step);
}

export function problemSteps(paths: Iterable<string>): Set<SetupStep> {
  const steps = new Set<SetupStep>();

  for (const path of paths) {
    const step = stepOfPath(path);
    if (step !== null) steps.add(step);
  }

  return steps;
}

export function firstProblemStep(paths: Iterable<string>): SetupStep | null {
  const steps = problemSteps(paths);
  return SETUP_STEPS.find((step) => steps.has(step.id))?.id ?? null;
}

export function reactionChannelsChosen(reports: ReportsConfig): boolean {
  return reports.reaction.channelMode === 'all' || reports.reaction.channelIds.length > 0;
}

export function stepComplete(step: SetupStep, reports: ReportsConfig): boolean {
  switch (step) {
    case 'methods':
      return (
        METHODS.some((method) => reports.methods[method]) &&
        (!reports.methods.reaction || reactionChannelsChosen(reports))
      );
    case 'channel':
      return reports.channelId !== undefined;
    case 'reasons':
      return (
        !(reports.requireReason && reports.reasons.length === 0 && !reports.allowCustomReason) &&
        reports.reasons.every((reason) => reason.label.trim() !== '')
      );
    case 'reporters':
      return reports.reporters.mode === 'everyone' || reports.reporters.roleIds.length > 0;
    case 'review':
      return reports.enabled;
  }
}

export function stepState(
  step: SetupStep,
  context: {
    current: SetupStep;
    visited: ReadonlySet<SetupStep>;
    problems: ReadonlySet<SetupStep>;
    reports: ReportsConfig;
  },
): StepState {
  if (step === context.current) return 'current';
  if (context.problems.has(step)) return 'problem';
  return context.visited.has(step) && stepComplete(step, context.reports) ? 'done' : 'todo';
}

export function tabOfPath(path: string): ReportTab | null {
  if (!under(path, 'reports')) return null;
  if (under(path, 'reports.automation')) return 'reports-automation';
  if (under(path, 'reports.notifications')) return 'reports-messages';
  return 'reports-settings';
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

function listed(parts: readonly string[]): string {
  return parts.map(capital).join(' · ');
}

export function rolesText(roleIds: readonly string[], names: RuleNames): string {
  const resolved = roleIds.map((roleId) => names.role?.(roleId));

  if (resolved.every((name): name is string => typeof name === 'string' && name !== '')) {
    return joinWords(
      resolved.map((name) => `@${name}`),
      'and',
    );
  }

  return plural(roleIds.length, 'role');
}

export function channelsText(channelIds: readonly string[], names: RuleNames): string {
  const resolved = channelIds.map((channelId) => names.channel?.(channelId));

  if (resolved.every((name): name is string => typeof name === 'string' && name !== '')) {
    return joinWords(
      resolved.map((name) => `#${name}`),
      'and',
    );
  }

  return plural(channelIds.length, 'channel');
}

export function enabledMethods(reports: ReportsConfig): Method[] {
  return METHODS.filter((method) => reports.methods[method]);
}

export function methodsSentence(reports: ReportsConfig): string {
  const on = enabledMethods(reports).map((method) => METHOD_NAMES[method]);
  return on.length === 0 ? 'No way to report is on' : capital(joinWords(on, 'and'));
}

export function reactionNeedsMore(reports: ReportsConfig): boolean {
  return (
    (reports.requireReason && reports.reaction.reasonId === null) ||
    reports.requireComment ||
    reports.requireAttachment
  );
}

export function reactionSentence(reports: ReportsConfig, names: RuleNames): string {
  const { reaction } = reports;
  const chosen = reaction.channelIds.length > 0;

  const where =
    reaction.channelMode === 'all' || (reaction.channelMode === 'except' && !chosen)
      ? 'in every channel'
      : reaction.channelMode === 'only'
        ? chosen
          ? `only in ${channelsText(reaction.channelIds, names)}`
          : 'in no channel yet'
        : `everywhere except ${channelsText(reaction.channelIds, names)}`;

  const reason = reports.reasons.find((candidate) => candidate.id === reaction.reasonId);
  const filed = reactionNeedsMore(reports)
    ? 'the member finishes the report in a DM'
    : reason !== undefined
      ? `filed as “${reason.label}”`
      : 'filed straight away';

  const removed = reaction.removeReaction ? ', then the reaction is removed' : '';
  return `${capital(where)}, ${filed}${removed}`;
}

export function reasonsSentence(reports: ReportsConfig): string {
  return listed([
    reports.reasons.length === 0
      ? 'no predefined reasons'
      : plural(reports.reasons.length, 'reason'),
    reports.allowCustomReason ? 'own reasons allowed' : 'no own reasons',
    reports.requireReason ? 'reason required' : 'reason optional',
  ]);
}

export function evidenceSentence(reports: ReportsConfig): string {
  const { commentMin, commentMax } = reports.limits;

  return listed([
    reports.requireComment
      ? `details required, ${Math.max(1, commentMin)}–${commentMax} characters`
      : 'details optional',
    reports.requireAttachment
      ? `file required, up to ${reports.maxAttachments}`
      : `up to ${plural(reports.maxAttachments, 'file')}`,
    reports.copyReportedMessage ? 'reported messages copied' : 'reported messages not copied',
  ]);
}

export function reportersSentence(reports: ReportsConfig, names: RuleNames): string {
  const { mode, roleIds } = reports.reporters;

  if (mode === 'only') {
    return roleIds.length === 0 ? 'Nobody yet (pick a role)' : `Only ${rolesText(roleIds, names)}`;
  }

  if (mode === 'except' && roleIds.length > 0) {
    return `Everyone except ${rolesText(roleIds, names)}`;
  }

  return 'Everyone';
}

export function immuneSentence(reports: ReportsConfig, names: RuleNames): string {
  return reports.immuneRoleIds.length === 0
    ? 'Nobody'
    : capital(rolesText(reports.immuneRoleIds, names));
}

export function reviewersSentence(reports: ReportsConfig, names: RuleNames): string {
  return reports.reviewerRoleIds.length === 0
    ? 'Server managers only'
    : `Server managers and ${rolesText(reports.reviewerRoleIds, names)}`;
}

export function limitsSentence(reports: ReportsConfig): string {
  const { limits } = reports;

  return listed([
    `${durationWords(limits.cooldown)} between reports`,
    `${limits.maxOpenPerServer.toLocaleString('en-US')} open in the server`,
    `${limits.maxOpenPerMember.toLocaleString('en-US')} open about one member`,
    limits.duplicateProtection ? 'repeats refused' : 'repeats allowed',
  ]);
}

export function closingSentence(closing: Closing, names: RuleNames): string {
  const after = closing.delay === null ? '' : ` after ${durationWords(closing.delay)}`;

  switch (closing.mode) {
    case 'keep':
      return 'Kept in the report channel';
    case 'move':
      return closing.channelId === undefined
        ? `Moved${after} (choose a channel)`
        : `Moved to ${channelsText([closing.channelId], names)}${after}`;
    case 'delete':
      return `Deleted${after}`;
  }
}

export function notificationsSentence(reports: ReportsConfig): string {
  const { submitted, accepted, dismissed } = reports.notifications;
  const on = [submitted, accepted, dismissed].filter((notice) => notice.enabled).length;
  return on === 0 ? 'Off' : `${on} of 3 on`;
}

export function ageText(since: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));

  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;

  return plural(Math.floor(hours / 24), 'day');
}

export function openLine(open: number, oldestOpenAt: number | null, now: number): string {
  if (open === 0) return 'None waiting';

  const waiting = `${open.toLocaleString('en-US')} waiting`;
  return oldestOpenAt === null ? waiting : `${waiting}, oldest ${ageText(oldestOpenAt, now)}`;
}
