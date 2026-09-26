import { describe, expect, test } from 'bun:test';
import {
  SAMPLE_NOW,
  type TemplateReport,
  validateConfigTemplates,
} from '@proton/core/placeholders';
import type { z } from 'zod';
import {
  type ModerationConfig,
  moderationConfigSchema,
  moderationDefaultConfig,
} from '../src/config.ts';
import {
  moderationTemplates,
  REPORT_ALERT_SURFACE,
  REPORT_MEMBER_NOTICE_SURFACE,
  REPORT_NOTICE_SURFACES,
} from '../src/placeholders.ts';
import {
  renderMemberNotice,
  renderReportAlert,
  reportDashboardUrl,
} from '../src/reports/automation-surfaces.ts';
import {
  type automationActionSchema,
  DEFAULT_REPORT_NOTIFICATIONS,
  DEFAULT_STAFF_ALERT,
} from '../src/reports/config.ts';
import { type ReportNoticeFacts, renderReportNotice } from '../src/reports/surfaces.ts';
import { NOTIFICATION_KINDS } from '../src/reports/types.ts';

type ActionInput = z.input<typeof automationActionSchema>;

const REPORT_CHANNEL = '500000000000000009';

function withActions(actions: ActionInput[]): ModerationConfig {
  return moderationConfigSchema.parse({
    reports: {
      channelId: REPORT_CHANNEL,
      automation: [{ id: 'r', name: 'Rule', conditions: { reports: 1 }, actions }],
    },
  });
}

function dm(description: string): ActionInput {
  return { kind: 'dm', message: { embeds: [{ title: 'Note', description }] } };
}

function alert(description: string): ActionInput {
  return { kind: 'alert', roleIds: [], message: { embeds: [{ title: 'Alert', description }] } };
}

function codesAt(report: TemplateReport, path: string): string[] {
  return report.byPath.get(path)?.map(({ code }) => code) ?? [];
}

function errors(report: TemplateReport) {
  return [...report.byPath.entries()].flatMap(([path, diagnostics]) =>
    diagnostics
      .filter(
        (diagnostic) =>
          diagnostic.severity === 'error' || diagnostic.code === 'unknown_placeholder',
      )
      .map((diagnostic) => `${path}: ${diagnostic.message}`),
  );
}

describe('moderationTemplates', () => {
  test('it carries every moderation surface', () => {
    expect(Object.keys(moderationTemplates.surfaces).sort()).toEqual([
      'moderation.audit_reason',
      'moderation.punished',
      'moderation.report_accepted',
      'moderation.report_alert',
      'moderation.report_dismissed',
      'moderation.report_member_notice',
      'moderation.report_submitted',
      'moderation.unpunished',
    ]);
  });

  test('the default config validates with no error and no unknown key anywhere', () => {
    const report = validateConfigTemplates(moderationTemplates, moderationDefaultConfig);

    expect(report.blocking).toEqual([]);
    expect(errors(report)).toEqual([]);
  });

  test('it collects every templated path: punishments, reporter messages and rule messages', () => {
    const config = withActions([alert('{rule.name}'), dm('{server.name}')]);
    const sites = moderationTemplates.collect(config);
    const surfaceAt = (path: string) => sites.find((site) => site.path === path)?.surfaceId;

    expect(surfaceAt('punish.types.ban.auditReason')).toBe('moderation.audit_reason');
    expect(surfaceAt('punish.notifications.messages.kick.embeds.0.title')).toBe(
      'moderation.punished',
    );
    for (const kind of NOTIFICATION_KINDS) {
      expect(surfaceAt(`reports.notifications.${kind}.message.embeds.0.title`)).toBe(
        `moderation.report_${kind}`,
      );
    }
    expect(surfaceAt('reports.automation.0.actions.0.message.embeds.0.description')).toBe(
      'moderation.report_alert',
    );
    expect(surfaceAt('reports.automation.0.actions.1.message.embeds.0.description')).toBe(
      'moderation.report_member_notice',
    );
    expect(
      sites.filter((site) => site.path === 'reports.automation.0.actions.1.message.embeds.0.title'),
    ).toHaveLength(1);
  });

  test('a member notice that names the reports or the member is blocked', () => {
    const path = 'reports.automation.0.actions.0.message.embeds.0.description';

    for (const key of ['report.reporter_count', 'report.id', 'report.comment', 'target.username']) {
      const report = validateConfigTemplates(
        moderationTemplates,
        withActions([dm(`{${key}}`)]),
        moderationDefaultConfig,
      );

      expect(report.blocking.map(({ diagnostic }) => [key, diagnostic.code])).toEqual([
        [key, 'restricted'],
      ]);
      expect(codesAt(report, path)).toContain('restricted');
    }
  });

  test('the same keys are fine in a staff alert', () => {
    const report = validateConfigTemplates(
      moderationTemplates,
      withActions([
        alert('{report.reporter_count} {report.total_reports} {target.mention} {report.url}'),
      ]),
      moderationDefaultConfig,
    );

    expect(report.blocking).toEqual([]);
    expect(errors(report)).toEqual([]);
  });
});

describe('the default texts render cleanly', () => {
  test('the staff alert', () => {
    const facts = REPORT_ALERT_SURFACE.samples[0]?.facts;
    if (!facts) throw new Error('the alert surface has no sample');

    const rendered = renderReportAlert(DEFAULT_STAFF_ALERT, facts, SAMPLE_NOW);
    if (!rendered.ok) throw new Error(rendered.humanReason);

    const [embed] = rendered.message.embeds;
    expect(rendered.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual(
      [],
    );
    expect(embed?.title).toBe(`Several members reported ${facts.target?.username}`);
    expect(embed?.description).toBe(
      `3 different members have filed 4 reports about <@${facts.target?.id}>. Latest report: \`Rk3P9aQ\`.`,
    );
    expect(embed?.footer?.text).toBe('Rule: Several members report the same person');
  });

  test('each reporter notification', () => {
    for (const [index, kind] of NOTIFICATION_KINDS.entries()) {
      const facts = REPORT_NOTICE_SURFACES[index]?.samples[0]?.facts as ReportNoticeFacts;
      const rendered = renderReportNotice(
        kind,
        DEFAULT_REPORT_NOTIFICATIONS[kind],
        facts,
        SAMPLE_NOW,
      );
      if (!rendered.ok) throw new Error(`${kind}: ${rendered.humanReason}`);

      const [embed] = rendered.message.embeds;
      expect(rendered.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual(
        [],
      );
      expect(embed?.description).toContain('`Rk3P9aQ`');
      expect(embed?.description).toContain(facts.target?.username ?? '?');
    }
  });

  test('a member notice renders restricted keys as nothing', () => {
    const facts = REPORT_MEMBER_NOTICE_SURFACE.samples[0]?.facts;
    if (!facts) throw new Error('the member notice surface has no sample');

    const rendered = renderMemberNotice(
      {
        mentions: { everyone: false, roles: false, users: false },
        embeds: [
          {
            title: 'Hi',
            description: 'From {server.name}: {report.reporter_count}{target.username}.',
          },
        ],
        components: [],
        v2: [],
      },
      facts,
      SAMPLE_NOW,
    );
    if (!rendered.ok) throw new Error(rendered.humanReason);

    expect(rendered.message.embeds[0]?.description).toBe('From Proton HQ: .');
    expect(rendered.diagnostics.map(({ code }) => code)).toContain('restricted');
  });
});

describe('the dashboard link', () => {
  test('it points at the report in the queue, and is absent without a dashboard', () => {
    expect(reportDashboardUrl('https://prtn.xyz/', '900000000000000001', 'Rk3P9aQ')).toBe(
      'https://prtn.xyz/dashboard/900000000000000001/moderation?area=reports-queue&id=Rk3P9aQ',
    );
    expect(reportDashboardUrl(undefined, '900000000000000001', 'Rk3P9aQ')).toBeNull();
    expect(reportDashboardUrl('  ', '900000000000000001', 'Rk3P9aQ')).toBeNull();
  });
});
