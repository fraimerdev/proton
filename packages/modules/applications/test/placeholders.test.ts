import { describe, expect, test } from 'bun:test';
import {
  renderTemplate,
  SAMPLE_MEMBER,
  SAMPLE_NOW,
  SAMPLE_SERVER,
  type TemplateReport,
  validateConfigTemplates,
} from '@proton/core/placeholders';
import type { z } from 'zod';
import {
  APPLICANT_MESSAGE_KEYS,
  type ApplicantMessage,
  type ApplicantMessageKey,
  applicationsConfigSchema,
  type formSchema,
  MESSAGE_DEFAULTS,
} from '../src/config.ts';
import {
  APPLICANT_SURFACES,
  type ApplicantMessageFacts,
  applicationsTemplates,
  CLOSED_SURFACE,
  DECISION_SURFACE,
  INFO_REQUEST_SURFACE,
  RECEIPT_SURFACE,
  renderApplicantMessage,
  renderClosedMessage,
  WITHDRAWN_SURFACE,
} from '../src/placeholders.ts';

const STAFF_ONLY = ['application.internal_note', 'application.votes', 'application.score'];
const EM_DASH = '—';

type FormInput = z.input<typeof formSchema>;

function configWith(overrides: Partial<FormInput> = {}) {
  return applicationsConfigSchema.parse({
    enabled: true,
    forms: [{ id: 'mods', name: 'Moderator Application', ...overrides }],
  });
}

const DEFAULTS = configWith();

function codesAt(report: TemplateReport, path: string): string[] {
  return report.byPath.get(path)?.map(({ code }) => code) ?? [];
}

function blockingCodes(report: TemplateReport): [string, string][] {
  return report.blocking.map(({ path, diagnostic }) => [path, diagnostic.code]);
}

function content(text: string): Partial<FormInput> {
  return {
    messages: Object.fromEntries(
      APPLICANT_MESSAGE_KEYS.map((key) => [key, { content: text }]),
    ) as FormInput['messages'],
  };
}

function facts(surface: typeof RECEIPT_SURFACE): ApplicantMessageFacts {
  const sample = surface.samples[0]?.facts;
  if (sample === undefined) throw new Error(`${surface.id} has no sample`);
  return sample;
}

function render(key: ApplicantMessageKey, message: ApplicantMessage, overrides = {}) {
  const surface = APPLICANT_SURFACES[key];
  const base = facts(surface);
  return renderApplicantMessage(
    surface,
    message,
    { ...base, application: { ...base.application, ...overrides } },
    { now: SAMPLE_NOW },
  );
}

describe('the surfaces', () => {
  test('there is one per occasion, all private to the applicant', () => {
    expect(Object.keys(applicationsTemplates.surfaces).sort()).toEqual([
      'applications.closed',
      'applications.decision',
      'applications.info_request',
      'applications.receipt',
      'applications.withdrawn',
    ]);

    for (const surface of Object.values(applicationsTemplates.surfaces)) {
      expect(surface.module).toBe('applications');
      expect(surface.audience).toBe('member_private');
      expect(surface.event).toBe(surface.id);
      expect(surface.samples.map((sample) => sample.id)).toEqual(['member']);
    }
  });

  test('each message key is rooted under its form and renders on the right surface', () => {
    const sites = applicationsTemplates.collect(DEFAULTS);
    const surfaceAt = (path: string) => sites.find((site) => site.path === path)?.surfaceId;

    expect(surfaceAt('forms.0.messages.receipt.embeds.0.description')).toBe('applications.receipt');
    expect(surfaceAt('forms.0.messages.accepted.embeds.0.description')).toBe(
      'applications.decision',
    );
    expect(surfaceAt('forms.0.messages.rejected.embeds.0.title')).toBe('applications.decision');
    expect(surfaceAt('forms.0.messages.waitlisted.embeds.0.footer.text')).toBe(
      'applications.decision',
    );
    expect(surfaceAt('forms.0.messages.infoRequest.embeds.0.description')).toBe(
      'applications.info_request',
    );
    expect(surfaceAt('forms.0.messages.withdrawn.embeds.0.url')).toBe('applications.withdrawn');
    expect(surfaceAt('forms.0.messages.closed')).toBe('applications.closed');
    expect(RECEIPT_SURFACE.fieldAt('forms.3.messages.receipt.content')?.kind).toBe('discord_text');
    expect(CLOSED_SURFACE.fieldAt('forms.3.messages.closed')?.kind).toBe('discord_text');
  });

  test('the default messages validate with no errors and no unknown keys', () => {
    const report = validateConfigTemplates(applicationsTemplates, DEFAULTS);
    const problems = [...report.byPath.entries()].flatMap(([path, diagnostics]) =>
      diagnostics
        .filter(({ severity, code }) => severity === 'error' || code === 'unknown_placeholder')
        .map(({ code }) => `${path}: ${code}`),
    );

    expect(report.blocking).toEqual([]);
    expect(problems).toEqual([]);
  });
});

describe('staff-only facts never reach an applicant', () => {
  test('internal notes, votes and scores are refused on every applicant message', () => {
    for (const key of STAFF_ONLY) {
      const report = validateConfigTemplates(
        applicationsTemplates,
        configWith({ messages: { ...content(`Note: {${key}}`).messages, closed: `{${key}}` } }),
        DEFAULTS,
      );

      const paths = [
        ...APPLICANT_MESSAGE_KEYS.map((message) => `forms.0.messages.${message}.content`),
        'forms.0.messages.closed',
      ];
      for (const path of paths) {
        expect([key, path, codesAt(report, path)]).toEqual([key, path, ['restricted']]);
      }
      expect(blockingCodes(report)).toHaveLength(paths.length);
    }
  });

  test('a restricted key that reaches a render comes out empty', () => {
    const rendered = render('accepted', {
      ...MESSAGE_DEFAULTS.accepted,
      content: 'Votes: {application.votes}. Note: {application.internal_note}.',
    });
    if (!rendered.ok) throw new Error(rendered.humanReason);

    expect(rendered.message.content).toBe('Votes: . Note: .');
    expect(rendered.diagnostics.map(({ code }) => code)).toContain('restricted');
  });

  test('the closed message refuses them as well', () => {
    const result = renderClosedMessage(
      'Closed {application.internal_note}',
      { formName: 'Moderator Application', server: SAMPLE_SERVER },
      { now: SAMPLE_NOW, field: 'plain_text' },
    );
    expect(result.output).toBe('Closed ');
    expect(result.diagnostics.map(({ code }) => code)).toContain('restricted');
  });
});

describe('only the facts an occasion has are offered', () => {
  function report(key: ApplicantMessageKey, text: string): TemplateReport {
    return validateConfigTemplates(
      applicationsTemplates,
      configWith({ messages: { [key]: { content: text } } }),
      DEFAULTS,
    );
  }

  test('the reason and decision time exist only on decisions', () => {
    for (const key of ['receipt', 'infoRequest', 'withdrawn'] as const) {
      for (const placeholder of ['application.reason', 'application.reviewed_at']) {
        expect(codesAt(report(key, `{${placeholder}}`), `forms.0.messages.${key}.content`)).toEqual(
          ['unavailable'],
        );
      }
    }
    for (const key of ['accepted', 'rejected', 'waitlisted'] as const) {
      expect(report(key, '{application.reason} {application.reviewed_at}').blocking).toEqual([]);
    }
  });

  test('the staff question exists only on the information request', () => {
    expect(report('infoRequest', '{application.request}').blocking).toEqual([]);
    expect(
      codesAt(report('accepted', '{application.request}'), 'forms.0.messages.accepted.content'),
    ).toEqual(['unavailable']);
  });

  test('the deciding reviewer is offered on decisions only', () => {
    expect(report('accepted', '{moderator.username}').blocking).toEqual([]);
    expect(
      codesAt(report('receipt', '{moderator.username}'), 'forms.0.messages.receipt.content'),
    ).toEqual(['unknown_placeholder']);
  });

  test('the closed message knows the form and server but no application', () => {
    const closed = (text: string) =>
      validateConfigTemplates(
        applicationsTemplates,
        configWith({ messages: { closed: text } }),
        DEFAULTS,
      );

    expect(closed('{application.name} at {server.name}').blocking).toEqual([]);
    expect(codesAt(closed('{application.id}'), 'forms.0.messages.closed')).toEqual(['unavailable']);
    expect(codesAt(closed('{user.mention}'), 'forms.0.messages.closed')).toEqual([
      'unknown_placeholder',
    ]);
  });

  test('stored text that was already there never blocks a save', () => {
    const stored = configWith(content('{application.internal_note}'));
    const report = validateConfigTemplates(
      applicationsTemplates,
      { ...stored, reviewReminderHours: 12 },
      stored,
    );
    expect(report.blocking).toEqual([]);
  });
});

describe('rendering the default messages', () => {
  test('the receipt names the form, server and reference, and links the status page', () => {
    const rendered = render('receipt', MESSAGE_DEFAULTS.receipt);
    if (!rendered.ok) throw new Error(rendered.humanReason);

    const [embed] = rendered.message.embeds;
    expect(embed?.title).toBe('Application sent');
    expect(embed?.description).toContain('**Moderator Application**');
    expect(embed?.description).toContain('**Proton HQ**');
    expect(embed?.description).toContain('#12');
    expect(embed?.footer?.text).toBe('Reference #12');
    expect(embed?.url).toBe(facts(RECEIPT_SURFACE).application.url ?? '');
    expect(rendered.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
  });

  test('every default renders cleanly from its sample, with nothing left unfilled', () => {
    for (const key of APPLICANT_MESSAGE_KEYS) {
      const rendered = render(key, MESSAGE_DEFAULTS[key]);
      if (!rendered.ok) throw new Error(`${key}: ${rendered.humanReason}`);

      const text = JSON.stringify(rendered.message);
      expect([key, text.includes('{application.')]).toEqual([key, false]);
      expect(text).not.toContain(EM_DASH);
      expect(rendered.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    }
  });

  test('a decision without a reason still reads well', () => {
    const rendered = render('rejected', MESSAGE_DEFAULTS.rejected, { reason: null });
    if (!rendered.ok) throw new Error(rendered.humanReason);

    const description = rendered.message.embeds[0]?.description ?? '';
    expect(description).toContain('wasn’t accepted this time');
    expect(description).not.toContain('null');
  });

  test('the decision carries the reason the reviewer wrote', () => {
    const rendered = render('accepted', MESSAGE_DEFAULTS.accepted, {
      reason: 'Welcome aboard.',
    });
    if (!rendered.ok) throw new Error(rendered.humanReason);
    expect(rendered.message.embeds[0]?.description).toContain('Welcome aboard.');
  });

  test('the information request quotes what staff asked', () => {
    const rendered = render('infoRequest', MESSAGE_DEFAULTS.infoRequest, {
      request: 'Which time zone are you in?',
    });
    if (!rendered.ok) throw new Error(rendered.humanReason);
    expect(rendered.message.embeds[0]?.description).toContain('Which time zone are you in?');
  });

  test('without a status page the title simply is not a link', () => {
    const rendered = render('withdrawn', MESSAGE_DEFAULTS.withdrawn, { url: null });
    if (!rendered.ok) throw new Error(rendered.humanReason);
    expect(rendered.message.embeds[0]?.url).toBeUndefined();
  });

  test('applicant text is escaped, not formatted', () => {
    const rendered = render('accepted', MESSAGE_DEFAULTS.accepted, {
      formName: '**Loud** form',
      reason: '@everyone look',
    });
    if (!rendered.ok) throw new Error(rendered.humanReason);

    const description = rendered.message.embeds[0]?.description ?? '';
    expect(description).not.toContain('****Loud**');
    expect(description).not.toContain('@everyone look');
  });

  test('the applicant and the reviewer render as themselves', () => {
    const rendered = render('accepted', {
      ...MESSAGE_DEFAULTS.accepted,
      content: '{user.mention} accepted by {moderator.username}',
    });
    if (!rendered.ok) throw new Error(rendered.humanReason);
    expect(rendered.message.content).toBe(`<@${SAMPLE_MEMBER.user.id}> accepted by kestrel`);
  });
});

describe('every offered key resolves from the samples', () => {
  const cases = [
    [RECEIPT_SURFACE, 'forms.0.messages.receipt.embeds.0.description'],
    [DECISION_SURFACE, 'forms.0.messages.accepted.embeds.0.description'],
    [INFO_REQUEST_SURFACE, 'forms.0.messages.infoRequest.embeds.0.description'],
    [WITHDRAWN_SURFACE, 'forms.0.messages.withdrawn.embeds.0.description'],
  ] as const;

  for (const [surface, path] of cases) {
    test(surface.id, () => {
      const offered = surface.pickerFor(path);
      const keys = offered.map((definition) => definition.key);

      expect(keys).toContain('application.id');
      expect(keys).toContain('server.name');
      expect(keys).toContain('user.mention');
      for (const key of STAFF_ONLY) expect(keys).not.toContain(key);

      const lookup = surface.build(facts(surface), { now: SAMPLE_NOW });
      for (const key of keys) {
        const result = renderTemplate(`{${key}}`, lookup, {
          registry: surface.registry,
          field: 'discord_text',
          event: surface.event,
          audience: surface.audience,
          now: SAMPLE_NOW,
        });
        const failed = result.diagnostics.filter(
          ({ code }) => code === 'resolver_failed' || code === 'unavailable',
        );
        expect([key, failed]).toEqual([key, []]);
      }
    });
  }

  test('the closed surface offers the form and server only', () => {
    const keys = CLOSED_SURFACE.pickerFor('forms.0.messages.closed').map(
      (definition) => definition.key,
    );
    expect(keys).toContain('application.name');
    expect(keys).toContain('server.name');
    expect(keys).not.toContain('application.id');
    expect(keys).not.toContain('user.mention');
  });

  test('a closed message renders the form name', () => {
    expect(
      renderClosedMessage(
        '{application.name} opens again soon at {server.name}.',
        { formName: 'Moderator Application', server: SAMPLE_SERVER },
        { now: SAMPLE_NOW, field: 'plain_text' },
      ).output,
    ).toBe('Moderator Application opens again soon at Proton HQ.');
  });
});
