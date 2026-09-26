import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ModerationConfig,
  moderationDefaultConfig,
  REPORTS_DEFAULTS,
  type ReportsConfig,
} from '@proton/module-moderation/config';
import { describeRule, type RuleNames } from '@proton/module-moderation/rule-summary';
import {
  ageText,
  closingSentence,
  evidenceSentence,
  firstProblemStep,
  immuneSentence,
  limitsSentence,
  methodsSentence,
  notificationsSentence,
  notSetUp,
  openLine,
  problemSteps,
  reactionNeedsMore,
  reactionSentence,
  reasonsSentence,
  reportersSentence,
  reviewersSentence,
  type SetupStep,
  stepComplete,
  stepName,
  stepOfPath,
  stepState,
  swapped,
  tabOfPath,
} from '../src/pages/moderation/reports/shape.ts';

const REPORT_CHANNEL = '200000000000000001';
const ARCHIVE_CHANNEL = '200000000000000002';
const MOD_ROLE = '300000000000000001';
const HELPER_ROLE = '300000000000000002';
const NOW = Date.UTC(2026, 8, 19, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const NAMES: RuleNames = {
  channel: (id) =>
    ({ [REPORT_CHANNEL]: 'reports', [ARCHIVE_CHANNEL]: 'report-archive' })[id] ?? null,
  role: (id) => ({ [MOD_ROLE]: 'Mods', [HELPER_ROLE]: 'Helpers' })[id] ?? null,
};

function reports(patch: Partial<ReportsConfig> = {}): ReportsConfig {
  return { ...structuredClone(REPORTS_DEFAULTS), ...patch };
}

function config(patch: Partial<ReportsConfig> = {}): ModerationConfig {
  return { ...structuredClone(moderationDefaultConfig), reports: reports(patch) };
}

describe('which setup step owns a saved setting', () => {
  test.each([
    ['reports.methods', 'methods'],
    ['reports.methods.command', 'methods'],
    ['reports.reaction.reasonId', 'methods'],
    ['reports.channelId', 'channel'],
    ['reports.notifyRoleIds.0', 'channel'],
    ['reports.reasons.2.label', 'reasons'],
    ['reports.requireReason', 'reasons'],
    ['reports.limits.commentMin', 'reasons'],
    ['reports.limits.customReasonMax', 'reasons'],
    ['reports.reporters.roleIds', 'reporters'],
    ['reports.immuneRoleIds', 'reporters'],
    ['reports.limits.cooldown', 'reporters'],
    ['reports.limits.maxOpenPerMember', 'reporters'],
    ['reports.automation.0.actions', 'review'],
    ['reports.notifications.accepted.message.content', 'review'],
    ['reports.enabled', 'review'],
  ] as const)('%s belongs to %s', (path, step) => {
    expect(stepOfPath(path)).toBe(step);
  });

  test('settings outside user reports belong to no step', () => {
    expect(stepOfPath('punish.types.ban.forceReason')).toBeNull();
    expect(stepOfPath('reportsExtra')).toBeNull();
    expect(stepOfPath('enabled')).toBeNull();
  });

  test('a failed save jumps to the earliest step with a problem', () => {
    expect(firstProblemStep(['reports.limits.cooldown', 'reports.channelId'])).toBe('channel');
    expect(firstProblemStep(['reports.automation.0.conditions', 'reports.reasons.0.id'])).toBe(
      'reasons',
    );
    expect(firstProblemStep(['punish.reasons.0.aliases.0'])).toBeNull();
    expect(firstProblemStep([])).toBeNull();
  });

  test('problem steps collect every owning step once', () => {
    expect([
      ...problemSteps(['reports.methods', 'reports.reaction.emoji', 'reports.channelId']),
    ]).toEqual(['methods', 'channel']);
  });
});

describe('step completion', () => {
  test('the defaults leave only the report channel to choose', () => {
    const defaults = reports();

    expect(stepComplete('methods', defaults)).toBe(true);
    expect(stepComplete('channel', defaults)).toBe(false);
    expect(stepComplete('reasons', defaults)).toBe(true);
    expect(stepComplete('reporters', defaults)).toBe(true);
    expect(stepComplete('review', defaults)).toBe(false);
  });

  test('methods need one way to report, and a reaction limited to no channel is incomplete', () => {
    const off = reports({
      methods: { command: false, userMenu: false, messageMenu: false, reaction: false },
    });
    expect(stepComplete('methods', off)).toBe(false);

    const nowhere = reports({
      methods: { command: false, userMenu: false, messageMenu: false, reaction: true },
      reaction: { ...REPORTS_DEFAULTS.reaction, channelMode: 'only', channelIds: [] },
    });
    expect(stepComplete('methods', nowhere)).toBe(false);

    const somewhere = reports({
      methods: { command: false, userMenu: false, messageMenu: false, reaction: true },
      reaction: { ...REPORTS_DEFAULTS.reaction, channelMode: 'only', channelIds: [REPORT_CHANNEL] },
    });
    expect(stepComplete('methods', somewhere)).toBe(true);
  });

  test('reasons are incomplete when nobody could ever give the required reason', () => {
    expect(stepComplete('reasons', reports({ reasons: [], allowCustomReason: false }))).toBe(false);
    expect(stepComplete('reasons', reports({ reasons: [], allowCustomReason: true }))).toBe(true);
    expect(
      stepComplete(
        'reasons',
        reports({ reasons: [{ id: 'blank', label: '  ', description: '' }] }),
      ),
    ).toBe(false);
  });

  test('"only these roles" with no role is incomplete', () => {
    expect(stepComplete('reporters', reports({ reporters: { mode: 'only', roleIds: [] } }))).toBe(
      false,
    );
    expect(
      stepComplete('reporters', reports({ reporters: { mode: 'only', roleIds: [MOD_ROLE] } })),
    ).toBe(true);
  });

  test('the indicator shows the current step, then problems, then visited complete steps', () => {
    const context = {
      current: 'reasons' as SetupStep,
      visited: new Set<SetupStep>(['methods', 'channel', 'reasons']),
      problems: new Set<SetupStep>(['channel']),
      reports: reports(),
    };

    expect(stepState('reasons', context)).toBe('current');
    expect(stepState('channel', context)).toBe('problem');
    expect(stepState('methods', context)).toBe('done');
    expect(stepState('reporters', context)).toBe('todo');
  });

  test('each step button is named by its label and state, which narrow screens hide', () => {
    expect(stepName('Report channel', 'problem')).toBe('Report channel, needs fixing');
    expect(stepName('Reporting methods', 'done')).toBe('Reporting methods, done');
    expect(stepName('Who can report', 'todo')).toBe('Who can report');
    expect(stepName('Reasons and evidence', 'current')).toBe('Reasons and evidence');

    const setup = readFileSync(
      join(import.meta.dir, '..', 'src', 'pages', 'moderation', 'reports', 'setup.tsx'),
      'utf8',
    );
    expect(setup).toContain('aria-label={stepName(step.label, state)}');
  });

  test('the intro says decision messages are on unless turned off, as the defaults are', () => {
    const setup = readFileSync(
      join(import.meta.dir, '..', 'src', 'pages', 'moderation', 'reports', 'setup.tsx'),
      'utf8',
    );

    expect(REPORTS_DEFAULTS.notifications.accepted.enabled).toBe(true);
    expect(REPORTS_DEFAULTS.notifications.dismissed.enabled).toBe(true);
    expect(setup).toContain('a DM when staff accept or dismiss their report.');
    expect(setup).toContain('Both DMs can be turned off under Messages.');
  });
});

describe('moving a rule’s actions', () => {
  test('actions and their editor keys move together, so an open editor follows its action', () => {
    const actions = ['alert', 'dm', 'punish'];
    const keys = ['k1', 'k2', 'k3'];

    const movedActions = swapped(actions, 0, 1);
    const movedKeys = swapped(keys, 0, 1);

    expect(movedActions).toEqual(['dm', 'alert', 'punish']);
    expect(movedKeys).toEqual(['k2', 'k1', 'k3']);
    expect(movedKeys[movedActions.indexOf('alert')]).toBe('k1');
    expect(actions).toEqual(['alert', 'dm', 'punish']);
  });

  test('a move off either end changes nothing', () => {
    expect(swapped(['a', 'b'], 1, 2)).toEqual(['a', 'b']);
    expect(swapped(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});

describe('the setup gate', () => {
  test('shows setup only for a saved config that was never set up', () => {
    expect(notSetUp(config())).toBe(true);
    expect(notSetUp(config({ channelId: REPORT_CHANNEL }))).toBe(false);
    expect(notSetUp(config({ enabled: true }))).toBe(false);
    expect(notSetUp(null)).toBe(false);
  });

  test('report problems are sent to the tab that owns them', () => {
    expect(tabOfPath('reports.automation.1.acknowledgedRisk')).toBe('reports-automation');
    expect(tabOfPath('reports.notifications.submitted.enabled')).toBe('reports-messages');
    expect(tabOfPath('reports.closing.accepted.channelId')).toBe('reports-settings');
    expect(tabOfPath('punish.immunity.global')).toBeNull();
  });
});

describe('summary sentences', () => {
  test('methods', () => {
    expect(methodsSentence(reports())).toBe('/report, Report user and Report message');
    expect(
      methodsSentence(
        reports({
          methods: { command: true, userMenu: false, messageMenu: false, reaction: true },
        }),
      ),
    ).toBe('/report and a reaction');
    expect(
      methodsSentence(
        reports({
          methods: { command: false, userMenu: false, messageMenu: false, reaction: true },
        }),
      ),
    ).toBe('A reaction');
    expect(
      methodsSentence(
        reports({
          methods: { command: false, userMenu: false, messageMenu: false, reaction: false },
        }),
      ),
    ).toBe('No way to report is on');
  });

  test('a reaction that needs a reason is finished in a direct message', () => {
    const defaults = reports();

    expect(reactionNeedsMore(defaults)).toBe(true);
    expect(reactionSentence(defaults, NAMES)).toBe(
      'In every channel, the member finishes the report in a DM, then the reaction is removed',
    );
  });

  test('a reaction with its own reason is filed straight away', () => {
    const tagged = reports({
      reaction: {
        ...REPORTS_DEFAULTS.reaction,
        reasonId: 'spam',
        channelMode: 'only',
        channelIds: [REPORT_CHANNEL],
        removeReaction: false,
      },
    });

    expect(reactionNeedsMore(tagged)).toBe(false);
    expect(reactionSentence(tagged, NAMES)).toBe('Only in #reports, filed as “Spam or flooding”');
  });

  test('required details always need the direct message, whatever the reason', () => {
    const detailed = reports({
      requireComment: true,
      reaction: { ...REPORTS_DEFAULTS.reaction, reasonId: 'spam', channelMode: 'except' },
    });

    expect(reactionNeedsMore(detailed)).toBe(true);
    expect(reactionSentence(detailed, NAMES)).toStartWith('In every channel, the member finishes');
  });

  test('reasons and evidence', () => {
    expect(reasonsSentence(reports())).toBe('5 reasons · Own reasons allowed · Reason required');
    expect(
      reasonsSentence(reports({ reasons: [], allowCustomReason: false, requireReason: false })),
    ).toBe('No predefined reasons · No own reasons · Reason optional');

    expect(evidenceSentence(reports())).toBe(
      'Details optional · Up to 4 files · Reported messages copied',
    );
    expect(
      evidenceSentence(
        reports({
          requireComment: true,
          requireAttachment: true,
          maxAttachments: 2,
          copyReportedMessage: false,
          limits: { ...REPORTS_DEFAULTS.limits, commentMin: 20, commentMax: 500 },
        }),
      ),
    ).toBe(
      'Details required, 20–500 characters · File required, up to 2 · Reported messages not copied',
    );
  });

  test('who can report, who is immune and who reviews', () => {
    expect(reportersSentence(reports(), NAMES)).toBe('Everyone');
    expect(
      reportersSentence(reports({ reporters: { mode: 'only', roleIds: [MOD_ROLE] } }), NAMES),
    ).toBe('Only @Mods');
    expect(reportersSentence(reports({ reporters: { mode: 'only', roleIds: [] } }), NAMES)).toBe(
      'Nobody yet (pick a role)',
    );
    expect(
      reportersSentence(
        reports({ reporters: { mode: 'except', roleIds: [MOD_ROLE, HELPER_ROLE] } }),
        NAMES,
      ),
    ).toBe('Everyone except @Mods and @Helpers');
    expect(reportersSentence(reports({ reporters: { mode: 'except', roleIds: [] } }), NAMES)).toBe(
      'Everyone',
    );
    expect(
      reportersSentence(
        reports({ reporters: { mode: 'only', roleIds: ['300000000000000099'] } }),
        {},
      ),
    ).toBe('Only 1 role');

    expect(immuneSentence(reports(), NAMES)).toBe('Nobody');
    expect(immuneSentence(reports({ immuneRoleIds: [MOD_ROLE] }), NAMES)).toBe('@Mods');

    expect(reviewersSentence(reports(), NAMES)).toBe('Server managers only');
    expect(reviewersSentence(reports({ reviewerRoleIds: [HELPER_ROLE] }), NAMES)).toBe(
      'Server managers and @Helpers',
    );
  });

  test('limits', () => {
    expect(limitsSentence(reports())).toBe(
      '2 minutes between reports · 100 open in the server · 10 open about one member · Repeats refused',
    );
  });

  test('closing', () => {
    expect(closingSentence({ mode: 'keep', delay: null }, NAMES)).toBe(
      'Kept in the report channel',
    );
    expect(closingSentence({ mode: 'move', channelId: ARCHIVE_CHANNEL, delay: '1h' }, NAMES)).toBe(
      'Moved to #report-archive after 1 hour',
    );
    expect(closingSentence({ mode: 'move', delay: null }, NAMES)).toBe('Moved (choose a channel)');
    expect(closingSentence({ mode: 'delete', delay: '2d' }, NAMES)).toBe('Deleted after 2 days');
  });

  test('reporter messages', () => {
    expect(notificationsSentence(reports())).toBe('2 of 3 on');

    const off = reports();
    off.notifications.accepted.enabled = false;
    off.notifications.dismissed.enabled = false;
    expect(notificationsSentence(off)).toBe('Off');
  });

  test('the default automation rule reads as a sentence for the review step', () => {
    const withChannel = config({ channelId: REPORT_CHANNEL });
    const [rule] = withChannel.reports.automation;
    if (rule === undefined) throw new Error('the default automation rule is missing');

    expect(describeRule(rule, withChannel, NAMES)).toBe(
      'When 3 different members report the same person within 24 hours (open or in review), ' +
        'post an alert in #reports.',
    );
  });
});

describe('the open queue line', () => {
  test('counts what waits and says how long the oldest has waited', () => {
    expect(openLine(0, null, NOW)).toBe('None waiting');
    expect(openLine(3, NOW - 2 * HOUR - 5 * MINUTE, NOW)).toBe('3 waiting, oldest 2 h');
    expect(openLine(1, null, NOW)).toBe('1 waiting');
  });

  test('ages read in minutes, hours, then days', () => {
    expect(ageText(NOW - 30_000, NOW)).toBe('under a minute');
    expect(ageText(NOW - 45 * MINUTE, NOW)).toBe('45 min');
    expect(ageText(NOW - 47 * HOUR, NOW)).toBe('47 h');
    expect(ageText(NOW - 72 * HOUR, NOW)).toBe('3 days');
    expect(ageText(NOW + HOUR, NOW)).toBe('under a minute');
  });
});
