import type { ModerationConfig } from '../config.ts';
import type { PunishKind } from '../punish/config.ts';
import type { AutomationAction, AutomationRule } from './config.ts';
import type { ReportStatus } from './types.ts';

export interface RuleNames {
  channel?(channelId: string): string | null | undefined;
  role?(roleId: string): string | null | undefined;
}

const UNIT_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  s: ['second', 'seconds'],
  m: ['minute', 'minutes'],
  h: ['hour', 'hours'],
  d: ['day', 'days'],
  w: ['week', 'weeks'],
};

const STATUS_ORDER: readonly ReportStatus[] = ['open', 'in_review', 'accepted', 'dismissed'];

const STATUS_WORDS: Readonly<Record<ReportStatus, string>> = {
  open: 'open',
  in_review: 'in review',
  accepted: 'accepted',
  dismissed: 'dismissed',
};

const PUNISHED: Readonly<Record<PunishKind, string>> = {
  warn: 'warned',
  timeout: 'timed out',
  kick: 'kicked',
  ban: 'banned',
};

export function durationWords(raw: string): string {
  const match = /^(\d+)\s*([smhdw])$/i.exec(raw.trim());
  const words = match ? UNIT_WORDS[(match[2] ?? '').toLowerCase()] : undefined;
  if (!match || !words) return raw;

  const amount = Number(match[1]);
  return `${amount} ${amount === 1 ? words[0] : words[1]}`;
}

export function joinWords(items: readonly string[], conjunction: 'and' | 'or'): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1)}`;
}

function statusPhrase(statuses: readonly ReportStatus[]): string {
  const counted = STATUS_ORDER.filter((status) => statuses.includes(status));
  if (counted.length === STATUS_ORDER.length) return 'any status';
  return joinWords(
    counted.map((status) => STATUS_WORDS[status]),
    'or',
  );
}

function conditionPhrase(rule: AutomationRule): string | null {
  const { reports, reporters, unreviewedFor } = rule.conditions;
  const all = rule.match === 'all';
  const conjunction = all ? 'and' : 'or';
  const counts: string[] = [];

  if (reporters !== null) {
    counts.push(
      reporters === 1
        ? 'a member reports someone'
        : `${reporters} different members report the same person`,
    );
  }

  if (reports !== null) {
    const pronoun = reporters !== null && all;
    counts.push(
      reports > 1
        ? `${pronoun ? 'they are' : 'the same person is'} reported ${reports} times`
        : pronoun
          ? 'they are reported'
          : 'someone is reported',
    );
  }

  const window = durationWords(rule.window);

  if (unreviewedFor === null) {
    return counts.length === 0 ? null : `${joinWords(counts, conjunction)} within ${window}`;
  }

  const wait = durationWords(unreviewedFor);

  if (counts.length === 0) {
    return `a report filed in the last ${window} stays open and unclaimed for ${wait}`;
  }

  const about = all ? 'a report about them' : 'a report about someone';
  return (
    `${joinWords(counts, conjunction)} within ${window} ${conjunction} ` +
    `${about} stays open and unclaimed for ${wait}`
  );
}

function channelText(channelId: string | undefined, fallback: string, names: RuleNames): string {
  if (channelId === undefined) return fallback;

  const name = names.channel?.(channelId);
  return name ? `#${name}` : fallback;
}

function rolesText(roleIds: readonly string[], names: RuleNames): string {
  const resolved = roleIds.map((roleId) => names.role?.(roleId));

  if (resolved.every((name): name is string => typeof name === 'string' && name !== '')) {
    return joinWords(
      resolved.map((name) => `@${name}`),
      'and',
    );
  }

  return roleIds.length === 1 ? 'the chosen role' : `${roleIds.length} chosen roles`;
}

function punishPhrase(
  action: Extract<AutomationAction, { kind: 'punish' }>,
  config: ModerationConfig,
): string {
  switch (action.punishment) {
    case 'warn':
      return 'warn them';
    case 'kick':
      return 'kick them';
    case 'timeout':
      return `time them out for ${durationWords(
        action.duration ?? config.punish.types.timeout.defaultDuration,
      )}`;
    case 'ban': {
      const duration = action.duration ?? config.punish.types.ban.defaultDuration;
      return duration === null ? 'ban them permanently' : `ban them for ${durationWords(duration)}`;
    }
  }
}

function actionPhrase(action: AutomationAction, config: ModerationConfig, names: RuleNames) {
  switch (action.kind) {
    case 'alert': {
      const where =
        action.channelId === undefined
          ? channelText(config.reports.channelId, 'the report channel', names)
          : channelText(action.channelId, 'the chosen channel', names);
      const pinged =
        action.roleIds.length === 0 ? '' : ` mentioning ${rolesText(action.roleIds, names)}`;
      return `post an alert in ${where}${pinged}`;
    }
    case 'dm':
      return 'DM the reported member';
    case 'punish':
      return punishPhrase(action, config);
    case 'add_role':
      return `give them ${rolesText([action.roleId], names)}`;
    case 'remove_role':
      return `take ${rolesText([action.roleId], names)} away from them`;
  }
}

export function describeRule(
  rule: AutomationRule,
  config: ModerationConfig,
  names: RuleNames = {},
): string {
  const condition = conditionPhrase(rule);
  if (condition === null) return 'This rule has no condition, so it never runs.';

  const when = `When ${condition} (${statusPhrase(rule.statuses)})`;
  const actions = rule.actions.map((action) => actionPhrase(action, config, names));
  const sentences = [
    actions.length === 0
      ? `${when}, nothing happens yet. Add an action.`
      : `${when}, ${joinWords(actions, 'and')}.`,
  ];

  const punished = [
    ...new Set(
      rule.actions.flatMap((action) =>
        action.kind === 'punish' ? [PUNISHED[action.punishment]] : [],
      ),
    ),
  ];

  if (punished.length > 0) {
    sentences.push(
      'Proton does this before anyone reviews the reports, so a group of false reports is ' +
        `enough to get someone ${joinWords(punished, 'or')}.`,
    );
    if (!rule.acknowledgedRisk) {
      sentences.push('Confirm that you understand this risk before saving.');
    }
  }

  if (rule.conditions.unreviewedFor !== null && !rule.statuses.includes('open')) {
    sentences.push(
      'Its unclaimed-for condition never applies, because the rule doesn’t count open reports.',
    );
  }

  if (!rule.enabled) sentences.push('The rule is off.');

  return sentences.join(' ');
}
