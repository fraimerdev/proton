import { describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModuleConfigView } from '@proton/core';
import {
  type ApplicationsConfig,
  applicationsConfigSchema,
} from '@proton/module-applications/config';
import { APPLICATIONS_REVIEW_CARD_SIMULATION } from '@proton/module-applications/simulation';
import { FORM_TEMPLATES } from '@proton/module-applications/templates';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const SRC = join(import.meta.dir, '..', 'src');
const GUILD = '900000000000000002';
const TABS = ['questions', 'requirements', 'review', 'messages', 'actions', 'intake'] as const;

for (const file of readdirSync(join(SRC, 'server'))) {
  const source = readFileSync(join(SRC, 'server', file), 'utf8');
  const names = [...source.matchAll(/^export (?:const|(?:async )?function) (\w+)/gm)].map(
    ([, name]) => name as string,
  );

  mock.module(`../src/server/${file}`, () =>
    Object.fromEntries(names.map((name) => [name, async () => null])),
  );
}

const QUERIES = readFileSync(join(SRC, 'lib', 'queries.ts'), 'utf8');

mock.module('../src/lib/queries.ts', () => ({
  ...Object.fromEntries(
    [...QUERIES.matchAll(/^export (?:function|const) (\w+)/gm)].map(([, name]) => [
      name,
      (...args: unknown[]) => ({
        queryKey: ['stub', name, ...args],
        queryFn: async () => null,
        enabled: false,
      }),
    ]),
  ),
  MEMBER_LOOKUP_MAX: 100,
}));

const route = await import('../src/components/module/route.tsx');

mock.module('../src/components/module/route.tsx', () => ({
  ...route,
  ModuleLink: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
  useModuleSearch: () => ({}),
  useModuleNavigate: () => () => undefined,
}));

const router = await import('@tanstack/react-router');

mock.module('@tanstack/react-router', () => ({
  ...router,
  Link: ({ children }: { children: ReactNode }) => <a href="#router-link">{children}</a>,
}));

const { FormEditor } = await import('../src/pages/applications/editor.tsx');
const { reviewAudienceQuery } = await import('../src/pages/applications/admin-queries.ts');
const { checkedNote } = await import('../src/pages/applications/requirements.tsx');
const { FormsArea } = await import('../src/pages/applications/forms.tsx');
const { PanelsArea } = await import('../src/pages/applications/panels.tsx');
const { PanelEditor } = await import('../src/pages/applications/panel-editor.tsx');
const { SettingsArea } = await import('../src/pages/applications/settings.tsx');
const { fromTemplate } = await import('../src/pages/applications/shape.ts');
type ApplicationsForm = import('../src/pages/applications/shape.ts').ApplicationsForm;

function configWith(saved: boolean): { value: ApplicationsConfig; saved: ApplicationsConfig } {
  const team = fromTemplate('team', 'team', 'Team Application');
  const value = applicationsConfigSchema.parse({
    enabled: true,
    forms: [team],
    panels: [{ id: 'main', name: 'Main panel', formIds: ['team'] }],
  });
  return { value, saved: saved ? value : applicationsConfigSchema.parse({}) };
}

function formOf(
  value: ApplicationsConfig,
  saved: ApplicationsConfig,
  dirty = false,
): ApplicationsForm {
  const view = {
    moduleId: 'applications',
    enabled: true,
    config: saved,
    schemaVersion: 1,
    migrated: false,
    tier: 'pro',
    postables: [],
    simulations: [],
  } as unknown as ModuleConfigView;
  const noop = (): void => undefined;

  return {
    view,
    value,
    setValue: noop,
    rebase: noop,
    get: () => undefined,
    set: noop,
    dirty,
    errors: new Map<string, string>(),
    errorAt: () => undefined,
    templateDiagnosticsAt: () => [],
    save: noop,
    reset: noop,
    saving: false,
    saveError: null,
    failures: 0,
    changedElsewhere: false,
  };
}

function escaped(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

function markup(node: ReactElement): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function editor(tab: Parameters<typeof FormEditor>[0]['tab'], saved = true, dirty = false): string {
  const { value, saved: stored } = configWith(saved);
  return markup(
    <FormEditor
      form={formOf(value, stored, dirty)}
      guildId={GUILD}
      moduleId="applications"
      index={0}
      tab={tab}
      onTab={() => undefined}
    />,
  );
}

describe('the form editor', () => {
  test('shows the questions and the Discord step count, with no preview', () => {
    const html = editor('questions');
    const template = FORM_TEMPLATES.find((entry) => entry.id === 'team')?.build('team');
    const first = template?.sections[0]?.questions[0]?.label ?? '';

    expect(html).toContain('Publish…');
    expect(html).toContain('Details');
    expect(html).toContain('Discord shows this form in');
    expect(html).not.toContain('Preview');
    expect(html).toContain('Add section');
    expect(first).not.toBe('');
    expect(html).toContain(escaped(first));
    expect(html).not.toContain('Save your changes first.');
  });

  test('refuses to publish unsaved changes and says why, in the open', () => {
    expect(editor('questions', true, true)).toContain(
      'Save your changes first. Publishing uses the last saved version.',
    );
    expect(editor('questions', false)).toContain(
      'Save this form first. Publishing uses the last saved version.',
    );
  });

  test('draws every tab', () => {
    expect(editor('requirements')).toContain('Who can apply?');
    expect(editor('requirements')).toContain('Check a member');
    expect(editor('review')).toContain('Review team');
    expect(editor('review')).toContain('Answers on the card');
    expect(editor('messages')).toContain('What the applicant receives');
    expect(editor('messages')).toContain('DM the applicant');
    expect(editor('actions')).toContain('When accepted');
    expect(editor('actions')).toContain('Interview ticket');
    expect(editor('intake')).toContain('Reapply after');
    expect(editor('intake')).toContain(
      'Drafts already started are kept, but can’t be sent until you open the form again.',
    );
  });

  test('says which tabs publish and which apply on save', () => {
    expect(editor('questions')).toContain('Applicants see changes here once you publish.');
    expect(editor('messages')).toContain('Changes here apply as soon as you save.');
  });

  test('uses no em dash anywhere', () => {
    for (const tab of TABS) {
      expect(editor(tab)).not.toContain('—');
    }
  });
});

describe('previews that change nothing', () => {
  const CHANNEL = '900000000000000010';
  const OUTSIDER = '900000000000000011';

  function reviewWith(cardAnswers: 'none' | 'summary' | 'full', outsideTeam: string[]): string {
    const team = fromTemplate('team', 'team', 'Team Application');
    const value = applicationsConfigSchema.parse({
      enabled: true,
      forms: [{ ...team, review: { ...team.review, channelId: CHANNEL, cardAnswers } }],
    });
    const base = formOf(value, value);
    const form: ApplicationsForm = {
      ...base,
      view: { ...base.view, simulations: [APPLICATIONS_REVIEW_CARD_SIMULATION.descriptor] },
    };

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(reviewAudienceQuery(GUILD, CHANNEL, 'team').queryKey, {
      channelId: CHANNEL,
      everyone: false,
      roleIds: outsideTeam,
      administratorRoleIds: [],
      memberCount: 0,
      outsideTeam,
    });

    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <FormEditor
          form={form}
          guildId={GUILD}
          moduleId="applications"
          index={0}
          tab="review"
          onTab={() => undefined}
        />
      </QueryClientProvider>,
    );
  }

  const LEAKY =
    'People outside the review team can read this channel, so Proton won’t post answers there. ' +
    'Cards show only the application’s details.';

  test('the review card can be tested from its own tab', () => {
    expect(reviewWith('summary', [])).toContain('Test review card');
  });

  test('any answers on a card read outside the team are refused, summaries included', () => {
    expect(reviewWith('summary', [OUTSIDER])).toContain(escaped(LEAKY));
    expect(reviewWith('full', [OUTSIDER])).toContain(escaped(LEAKY));
    expect(reviewWith('none', [OUTSIDER])).not.toContain(escaped(LEAKY));
    expect(reviewWith('summary', [])).not.toContain(escaped(LEAKY));
  });

  test('the actions tab sums up what each step does', () => {
    const html = editor('actions');

    expect(html).toContain('What happens');
    expect(html).toContain(
      'Proton changes no roles, gives no XP and opens no tickets for this form.',
    );
  });

  test('a member check says which requirements it used', () => {
    expect(checkedNote('published')).toContain('Checked against the published requirements');
    expect(checkedNote('saved')).toContain('This form isn’t published yet');
    expect(checkedNote(undefined)).toBeNull();
  });
});

describe('the other areas', () => {
  test('the forms list shows each form with its status', () => {
    const { value, saved } = configWith(true);
    const html = markup(
      <FormsArea form={formOf(value, saved)} guildId={GUILD} onOpen={() => undefined} />,
    );

    expect(html).toContain('Create form');
    expect(html).toContain('Team Application');
    expect(html).toContain('Draft');
  });

  test('an empty forms list offers templates', () => {
    const empty = applicationsConfigSchema.parse({});
    const html = markup(
      <FormsArea form={formOf(empty, empty)} guildId={GUILD} onOpen={() => undefined} />,
    );

    expect(html).toContain('No forms yet');
  });

  test('panels list with a post button, and the panel editor with its forms', () => {
    const { value, saved } = configWith(true);
    const list = markup(
      <PanelsArea
        form={formOf(value, saved)}
        guildId={GUILD}
        moduleId="applications"
        enabled
        onOpen={() => undefined}
      />,
    );
    const edit = markup(<PanelEditor form={formOf(value, saved)} guildId={GUILD} index={0} />);

    expect(list).toContain('Main panel');
    expect(list).toContain('Post');
    expect(list).toContain('has no channel yet');
    expect(edit).toContain('Forms on this panel');
    expect(edit).toContain('My applications button');
  });

  test('settings name each power and link to the staff review page', () => {
    const { value, saved } = configWith(true);
    const html = markup(<SettingsArea form={formOf(value, saved)} guildId={GUILD} />);

    expect(html).toContain('Default review team');
    expect(html).toContain('Keep answers after a decision');
    expect(html).toContain(`href="/review/${GUILD}"`);
    expect(html).not.toContain('—');
  });
});
