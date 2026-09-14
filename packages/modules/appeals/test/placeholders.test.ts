import { describe, expect, test } from 'bun:test';
import type { ActionExecutor, ActionRequest, ActionResult, ModuleContext } from '@proton/core';
import {
  formatTemplateIssues,
  PLACEHOLDER_LIMITS,
  type PlaceholderLookup,
  renderTemplate,
  SAMPLE_NOW,
  type TemplateReport,
  validateConfigTemplates,
} from '@proton/core/placeholders';
import fc from 'fast-check';
import { type AppealPanel, type AppealsConfig, appealsConfigSchema } from '../src/config.ts';
import { appealsModule } from '../src/index.ts';
import { decisionMessage, tellAppellant } from '../src/notify.ts';
import {
  APPEAL_DECISION_EVENT,
  APPEAL_DECISION_SURFACE,
  type AppealDecisionFacts,
  appealDecisionFacts,
  appealsTemplates,
  renderAppealDecision,
} from '../src/placeholders.ts';
import type { AppealRecord, AppealStore } from '../src/store.ts';
import { appealView, DAY_MS, type FiledAppeal } from '../src/web.ts';

const GUILD = '900000000000000001';
const MEMBER = '400000000000000001';
const MODERATOR = '100000000000000030';
const DM_CHANNEL = '500000000000000001';

const FILED_AT = SAMPLE_NOW - 2 * DAY_MS;

const ZERO_WIDTH_SPACE = '​';
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';

const HEADING = '**Appeal #12**\n';
const ACCEPTED = 'Your appeal was accepted. You can come back to the server.';
const TURNED_DOWN = 'Your appeal was read and turned down. The decision stands.';
const REJOIN = 'https://discord.gg/example';

const APPROVED_PATH = 'panels.0.approvedMessage';
const DENIED_PATH = 'panels.0.deniedMessage';

function configWith(overrides: Partial<AppealPanel> = {}): AppealsConfig {
  return appealsConfigSchema.parse({
    enabled: true,
    panels: [
      {
        id: 'ban',
        name: 'Ban appeal',
        questions: [{ key: 'why', label: 'Why should this be lifted?' }],
        ...overrides,
      },
    ],
  });
}

function panelWith(overrides: Partial<AppealPanel> = {}): AppealPanel {
  const [panel] = configWith(overrides).panels;
  if (panel === undefined) throw new Error('the form did not parse');
  return panel;
}

function record(overrides: Partial<AppealRecord> = {}): AppealRecord {
  return {
    id: 'appeal-1',
    number: 12,
    status: 'approved',
    filedAt: FILED_AT,
    decidedAt: SAMPLE_NOW,
    guildId: GUILD,
    userId: MEMBER,
    panelId: 'ban',
    origin: 'honeypot',
    jti: 'honeypot:900000000000000001:1',
    decidedBy: MODERATOR,
    decisionNote: null,
    outcomeApplied: true,
    cardChannelId: null,
    cardMessageId: null,
    dmChannelId: DM_CHANNEL,
    dmAttempts: 0,
    answers: [{ key: 'why', label: 'Why should this be lifted?', value: 'I was hacked' }],
    ...overrides,
  };
}

function filedFrom(appeal: AppealRecord): FiledAppeal {
  return {
    id: appeal.id,
    number: appeal.number,
    status: appeal.status,
    filedAt: appeal.filedAt,
    decidedAt: appeal.decidedAt,
  };
}

function lookupFor(appeal: AppealRecord, panel: AppealPanel, now = SAMPLE_NOW): PlaceholderLookup {
  return APPEAL_DECISION_SURFACE.build(appealDecisionFacts(appeal, panel), { now });
}

function dm(appeal: AppealRecord, panel: AppealPanel, now = SAMPLE_NOW): string {
  return decisionMessage(appeal, panel, lookupFor(appeal, panel, now), now);
}

function page(
  appeal: AppealRecord,
  overrides: Partial<AppealPanel> = {},
  now = SAMPLE_NOW,
): string {
  const view = appealView({
    config: configWith(overrides),
    panelId: 'ban',
    issuedAt: FILED_AT,
    now,
    existing: filedFrom(appeal),
  });

  if (view.state !== 'decided') throw new Error(`the appeal page is ${view.state}, not decided`);
  return view.humanReason;
}

function legacyDm(appeal: AppealRecord, panel: AppealPanel): string {
  const verdict = appeal.status === 'approved' ? panel.approvedMessage : panel.deniedMessage;
  const rejoin = appeal.status === 'approved' && panel.rejoinUrl ? `\n\n${panel.rejoinUrl}` : '';

  return `**Appeal #${appeal.number}**\n${verdict}${rejoin}`.slice(0, 2000);
}

function legacyPage(appeal: AppealRecord, panel: AppealPanel, resubmit: boolean): string {
  if (appeal.status === 'approved') return panel.approvedMessage;
  return resubmit ? `${panel.deniedMessage} You may send another one now.` : panel.deniedMessage;
}

function spied(inner: PlaceholderLookup): { lookup: PlaceholderLookup; asked: string[] } {
  const asked: string[] = [];

  return {
    asked,
    lookup: (request) => {
      asked.push(request.canonical);
      return inner(request);
    },
  };
}

function codesAt(report: TemplateReport, path: string): string[] {
  return report.byPath.get(path)?.map(({ code }) => code) ?? [];
}

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function readable(text: string): string {
  return text.replace(/ /g, ' ');
}

describe('the shipped messages', () => {
  test('post in the direct message exactly as before', () => {
    for (const status of ['approved', 'denied'] as const) {
      for (const rejoinUrl of [undefined, REJOIN]) {
        for (const number of [1, 12, 104_729]) {
          const appeal = record({ status, number });
          const panel = panelWith(rejoinUrl === undefined ? {} : { rejoinUrl });

          expect(dm(appeal, panel)).toBe(legacyDm(appeal, panel));
        }
      }
    }

    expect(dm(record(), panelWith({ rejoinUrl: REJOIN }))).toBe(
      `${HEADING}${ACCEPTED}\n\n${REJOIN}`,
    );
    expect(dm(record({ status: 'denied' }), panelWith({ rejoinUrl: REJOIN }))).toBe(
      `${HEADING}${TURNED_DOWN}`,
    );
  });

  test('show on the appeal page exactly as before, the offer to appeal again included', () => {
    const accepted = record();
    const denied = record({ status: 'denied' });
    const again = { allowResubmit: true, cooldownDays: 0 };

    expect(page(accepted)).toBe(ACCEPTED);
    expect(page(denied)).toBe(TURNED_DOWN);
    expect(page(denied, again)).toBe(`${TURNED_DOWN} You may send another one now.`);

    expect(page(accepted)).toBe(legacyPage(accepted, panelWith(), false));
    expect(page(denied, again)).toBe(legacyPage(denied, panelWith(again), true));
  });

  test('any stored text without braces posts byte for byte as before, in both places', () => {
    const text = fc
      .oneof(fc.string({ maxLength: 1900 }), fc.string({ unit: 'binary', maxLength: 900 }))
      .filter((candidate) => !/[{}]/.test(candidate));

    fc.assert(
      fc.property(text, fc.constantFrom('approved', 'denied'), (message, status) => {
        const overrides = { approvedMessage: message, deniedMessage: message };
        const panel = panelWith(overrides);
        const appeal = record({ status });

        expect(dm(appeal, panel)).toBe(legacyDm(appeal, panel));
        expect(page(appeal, overrides)).toBe(legacyPage(appeal, panel, false));
      }),
      { numRuns: 300 },
    );
  });
});

describe('the decision fills in from the appeal and its form', () => {
  test('with the same words in the direct message and on the page', () => {
    const template = 'Appeal #{appeal.number} ({appeal.status}) on {appeal.form_name}.';

    expect(dm(record(), panelWith({ approvedMessage: template }))).toBe(
      `${HEADING}Appeal #12 (approved) on Ban appeal.`,
    );
    expect(page(record(), { approvedMessage: template })).toBe(
      'Appeal #12 (approved) on Ban appeal.',
    );
    expect(page(record({ status: 'denied' }), { deniedMessage: template })).toBe(
      'Appeal #12 (denied) on Ban appeal.',
    );
  });

  test('a date is a Discord timestamp in the DM and a readable date on the page, for one moment', () => {
    const template = 'Decided {appeal.decided_at}, filed {appeal.filed_at:date}.';

    expect(dm(record(), panelWith({ approvedMessage: template }))).toBe(
      `${HEADING}Decided <t:${seconds(SAMPLE_NOW)}:f>, filed <t:${seconds(FILED_AT)}:d>.`,
    );
    expect(readable(page(record(), { approvedMessage: template }))).toBe(
      'Decided Sep 14, 2026, 9:00 AM, filed Sep 12, 2026.',
    );
  });

  test('{now}, {today} and {year} follow the clock the render is given', () => {
    const template = 'In {year}, on {today:date}.';
    const today = Date.UTC(2026, 8, 14);

    expect(dm(record(), panelWith({ approvedMessage: template }))).toBe(
      `${HEADING}In 2026, on <t:${seconds(today)}:d>.`,
    );
    expect(page(record(), { approvedMessage: template })).toBe('In 2026, on Sep 14, 2026.');
    expect(page(record(), { approvedMessage: template }, Date.UTC(2031, 0, 2))).toBe(
      'In 2031, on Jan 2, 2031.',
    );
  });

  test('the rejoin link fills in, and is empty when the form has none or holds no link', () => {
    const template = 'Rejoin: {appeal.rejoin_url:fallback("none")}';
    const render = (rejoinUrl?: string) => {
      const panel = panelWith(rejoinUrl === undefined ? {} : { rejoinUrl });
      return renderAppealDecision(template, lookupFor(record(), panel), 'discord_text', SAMPLE_NOW);
    };

    expect(render(REJOIN).output).toBe(`Rejoin: ${REJOIN}`);
    expect(render(REJOIN).diagnostics).toEqual([]);

    expect(render().output).toBe('Rejoin: none');
    expect(render().diagnostics.map(({ code }) => code)).toEqual(['not_set']);

    expect(render('discord.gg/example').output).toBe('Rejoin: none');
    expect(render('discord.gg/example').diagnostics.map(({ code }) => code)).toEqual([
      'resolver_failed',
    ]);
  });

  test('an appeal with no decision time has no decided date', () => {
    const appeal = record({ status: 'denied', decidedAt: null });
    const rendered = renderAppealDecision(
      '{appeal.decided_at:fallback("not yet")}',
      lookupFor(appeal, panelWith()),
      'plain_text',
      SAMPLE_NOW,
    );

    expect(rendered.output).toBe('not yet');
    expect(rendered.diagnostics.map(({ code }) => code)).toEqual(['not_set']);
  });
});

describe('what the member who appealed must never see', () => {
  test('a moderator or an answer typed into either message blocks the save, naming the field', () => {
    const next = configWith({
      approvedMessage: 'Decided by {appeal.decided_by}.',
      deniedMessage: 'You said {appeal.answer.why}.',
    });
    const report = validateConfigTemplates(appealsTemplates, next, configWith());

    expect(report.blocking.map(({ path, diagnostic }) => [path, diagnostic.code])).toEqual([
      [APPROVED_PATH, 'restricted'],
      [DENIED_PATH, 'restricted'],
    ]);
    expect(formatTemplateIssues(report)).toStartWith(
      `${APPROVED_PATH} Accepted message: {appeal.decided_by} may only be shown to staff, but this destination is seen by the member it is about`,
    );
  });

  test('a fallback or a modifier does not get either past the check', () => {
    for (const approvedMessage of [
      '{appeal.decided_by:fallback("a moderator")}',
      '{appeal.answer.why:upper}',
      '{appeal.answer.why:fallback("nothing")}',
    ]) {
      const report = validateConfigTemplates(
        appealsTemplates,
        configWith({ approvedMessage }),
        configWith(),
      );

      expect(report.blocking.map(({ diagnostic }) => diagnostic.code)).toContain('restricted');
    }
  });

  test('in both places they render nothing, and are never looked up', () => {
    const template = 'By {appeal.decided_by}. You said {appeal.answer.why}.';
    const appeal = record();
    const panel = panelWith({ approvedMessage: template });
    const { lookup, asked } = spied(lookupFor(appeal, panel));

    expect(decisionMessage(appeal, panel, lookup, SAMPLE_NOW)).toBe(`${HEADING}By . You said .`);

    const onPage = renderAppealDecision(template, lookup, 'plain_text', SAMPLE_NOW);

    expect(onPage.output).toBe('By . You said .');
    expect(onPage.diagnostics.map(({ code }) => code)).toEqual(['restricted', 'restricted']);
    expect(asked).toEqual([]);
    expect(page(appeal, { approvedMessage: template })).toBe('By . You said .');
  });

  test('the moderator’s id never reaches the direct message, though the row holds it', () => {
    const text = dm(record(), panelWith({ approvedMessage: 'Decided by {appeal.decided_by}.' }));

    expect(text).toBe(`${HEADING}Decided by .`);
    expect(text).not.toContain(MODERATOR);
  });

  test('the facts are built without the answers or the moderator', () => {
    const facts = appealDecisionFacts(record(), panelWith({ rejoinUrl: REJOIN }));

    expect(facts).toStrictEqual({
      appeal: { number: 12, status: 'approved', filedAt: FILED_AT, decidedAt: SAMPLE_NOW },
      panel: { name: 'Ban appeal', rejoinUrl: REJOIN },
    });
    expect(appealDecisionFacts(record(), panelWith()).panel).toStrictEqual({ name: 'Ban appeal' });
    expect(appealDecisionFacts(record({ status: 'open' }), panelWith()).appeal.status).toBe(
      'denied',
    );

    const shape: Record<keyof AppealDecisionFacts['appeal'], true> = {
      number: true,
      status: true,
      filedAt: true,
      decidedAt: true,
    };

    expect(Object.keys(facts.appeal).sort()).toEqual(Object.keys(shape).sort());
  });

  test('no picker offers them', () => {
    const offered = APPEAL_DECISION_SURFACE.pickerFor(APPROVED_PATH).map(({ key }) => key);

    expect(offered).toEqual([
      'appeal.number',
      'appeal.status',
      'appeal.form_name',
      'appeal.filed_at',
      'appeal.decided_at',
      'appeal.rejoin_url',
      'now',
      'today',
      'year',
    ]);
    expect(
      APPEAL_DECISION_SURFACE.pickerFor('panels.4.deniedMessage').map(({ key }) => key),
    ).toEqual(offered);
    expect(APPEAL_DECISION_SURFACE.pickerFor('panels.0.blurb')).toEqual([]);
  });
});

describe('names this surface does not offer', () => {
  test('post as written in both places, and never block a save', () => {
    const template = 'From {server.name}: {user} {user.mention} {bot.name} {nope}.';
    const report = validateConfigTemplates(
      appealsTemplates,
      configWith({ approvedMessage: template }),
      configWith(),
    );

    expect(dm(record(), panelWith({ approvedMessage: template }))).toBe(`${HEADING}${template}`);
    expect(page(record(), { approvedMessage: template })).toBe(template);
    expect(report.blocking).toEqual([]);
    expect(codesAt(report, APPROVED_PATH)).toEqual(Array(5).fill('unknown_placeholder'));
  });

  test('a near miss suggests the name it was meant to be', () => {
    const report = validateConfigTemplates(
      appealsTemplates,
      configWith({ approvedMessage: '{appeal.numbr}' }),
      configWith(),
    );

    expect(report.byPath.get(APPROVED_PATH)?.[0]?.message).toContain(
      'Did you mean {appeal.number}?',
    );
  });
});

describe('prototype names', () => {
  const PROTOTYPE =
    '{constructor} {__proto__} {prototype} {appeal.constructor} {appeal.__proto__} ' +
    '{appeal.answer.__proto__} {appeal.answer.constructor} {toString}';

  test('post as written in both places, are never looked up, and do not throw', () => {
    const appeal = record();
    const panel = panelWith({ approvedMessage: PROTOTYPE });
    const { lookup, asked } = spied(lookupFor(appeal, panel));

    expect(decisionMessage(appeal, panel, lookup, SAMPLE_NOW)).toBe(`${HEADING}${PROTOTYPE}`);
    expect(renderAppealDecision(PROTOTYPE, lookup, 'plain_text', SAMPLE_NOW).output).toBe(
      PROTOTYPE,
    );
    expect(page(appeal, { approvedMessage: PROTOTYPE })).toBe(PROTOTYPE);
    expect(asked).toEqual([]);

    const report = validateConfigTemplates(
      appealsTemplates,
      configWith({ approvedMessage: PROTOTYPE }),
    );

    expect(report.blocking).toEqual([]);
    expect(codesAt(report, APPROVED_PATH)).toContain('forbidden_key');
  });

  test('a stored config with __proto__ keys is read by its own keys and pollutes nothing', () => {
    const hostile: unknown = JSON.parse(
      '{"enabled":true,"__proto__":{"panels":[{"approvedMessage":"{appeal.decided_by}"}]},' +
        '"panels":[{"approvedMessage":"{appeal.number}","__proto__":{"deniedMessage":"{appeal.decided_by}"}}]}',
    );

    expect(appealsTemplates.collect(hostile).map(({ path, text }) => [path, text])).toEqual([
      [APPROVED_PATH, '{appeal.number}'],
    ]);
    expect(validateConfigTemplates(appealsTemplates, hostile).blocking).toEqual([]);
    expect(({} as Record<string, unknown>).panels).toBeUndefined();
    expect(({} as Record<string, unknown>).deniedMessage).toBeUndefined();
  });
});

describe('a form name is a value, never a template', () => {
  const HOSTILE = '{appeal.number} <@&100000000000000020> **x** @everyone';
  const approvedMessage = 'Your {appeal.form_name} was accepted.';

  test('in the direct message it is escaped, never expanded, and cannot ping', () => {
    const verdict = dm(record(), panelWith({ name: HOSTILE, approvedMessage })).slice(
      HEADING.length,
    );

    expect(verdict).toBe(
      `Your {appeal.number} \\<@&100000000000000020\\> \\*\\*x\\*\\* @${ZERO_WIDTH_SPACE}everyone was accepted.`,
    );
    expect(verdict).not.toMatch(/(^|[^\\])<@&/);
  });

  test('on the page it is shown as written, and never expanded', () => {
    expect(page(record(), { name: HOSTILE, approvedMessage })).toBe(
      `Your ${HOSTILE} was accepted.`,
    );
  });
});

describe('braces and mass mentions', () => {
  test('an @everyone the server wrote posts as before; one inside a form name is broken', () => {
    const overrides = {
      name: '@everyone',
      approvedMessage: '@everyone, {appeal.form_name} #{appeal.number} was accepted.',
    };

    expect(dm(record(), panelWith(overrides))).toBe(
      `${HEADING}@everyone, @${ZERO_WIDTH_SPACE}everyone #12 was accepted.`,
    );
    expect(page(record(), overrides)).toBe('@everyone, @everyone #12 was accepted.');
  });

  test('doubled braces now write a single brace, and the editor says so when they are new', () => {
    const approvedMessage = 'Use {{appeal.number}} for #{appeal.number}.';
    const report = validateConfigTemplates(
      appealsTemplates,
      configWith({ approvedMessage }),
      configWith(),
    );

    expect(dm(record(), panelWith({ approvedMessage }))).toBe(
      `${HEADING}Use {appeal.number} for #12.`,
    );
    expect(page(record(), { approvedMessage })).toBe('Use {appeal.number} for #12.');
    expect(codesAt(report, APPROVED_PATH)).toContain('doubled_brace_literal');
    expect(report.blocking).toEqual([]);
  });
});

describe('limits', () => {
  test('the direct message never passes 2000, and ends on a whole emoji', () => {
    const appeal = record();
    const panel = panelWith({ approvedMessage: FAMILY.repeat(2000 / FAMILY.length) });
    const whole = Math.floor((2000 - HEADING.length) / FAMILY.length);
    const text = dm(appeal, panel);

    expect(text).toBe(`${HEADING}${FAMILY.repeat(whole)}`);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(legacyDm(appeal, panel)).toHaveLength(2000);
    expect(legacyDm(appeal, panel)).not.toBe(text);
  });

  test('a mention the cut would halve is dropped whole', () => {
    const mention = `<@${MEMBER}>`;
    const lead = 'x'.repeat(2000 - mention.length - 5);

    expect(dm(record(), panelWith({ approvedMessage: `${lead}${mention}` }))).toBe(
      `${HEADING}${lead}`,
    );
  });

  test('placeholders that grow the text are cut at 6000 on the page and at 2000 in the DM', () => {
    const overrides = { name: 'n'.repeat(80), approvedMessage: '{appeal.form_name}'.repeat(100) };
    const appeal = record();
    const panel = panelWith(overrides);
    const rendered = renderAppealDecision(
      overrides.approvedMessage,
      lookupFor(appeal, panel),
      'plain_text',
      SAMPLE_NOW,
    );

    expect(page(appeal, overrides)).toBe('n'.repeat(PLACEHOLDER_LIMITS.outputLength));
    expect(rendered.diagnostics.map(({ code }) => code)).toContain('output_truncated');
    expect(dm(appeal, panel)).toBe(`${HEADING}${'n'.repeat(2000 - HEADING.length)}`);
  });

  test('100 placeholders save, and the 101st is refused', () => {
    const at = (count: number) =>
      validateConfigTemplates(
        appealsTemplates,
        configWith({ approvedMessage: '{year}'.repeat(count) }),
        configWith(),
      );

    expect(at(PLACEHOLDER_LIMITS.placeholders).blocking).toEqual([]);

    const refused = at(PLACEHOLDER_LIMITS.placeholders + 1).blocking;

    expect(refused.map(({ diagnostic }) => diagnostic.code)).toContain('too_many_placeholders');
    expect(new Set(refused.map(({ path }) => path))).toEqual(new Set([APPROVED_PATH]));
  });
});

describe('the surface', () => {
  test('is the decision sent to the member who appealed', () => {
    expect(APPEAL_DECISION_SURFACE).toMatchObject({
      id: 'appeals.decision',
      module: 'appeals',
      event: APPEAL_DECISION_EVENT,
      audience: 'member_private',
    });
    expect(
      APPEAL_DECISION_SURFACE.fields.map(({ path, kind, label, limit }) => [
        path,
        kind,
        label,
        limit,
      ]),
    ).toEqual([
      ['panels.*.approvedMessage', 'discord_text', 'Accepted message', 2000],
      ['panels.*.deniedMessage', 'discord_text', 'Turned-down message', 2000],
    ]);
    expect(APPEAL_DECISION_SURFACE.pings).toEqual({});
  });

  test('registers no member, server or bot names and no aliases, and keeps two for staff', () => {
    const { definitions } = APPEAL_DECISION_SURFACE;

    expect(definitions.map(({ key }) => key)).toEqual([
      'appeal.number',
      'appeal.status',
      'appeal.form_name',
      'appeal.filed_at',
      'appeal.decided_at',
      'appeal.rejoin_url',
      'appeal.decided_by',
      'appeal.answer.<key>',
      'now',
      'today',
      'year',
    ]);
    expect(definitions.flatMap(({ aliases }) => aliases)).toEqual([]);
    expect(
      definitions
        .filter(({ sensitivity }) => sensitivity !== 'public')
        .map(({ key, sensitivity }) => [key, sensitivity]),
    ).toEqual([
      ['appeal.decided_by', 'staff_only'],
      ['appeal.answer.<key>', 'staff_only'],
    ]);
  });

  test('the manifest carries its templates', () => {
    expect(appealsModule.templates).toBe(appealsTemplates);
    expect(Object.keys(appealsTemplates.surfaces)).toEqual(['appeals.decision']);
  });

  test('collect finds both messages on every form, and never throws on garbage', () => {
    const config = appealsConfigSchema.parse({
      enabled: true,
      panels: [
        { id: 'ban', name: 'Ban appeal', questions: [{ key: 'why', label: 'Why?' }] },
        {
          id: 'mute',
          name: 'Mute appeal',
          questions: [{ key: 'why', label: 'Why?' }],
          approvedMessage: 'Unmuted.',
        },
      ],
    });

    expect(
      appealsTemplates.collect(config).map(({ path, surfaceId, text }) => [path, surfaceId, text]),
    ).toEqual([
      ['panels.0.approvedMessage', 'appeals.decision', ACCEPTED],
      ['panels.1.approvedMessage', 'appeals.decision', 'Unmuted.'],
      ['panels.0.deniedMessage', 'appeals.decision', TURNED_DOWN],
      ['panels.1.deniedMessage', 'appeals.decision', TURNED_DOWN],
    ]);

    for (const garbage of [
      null,
      undefined,
      'panels',
      42,
      [],
      { panels: 'x' },
      { panels: [null, 7, 'x', { approvedMessage: 5, deniedMessage: {} }] },
    ]) {
      expect(appealsTemplates.collect(garbage)).toEqual([]);
    }
  });

  test('the shipped messages validate with nothing to say', () => {
    const report = validateConfigTemplates(appealsTemplates, configWith());

    expect(report.blocking).toEqual([]);
    expect([...report.byPath.values()].flat()).toEqual([]);
  });

  test('a stored message that no longer validates still parses, renders as the engine does, and blocks no toggle', () => {
    const approvedMessage = 'Hi {appeal.number:shout} {appeal.decided_by}';
    const before = configWith({ approvedMessage });
    const toggled = validateConfigTemplates(
      appealsTemplates,
      { ...before, enabled: false },
      before,
    );

    expect(toggled.blocking).toEqual([]);
    expect(codesAt(toggled, APPROVED_PATH)).toEqual(
      expect.arrayContaining(['unknown_modifier', 'restricted']),
    );
    expect(validateConfigTemplates(appealsTemplates, before, configWith()).blocking).not.toEqual(
      [],
    );

    const [panel] = before.panels;
    if (panel === undefined) throw new Error('the form did not parse');

    const appeal = record();
    const lookup = lookupFor(appeal, panel);
    const engine = renderTemplate(approvedMessage, lookup, {
      registry: APPEAL_DECISION_SURFACE.registry,
      field: 'discord_text',
      event: APPEAL_DECISION_EVENT,
      audience: 'member_private',
      now: SAMPLE_NOW,
    }).output;

    expect(decisionMessage(appeal, panel, lookup, SAMPLE_NOW)).toBe(`${HEADING}${engine}`);
  });

  test('the sample fills in every key the picker offers', () => {
    const [sample] = APPEAL_DECISION_SURFACE.samples;
    if (sample === undefined) throw new Error('the surface has no sample');

    const lookup = APPEAL_DECISION_SURFACE.build(sample.facts, { now: SAMPLE_NOW });

    for (const { key } of APPEAL_DECISION_SURFACE.pickerFor(APPROVED_PATH)) {
      const rendered = renderAppealDecision(`{${key}}`, lookup, 'discord_text', SAMPLE_NOW);

      expect(`${key}: ${rendered.diagnostics.map(({ code }) => code).join(',')}`).toBe(`${key}: `);
      expect(rendered.output).not.toBe('');
    }

    expect(
      renderAppealDecision(
        '#{appeal.number} {appeal.form_name} {appeal.status}',
        lookup,
        'plain_text',
        SAMPLE_NOW,
      ).output,
    ).toBe('#7 Ban appeal approved');
    expect(sample.label).toBe('Sample: appeal #7 on the Ban appeal form, accepted');
  });
});

class RecordingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);

    return request.kind === 'create_dm'
      ? { status: 'executed', body: { id: DM_CHANNEL } }
      : { status: 'executed' };
  }
}

function dmStore(): { store: AppealStore; remembered: string[] } {
  const remembered: string[] = [];
  let attempts = 0;
  const unused = async (): Promise<never> => {
    throw new Error('the direct message does not read this');
  };

  return {
    remembered,
    store: {
      file: unused,
      find: unused,
      findByLink: unused,
      lastDecidedAt: unused,
      decide: unused,
      markApplied: unused,
      rememberCard: unused,
      rememberDm: async (_guildId, _appealId, channelId) => {
        remembered.push(channelId);
      },
      noteDmAttempt: async () => {
        attempts += 1;
        return attempts;
      },
    },
  };
}

function contextFor(executor: ActionExecutor, config: AppealsConfig): ModuleContext<AppealsConfig> {
  const quiet = (): void => undefined;

  return { guildId: GUILD, config, executor, logger: { info: quiet, warn: quiet, error: quiet } };
}

describe('the direct message is sent as before', () => {
  test('opens the DM, then sends the filled-in decision under the same keys, pinging nobody', async () => {
    const executor = new RecordingExecutor();
    const { store, remembered } = dmStore();
    const config = configWith({
      approvedMessage: 'Appeal #{appeal.number} on {appeal.form_name} was accepted in {year}.',
      rejoinUrl: REJOIN,
    });
    const [panel] = config.panels;
    if (panel === undefined) throw new Error('the form did not parse');

    const outcome = await tellAppellant(
      contextFor(executor, config),
      store,
      record({ dmChannelId: null }),
      panel,
      SAMPLE_NOW,
    );

    expect(outcome).toBe('sent');
    expect(remembered).toEqual([DM_CHANNEL]);
    expect(executor.requests.map(({ kind, idempotencyKey }) => [kind, idempotencyKey])).toEqual([
      ['create_dm', 'appeals:appeal-1:dm-open:1'],
      ['send', 'appeals:appeal-1:dm-send:approved'],
    ]);
    expect(executor.requests[1]?.payload).toEqual({
      channelId: DM_CHANNEL,
      content: `${HEADING}Appeal #12 on Ban appeal was accepted in 2026.\n\n${REJOIN}`,
      allowedMentions: { parse: [] },
    });
  });

  test('a DM already open is reused, and the shipped message goes out unchanged', async () => {
    const executor = new RecordingExecutor();
    const { store } = dmStore();
    const config = configWith();
    const [panel] = config.panels;
    if (panel === undefined) throw new Error('the form did not parse');

    await tellAppellant(contextFor(executor, config), store, record({ status: 'denied' }), panel);

    expect(executor.requests.map(({ kind, idempotencyKey }) => [kind, idempotencyKey])).toEqual([
      ['send', 'appeals:appeal-1:dm-send:denied'],
    ]);
    expect(executor.requests[0]?.payload).toEqual({
      channelId: DM_CHANNEL,
      content: `${HEADING}${TURNED_DOWN}`,
      allowedMentions: { parse: [] },
    });
  });
});
