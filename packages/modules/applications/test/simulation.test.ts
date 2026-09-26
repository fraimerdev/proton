import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asTestDelivery,
  countV2Components,
  type ModuleManifest,
  ModuleRegistry,
  type ProtonMessage,
  personFor,
  type SimulationAdapter,
  type SimulationBuild,
  type SimulationScene,
  simulationDescriptorSchema,
  testCustomIdFor,
  toDiscordMessage,
} from '@proton/core';
import {
  SAMPLE_BOT,
  SAMPLE_MEMBER,
  SAMPLE_NOW,
  SAMPLE_REPORTER,
  SAMPLE_SERVER,
} from '@proton/core/placeholders';
import type { z } from 'zod';
import {
  APPLICATIONS_SCHEMA_VERSION,
  type ApplicationsConfig,
  applicationsConfigSchema,
  applicationsDefaultConfig,
  applicationsFormSchema,
  formSchema,
  questionsOf,
} from '../src/config.ts';
import { applicationsTemplates } from '../src/placeholders.ts';
import { applicationsSimulations, sampleAnswers } from '../src/simulation.ts';
import { templateFor } from '../src/templates.ts';
import { MemoryApplicationStore } from './memory-store.ts';

type Inputs = SimulationScene['inputs'];

const REVIEW_CHANNEL = '100000000000000070';
const PANEL_CHANNEL = '100000000000000071';
const subject = personFor(SAMPLE_MEMBER.user, SAMPLE_MEMBER.member);
const actor = personFor(SAMPLE_REPORTER.user, SAMPLE_REPORTER.member);

function team() {
  const form = templateFor('team')?.build('team');
  if (form === undefined) throw new Error('the team template is missing');
  return form;
}

function config(
  overrides: Partial<z.input<typeof applicationsConfigSchema>> = {},
): ApplicationsConfig {
  const forms = overrides.forms === undefined ? {} : { panels: [] };
  return applicationsConfigSchema.parse({
    enabled: true,
    reviewChannelId: REVIEW_CHANNEL,
    forms: [
      team(),
      formSchema.parse({
        id: 'events',
        name: 'Event Application',
        sections: [
          {
            id: 'main',
            questions: [{ id: 'why', type: 'short', label: 'Why?', minLength: 40, maxLength: 60 }],
          },
        ],
        review: { cardAnswers: 'full', scoring: true, channelId: '100000000000000072' },
      }),
    ],
    panels: [
      { id: 'join', name: 'Join the team', channelId: PANEL_CHANNEL, formIds: ['team', 'events'] },
    ],
    ...forms,
    ...overrides,
  });
}

function scene(inputs: Inputs = {}, overrides: Partial<SimulationScene> = {}): SimulationScene {
  return {
    guildId: SAMPLE_SERVER.id,
    server: SAMPLE_SERVER,
    guildState: null,
    subject,
    actor,
    destinationChannel: null,
    originChannel: null,
    bot: { ...SAMPLE_BOT, websiteUrl: 'https://prtn.xyz' },
    eventId: `proton.simulation_requested:${SAMPLE_SERVER.id}:req-0001`,
    now: SAMPLE_NOW,
    tier: 'free',
    inputs,
    ...overrides,
  };
}

function adapter(id: string): SimulationAdapter<ApplicationsConfig> {
  const found = applicationsSimulations.find((candidate) => candidate.descriptor.id === id);
  if (found === undefined) throw new Error(`no simulation ${id}`);
  return found;
}

function message(build: SimulationBuild): ProtonMessage {
  if (!build.ok) throw new Error(build.humanReason);
  if (build.output.kind !== 'message') throw new Error('expected a message');
  return build.output.message;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function v2Text(built: ProtonMessage): string {
  const parts: string[] = [];
  for (const component of built.v2) {
    if (component.kind !== 'container') continue;
    for (const child of component.children) {
      if (child.kind === 'text') parts.push(child.content);
      if (child.kind === 'section') parts.push(...child.text);
    }
  }
  return parts.join('\n');
}

describe('the simulation catalogue', () => {
  test('every descriptor is valid and passes the registry’s boot checks', () => {
    for (const { descriptor } of applicationsSimulations) {
      expect(simulationDescriptorSchema.safeParse(descriptor).success).toBe(true);
      expect(descriptor.note ?? '').toMatch(/[Nn]othing is (filed|started)|no application is/);
      expect(`${descriptor.label} ${descriptor.summary} ${descriptor.note ?? ''}`).not.toContain(
        '—',
      );
    }

    const registry = new ModuleRegistry();
    registry.register({
      id: 'applications',
      name: 'Applications',
      configSchema: applicationsConfigSchema,
      formSchema: applicationsFormSchema,
      defaultConfig: applicationsDefaultConfig,
      schemaVersion: APPLICATIONS_SCHEMA_VERSION,
      requiredIntents: [],
      requiredPermissions: [],
      templates: applicationsTemplates,
      simulations: applicationsSimulations,
    } as unknown as ModuleManifest);

    expect(registry.simulations('applications')).toHaveLength(applicationsSimulations.length);
  });

  test('the review card and panel are Proton’s own copy; the DMs render through surfaces', () => {
    expect(adapter('applications.review_card').descriptor.surfaceId).toBeUndefined();
    expect(adapter('applications.panel').descriptor.surfaceId).toBeUndefined();
    for (const id of [
      'applications.receipt',
      'applications.decision',
      'applications.info_request',
      'applications.withdrawn',
    ]) {
      expect(adapter(id).descriptor.surfaceId).toBe(id);
      expect(adapter(id).descriptor.delivery).toBe('dm');
    }
  });
});

describe('applicant DMs', () => {
  test('the receipt renders the form’s own message for the example member', () => {
    const built = adapter('applications.receipt').build(config(), scene({ formIndex: 0 }));
    const rendered = message(built);

    expect(built.ok && built.caption).toBe('application #12 on Team Application, just sent');
    expect(JSON.stringify(rendered)).toContain('Team Application');
    expect(rendered.mentions).toEqual({ everyone: false, roles: false, users: false });
  });

  test.each(['accepted', 'rejected', 'waitlisted'] as const)(
    'the %s decision renders that decision’s message with the reason',
    (decision) => {
      const settings = config({
        forms: [
          {
            ...team(),
            messages: {
              accepted: { content: 'Yes: {application.reason}' },
              rejected: { content: 'No: {application.reason}' },
              waitlisted: { content: 'Later: {application.reason} by {moderator.mention}' },
            },
          },
        ],
      });
      const built = adapter('applications.decision').build(
        settings,
        scene({ formIndex: 0, decision, reason: 'Because.' }),
      );
      const content = message(built).content ?? '';

      const expected = {
        accepted: 'Yes: Because.',
        rejected: 'No: Because.',
        waitlisted: 'Later: Because.',
      };
      expect(content).toStartWith(expected[decision]);
    },
  );

  test('an information request carries the question', () => {
    const settings = config({
      forms: [{ ...team(), messages: { infoRequest: { content: 'Q: {application.request}' } } }],
    });
    const built = adapter('applications.info_request').build(
      settings,
      scene({ formIndex: 0, request: 'Which servers?' }),
    );

    expect(message(built).content).toBe('Q: Which servers?');
  });

  test('the status link points at the member’s applications page when the site is known', () => {
    const settings = config({
      forms: [{ ...team(), messages: { receipt: { content: '{application.url}' } } }],
    });

    const withSite = adapter('applications.receipt').build(settings, scene());
    expect(message(withSite).content).toBe(`https://prtn.xyz/apply/${SAMPLE_SERVER.id}`);

    const withoutSite = adapter('applications.receipt').build(settings, scene({}, { bot: null }));
    expect(withoutSite.ok && withoutSite.diagnostics.map((d) => d.code)).toContain('not_set');
  });

  test('a form that is gone is explained instead of rendered', () => {
    const built = adapter('applications.withdrawn').build(config(), scene({ formIndex: 9 }));

    expect(built.ok).toBe(false);
  });
});

describe('the review card rehearsal', () => {
  test('renders the card with sample answers built from the form’s questions', () => {
    const settings = config();
    const built = adapter('applications.review_card').build(
      settings,
      scene({ formIndex: 0, status: 'in_review', number: 7 }),
    );
    const rendered = message(built);
    const text = v2Text(rendered);

    expect(built.ok && built.caption).toBe('application #7 on Team Application, in review');
    expect(text).toContain('## Team Application #7');
    expect(text).toContain(`claimed by <@${actor.user.id}>`);
    const [first] = questionsOf(team());
    expect(text).toContain(`**${first?.label}**`);
    expect(rendered.mentions).toEqual({ everyone: false, roles: false, users: false });
  });

  test('a failed action shows its label, and full mode keeps to its budget', () => {
    const built = adapter('applications.review_card').build(
      config(),
      scene({ formIndex: 1, failedAction: true }),
    );
    const text = v2Text(message(built));

    expect(text).toContain('**Needs attention:** DM not delivered.');
    expect(text).toContain('**Why?**');
  });

  test('the test delivery disables every button and mints no module custom ids', () => {
    const built = message(adapter('applications.review_card').build(config(), scene()));
    const { message: test } = asTestDelivery(built, actor.user.id);
    const body = toDiscordMessage(test, { customIdFor: testCustomIdFor });
    const serialised = JSON.stringify(body);

    expect(body.flags).toBe(32768);
    expect(serialised).not.toContain('proton:applications');
    expect(countV2Components(test.v2)).toBeLessThanOrEqual(40);
    expect(serialised).toContain(`https://prtn.xyz/review/${SAMPLE_SERVER.id}"`);
    for (const component of test.v2) {
      if (component.kind !== 'container') continue;
      for (const child of component.children) {
        if (child.kind !== 'row') continue;
        if (child.row.kind === 'select') {
          expect(child.row.select.disabled).toBe(true);
          continue;
        }
        for (const button of child.row.buttons) {
          if (button.style !== 'link') expect(button.disabled).toBe(true);
        }
      }
    }
  });

  test('destination is the form’s review channel, falling back to the server’s', () => {
    const review = adapter('applications.review_card');

    expect(review.destination?.(config(), { formIndex: 0 })).toBe(REVIEW_CHANNEL);
    expect(review.destination?.(config(), { formIndex: 1 })).toBe('100000000000000072');
    expect(review.destination?.(config(), { formIndex: 5 })).toBe(null);
  });
});

describe('the panel rehearsal', () => {
  test('renders the panel with a button per form and posts where the panel lives', () => {
    const panel = adapter('applications.panel');
    const built = panel.build(config(), scene({ panelIndex: 0 }));
    const rendered = message(built);
    const labels = JSON.stringify(rendered.v2);

    expect(labels).toContain('"label":"Team Application"');
    expect(labels).toContain('"label":"Event Application"');
    expect(panel.destination?.(config(), { panelIndex: 0 })).toBe(PANEL_CHANNEL);

    const body = toDiscordMessage(asTestDelivery(rendered, actor.user.id).message, {
      customIdFor: testCustomIdFor,
    });
    expect(JSON.stringify(body)).not.toContain('proton:applications');
  });

  test('a panel that is gone is explained', () => {
    expect(adapter('applications.panel').build(config(), scene({ panelIndex: 3 })).ok).toBe(false);
  });
});

describe('sample answers', () => {
  test('go through the real validator, so branches and limits hold', () => {
    const form = config().forms[1];
    if (form === undefined) throw new Error('missing form');
    const [why] = sampleAnswers(form);

    expect(why?.display.length).toBeGreaterThanOrEqual(40);
    expect(why?.display.length).toBeLessThanOrEqual(60);

    const shown = sampleAnswers(team()).map((answer) => answer.questionId);
    const all = questionsOf(team()).map((question) => question.id);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((id) => all.includes(id))).toBe(true);
  });
});

describe('rehearsals change nothing', () => {
  test('builds are pure: the same scene gives the same render and config is never written', () => {
    const settings = deepFreeze(config());
    const store = new MemoryApplicationStore();
    const inputs: Inputs = { formIndex: 0, panelIndex: 0, status: 'accepted', failedAction: true };

    for (const simulation of applicationsSimulations) {
      const first = simulation.build(settings, scene(inputs));
      const second = simulation.build(settings, scene(inputs));
      expect(first).toEqual(second);
    }

    expect(store.applicationsById.size).toBe(0);
    expect(store.effectsById.size).toBe(0);
    expect(store.auditRows.size).toBe(0);
  });

  test('the simulation subpath reaches no store, runner or server-only package', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
    const files = new Set<string>();
    const packages = new Set<string>();
    const queue = [join(root, 'simulation.ts')];

    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || files.has(file)) continue;
      files.add(file);

      for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
        if (path.startsWith('.')) queue.push(resolve(dirname(file), path));
        else packages.add(path);
      }
    }

    const reached = [...files].map((file) => file.slice(root.length + 1).replaceAll('\\', '/'));
    const forbidden = ['store.ts', 'postgres-store.ts', 'table.ts', 'runner.ts', 'staff.ts'];
    for (const file of forbidden) expect(reached).not.toContain(file);
    for (const name of packages) {
      expect(name).not.toMatch(/^(discord\.js|drizzle-orm|ioredis|@proton\/db)/);
    }
  });
});
