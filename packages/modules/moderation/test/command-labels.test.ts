import { describe, expect, test } from 'bun:test';
import { type CommandLabeler, formatCommandLabel, type RawOption } from '@proton/core';
import type { z } from 'zod';
import { type moderationConfigSchema, moderationDefaultConfig } from '../src/config.ts';
import { evaluateTarget } from '../src/reports/automation.ts';
import { buildReportCard } from '../src/reports/card.ts';
import { cardViewFor } from '../src/reports/delivery.ts';
import { reportNoticeFacts } from '../src/reports/notify.ts';
import { renderReportNotice } from '../src/reports/surfaces.ts';
import { EMPTY_EVIDENCE, type ReportRecord } from '../src/reports/types.ts';
import { renderProgress } from '../src/role-run.ts';
import type { RoleRun } from '../src/run-store.ts';
import { pressEvent, slashEvent } from './drivers.ts';
import {
  CHANNEL,
  EVERYONE_ROLE,
  GRANT_ROLE,
  GUILD,
  harness,
  MEMBER,
  MOD_ROLE,
  MODERATOR,
  member,
  REPORTER,
  type RunOverrides,
  roleOption,
  subcommand,
  userOption,
} from './harness.ts';
import { MOD_PERMISSIONS } from './punish-kit.ts';
import { customIds, lastFollowUp, NOW, punishRig, textOf } from './punish-rig.ts';
import { REPORT_CHANNEL, type ReportsRig, reportsRig } from './reports-setup.ts';

const RENAMED: Record<string, string> = {
  ban: 'b',
  lockdown: 'lock',
  report: 'flag',
  role: 'r',
  timeout: 'mute',
  warn: 'w',
};

const commandLabel: CommandLabeler = (key, path) => formatCommandLabel(key, path, RENAMED[key]);

const RENAMED_RUN: Partial<RunOverrides> = { commandLabel };

function roleRun(overrides: Partial<RoleRun> = {}): RoleRun {
  return {
    runId: 'run-1',
    guildId: GUILD,
    roleId: GRANT_ROLE,
    mode: 'all',
    actorId: MODERATOR,
    actorRoleIds: [MOD_ROLE],
    channelId: CHANNEL,
    after: '0',
    scanned: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    listFailures: 0,
    startedAt: 0,
    cancelled: false,
    ...overrides,
  };
}

async function answerOf(
  name: string,
  options: RawOption[],
  overrides: Partial<RunOverrides> = {},
): Promise<string> {
  const h = harness({ now: NOW });
  await h.run(name, options, overrides);
  return h.replyContent() ?? '';
}

describe('member-facing copy names each command the way this server shows it', () => {
  const CASES: Array<{
    label: string;
    name: string;
    options: RawOption[];
    overrides?: Partial<RunOverrides>;
    renamed: string;
    fallback: string;
  }> = [
    {
      label: '/lockdown add',
      name: 'lockdown',
      options: subcommand('add', []),
      renamed: 'Locked this channel. Run /lock remove when it should reopen.',
      fallback: 'Locked this channel. Run /lockdown remove when it should reopen.',
    },
    {
      label: '/lockdown without a subcommand',
      name: 'lockdown',
      options: subcommand('reopen', []),
      renamed: 'Use /lock add to lock this channel, or /lock remove to reopen it.',
      fallback: 'Use /lockdown add to lock this channel, or /lockdown remove to reopen it.',
    },
    {
      label: '/ban without a subcommand',
      name: 'ban',
      options: subcommand('forever', []),
      renamed: 'Use /b add to ban someone, or /b remove to lift a ban.',
      fallback: 'Use /ban add to ban someone, or /ban remove to lift a ban.',
    },
    {
      label: '/warn without a subcommand',
      name: 'warn',
      options: subcommand('list', []),
      renamed: 'Use /w add to warn somebody, or /w remove to withdraw a warning by its case ID.',
      fallback:
        'Use /warn add to warn somebody, or /warn remove to withdraw a warning by its case ID.',
    },
    {
      label: '/timeout without a subcommand',
      name: 'timeout',
      options: subcommand('extend', []),
      renamed: 'Use /mute add to time somebody out, or /mute remove to end a timeout early.',
      fallback: 'Use /timeout add to time somebody out, or /timeout remove to end a timeout early.',
    },
    {
      label: '/role without a subcommand',
      name: 'role',
      options: subcommand('swap', []),
      renamed:
        'Use /r add or /r remove for one member, or /r all, /r bots, /r humans or /r in to ' +
        'give a role to many at once.',
      fallback:
        'Use /role add or /role remove for one member, or /role all, /role bots, /role humans ' +
        'or /role in to give a role to many at once.',
    },
    {
      label: '/role in @everyone',
      name: 'role',
      options: subcommand('in', [
        roleOption('role', GRANT_ROLE),
        roleOption('target_role', EVERYONE_ROLE),
      ]),
      renamed: 'Every member already has @everyone. Use `/r all` for that.',
      fallback: 'Every member already has @everyone. Use `/role all` for that.',
    },
    {
      label: '/role all with nothing wired in',
      name: 'role',
      options: subcommand('all', [roleOption('role', GRANT_ROLE)]),
      overrides: { unbindRoleDeps: true },
      renamed: 'Use /r add for one member at a time.',
      fallback: 'Use /role add for one member at a time.',
    },
    {
      label: '/role all started',
      name: 'role',
      options: subcommand('all', [roleOption('role', GRANT_ROLE)]),
      renamed: '`/r cancel` stops it.',
      fallback: '`/role cancel` stops it.',
    },
  ];

  test.each(CASES)('$label', async ({ name, options, overrides, renamed, fallback }) => {
    expect(await answerOf(name, options, { ...overrides, ...RENAMED_RUN })).toContain(renamed);
    expect(await answerOf(name, options, overrides)).toContain(fallback);
  });

  test('a second mass run is told to cancel the first under its new name', async () => {
    for (const [overrides, says] of [
      [RENAMED_RUN, 'run `/r cancel` to stop it.'],
      [{}, 'run `/role cancel` to stop it.'],
    ] as const) {
      const h = harness({ now: NOW });
      await h.roleRuns.put(roleRun({ applied: 12 }));
      await h.run('role', subcommand('bots', [roleOption('role', GRANT_ROLE)]), overrides);
      expect(h.replyContent()).toContain(says);
    }
  });
});

describe('the mass role progress message', () => {
  test('names /role cancel as the server shows it when posted and on every tick', async () => {
    const h = harness({ now: NOW });

    await h.run('role', subcommand('all', [roleOption('role', GRANT_ROLE)]), RENAMED_RUN);
    expect(h.sentIn(CHANNEL)[0]?.content).toContain('`/r cancel` stops it where it is.');

    h.members.pages = [[member(MEMBER)], [member(REPORTER)]];
    await h.runJob(RENAMED_RUN);

    expect(h.edits().at(-1)?.message.content).toContain('`/r cancel` stops it where it is.');
  });

  test('without labels it keeps today’s wording', async () => {
    const h = harness({ now: NOW });

    await h.run('role', subcommand('all', [roleOption('role', GRANT_ROLE)]));
    h.members.pages = [[member(MEMBER)], [member(REPORTER)]];
    await h.runJob();

    expect(h.sentIn(CHANNEL)[0]?.content).toContain('`/role cancel` stops it where it is.');
    expect(h.edits().at(-1)?.message.content).toContain('`/role cancel` stops it where it is.');
  });

  test('rendered with no label source it names /role cancel', () => {
    const run = roleRun({ scanned: 3, applied: 3 });

    expect(renderProgress(run)).toContain('`/role cancel`');
    expect(renderProgress(run, { commandLabel })).toContain('`/r cancel`');
  });
});

describe('a confirmation whose permissions cannot be re-read', () => {
  test('names the command as the server shows it', async () => {
    for (const [overrides, says] of [
      [RENAMED_RUN, 'can still use /w in this server'],
      [{}, 'can still use /warn in this server'],
    ] as const) {
      const rig = punishRig({ config: { punish: { confirmRecentCase: { enabled: true } } } });
      rig.ledger.seed({
        caseId: 'Krecent',
        guildId: GUILD,
        kind: 'warn',
        targetId: MEMBER,
        createdAt: rig.h.now() - 60_000,
      });

      await rig.command(
        slashEvent('warn', subcommand('add', [userOption('user', MEMBER)]), {
          permissions: MOD_PERMISSIONS,
        }),
        overrides,
      );
      const [go] = customIds(lastFollowUp(rig.h));
      if (!go) throw new Error('the warning asked for no confirmation');

      rig.deps.commandGate = async () => {
        throw new Error('permissions are unreachable');
      };
      await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }), overrides);

      expect(textOf(lastFollowUp(rig.h))).toContain(says);
    }
  });
});

type ConfigInput = z.input<typeof moderationConfigSchema>;

async function filedByCommand(rig: ReportsRig): Promise<ReportRecord> {
  const result = await rig.store.submit(
    {
      guildId: GUILD,
      reporterId: REPORTER,
      targetId: MEMBER,
      method: 'command',
      reasonId: 'spam',
      reason: 'Spam or flooding',
      customReason: null,
      comment: null,
      source: null,
      evidence: EMPTY_EVIDENCE,
      idempotencyKey: 'labels:1',
      now: rig.h.now(),
    },
    {
      cooldownMs: 0,
      bypassCooldown: true,
      duplicateProtection: false,
      maxOpenPerMember: 100,
      maxOpenPerServer: 1000,
    },
  );
  if (result.status === 'refused') throw new Error(`the report was refused: ${result.code}`);
  return result.report;
}

describe('user reports name /report the way this server shows it', () => {
  test('a switched-off /report says which command is off', async () => {
    for (const [overrides, says] of [
      [RENAMED_RUN, '`/flag` is off in this server.'],
      [{}, '`/report` is off in this server.'],
    ] as const) {
      const rig = reportsRig({ reports: { methods: { command: false } } });

      await rig.command(
        slashEvent('report', [userOption('member', MEMBER)], { userId: REPORTER }),
        overrides,
      );

      expect(textOf(rig.h.replies()[0])).toContain(says);
    }
  });

  test('the report card says it was submitted via the renamed command', async () => {
    const rig = reportsRig();
    const report = await filedByCommand(rig);

    const renamed = await cardViewFor(
      rig.h.context(rig.overrides(RENAMED_RUN)),
      rig.deps,
      report,
      true,
      NOW,
    );
    const plain = await cardViewFor(rig.h.context(rig.overrides()), rig.deps, report, true, NOW);

    expect(buildReportCard(renamed).embeds[0]?.footer?.text).toBe('Submitted via /flag');
    expect(buildReportCard(plain).embeds[0]?.footer?.text).toBe('Submitted via /report');
  });

  test('{report.method} in the reporter’s DM is the renamed command', async () => {
    const rig = reportsRig();
    const report = await filedByCommand(rig);
    const base = moderationDefaultConfig.reports.notifications.submitted.message;
    const message = { ...base, content: 'Filed with {report.method}', embeds: [] };

    for (const [overrides, says] of [
      [RENAMED_RUN, 'Filed with /flag'],
      [{}, 'Filed with /report'],
    ] as const) {
      const ctx = rig.h.context(rig.overrides(overrides));
      const facts = await reportNoticeFacts(ctx, rig.deps, report, 'submitted', new Set());
      const rendered = renderReportNotice('submitted', message, facts, NOW);

      expect(rendered.ok ? rendered.message.content : rendered.humanReason).toBe(says);
    }
  });

  test('{report.method} in a staff alert is the renamed command', async () => {
    for (const [overrides, says] of [
      [RENAMED_RUN, 'Filed with /flag'],
      [{}, 'Filed with /report'],
    ] as const) {
      const reports: NonNullable<ConfigInput['reports']> = {
        enabled: true,
        channelId: REPORT_CHANNEL,
        automation: [
          {
            id: 'labels',
            name: 'Labels',
            conditions: { reports: 1 },
            actions: [
              { kind: 'alert', roleIds: [], message: { content: 'Filed with {report.method}' } },
            ],
          },
        ],
      };
      const configInput: ConfigInput = { reports };
      const rig = reportsRig({ reports });
      await filedByCommand(rig);

      await evaluateTarget(
        rig.h.context(rig.overrides({ configInput, ...overrides })),
        rig.deps,
        MEMBER,
        rig.h.now(),
      );

      expect(rig.h.sentIn(REPORT_CHANNEL)[0]?.content).toBe(says);
    }
  });
});
