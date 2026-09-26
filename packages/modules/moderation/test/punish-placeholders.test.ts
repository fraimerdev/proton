import { describe, expect, test } from 'bun:test';
import {
  SAMPLE_NOW,
  type TemplateReport,
  validateConfigTemplates,
} from '@proton/core/placeholders';
import {
  type ModerationConfig,
  moderationConfigSchema,
  moderationDefaultConfig,
} from '../src/config.ts';
import {
  AUDIT_REASON_SURFACE,
  PUNISHED_SURFACE,
  punishTemplates,
  renderAuditReasonTemplate,
  renderPunishmentNotice,
  UNPUNISHED_SURFACE,
} from '../src/placeholders.ts';
import { DM_DEFAULTS, PUNISH_DIRECTIONS } from '../src/punish/config.ts';

const BAN_DESCRIPTION = 'punish.notifications.messages.ban.embeds.0.description';

function withBanDescription(description: string): ModerationConfig {
  return moderationConfigSchema.parse({
    punish: {
      notifications: {
        messages: { ban: { embeds: [{ title: 'Banned', description }] } },
      },
    },
  });
}

function codesAt(report: TemplateReport, path: string): string[] {
  return report.byPath.get(path)?.map(({ code }) => code) ?? [];
}

const SAMPLE = PUNISHED_SURFACE.samples[0]?.facts;

describe('the punish surfaces', () => {
  test('every surface carries the punishment sample', () => {
    for (const surface of [PUNISHED_SURFACE, UNPUNISHED_SURFACE, AUDIT_REASON_SURFACE]) {
      expect(surface.samples.map((sample) => sample.id)).toEqual(['punishment']);
    }
    expect(Object.keys(punishTemplates.surfaces).sort()).toEqual([
      'moderation.audit_reason',
      'moderation.punished',
      'moderation.unpunished',
    ]);
  });

  test('the defaults validate with nothing blocking and no errors anywhere', () => {
    const report = validateConfigTemplates(punishTemplates, moderationDefaultConfig);

    expect(report.blocking).toEqual([]);
    for (const diagnostics of report.byPath.values()) {
      expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    }
  });

  test('collect finds the five audit reasons and every default message', () => {
    const paths = punishTemplates.collect(moderationDefaultConfig).map((site) => site.path);

    expect(paths.filter((path) => path.endsWith('.auditReason')).sort()).toEqual([
      'punish.types.ban.auditReason',
      'punish.types.kick.auditReason',
      'punish.types.timeout.auditReason',
      'punish.types.unban.auditReason',
      'punish.types.untimeout.auditReason',
    ]);
    for (const direction of PUNISH_DIRECTIONS) {
      expect(paths).toContain(`punish.notifications.messages.${direction}.embeds.0.title`);
    }
  });

  test('every default direct message renders cleanly for the sample', () => {
    if (!SAMPLE) throw new Error('the punished surface has no sample');

    for (const direction of PUNISH_DIRECTIONS) {
      const rendered = renderPunishmentNotice(
        DM_DEFAULTS[direction],
        { ...SAMPLE, direction },
        SAMPLE_NOW,
      );

      if (!rendered.ok) throw new Error(`${direction}: ${rendered.humanReason}`);
      expect(rendered.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual(
        [],
      );
      expect(rendered.message.embeds[0]?.title).toContain('Proton HQ');
      expect(rendered.message.embeds[0]?.description).toBe('Posting invite links');
    }
  });

  test('a permanent ban reads Permanent and a timeout names its end', () => {
    if (!SAMPLE) throw new Error('the punished surface has no sample');

    const ban = renderPunishmentNotice(
      DM_DEFAULTS.ban,
      { ...SAMPLE, direction: 'ban', durationMs: null, expiresAt: null },
      SAMPLE_NOW,
    );
    const timeout = renderPunishmentNotice(DM_DEFAULTS.timeout, SAMPLE, SAMPLE_NOW);

    expect(ban.ok && ban.message.embeds[0]?.fields?.[0]?.value).toBe('Permanent');
    expect(timeout.ok && timeout.message.embeds[0]?.fields?.[0]?.value).toMatch(/^<t:\d+:F>$/);
  });
});

describe('what a punishment message may not say', () => {
  test('a key the surface does not know is flagged on its path', () => {
    const report = validateConfigTemplates(
      punishTemplates,
      withBanDescription('{report.internal_note}'),
      moderationDefaultConfig,
    );

    expect(codesAt(report, BAN_DESCRIPTION)).toContain('unknown_placeholder');
  });

  test('the audit-log reason is staff-only, so a changed save using it in a DM is blocked', () => {
    const report = validateConfigTemplates(
      punishTemplates,
      withBanDescription('Logged as {punishment.audit_reason}'),
      moderationDefaultConfig,
    );

    expect(report.blocking.map(({ path, diagnostic }) => [path, diagnostic.code])).toEqual([
      [BAN_DESCRIPTION, 'restricted'],
    ]);
  });

  test('a rendered restricted key never reaches the member', () => {
    if (!SAMPLE) throw new Error('the punished surface has no sample');
    const message = withBanDescription('Logged as {punishment.audit_reason}').punish.notifications
      .messages.ban;

    const rendered = renderPunishmentNotice(message, { ...SAMPLE, direction: 'ban' }, SAMPLE_NOW);

    expect(rendered.ok && rendered.message.embeds[0]?.description).not.toContain('Kestrel');
    expect(rendered.diagnostics.map(({ code }) => code)).toContain('restricted');
  });

  test('member keys are not offered to the audit-log reason', () => {
    const config = moderationConfigSchema.parse({
      punish: { types: { kick: { auditReason: '{user.mention} {punishment.reason}' } } },
    });

    const report = validateConfigTemplates(punishTemplates, config, moderationDefaultConfig);

    expect(codesAt(report, 'punish.types.kick.auditReason')).toContain('unknown_placeholder');
  });
});

describe('the audit-log reason', () => {
  test('renders as plain text and is clipped to 512 characters', () => {
    const text = renderAuditReasonTemplate(
      '{moderator.username}: {punishment.reason} ({punishment.duration})',
      {
        moderatorId: '100000000000000030',
        moderatorName: 'kestrel',
        reason: 'x'.repeat(600),
        durationMs: 3_600_000,
      },
      SAMPLE_NOW,
    );

    expect(text.startsWith('kestrel: xxx')).toBe(true);
    expect(text).toHaveLength(512);
  });

  test('the default falls back to No reason given', () => {
    const text = renderAuditReasonTemplate(
      moderationDefaultConfig.punish.types.ban.auditReason,
      { moderatorId: '100000000000000030', moderatorName: null, reason: null, durationMs: null },
      SAMPLE_NOW,
    );

    expect(text).toBe('No reason given');
  });
});
