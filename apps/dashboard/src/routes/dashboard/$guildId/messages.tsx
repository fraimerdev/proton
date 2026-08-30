import {
  type SavedComponent,
  savedComponentsSchema,
  templatesSchema,
} from '@proton/module-messages/config';
import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import type { SavedMessageEntry } from '../../../components/messages/templates.tsx';
import { MESSAGES_AREAS as AREAS } from '../../../components/module/area-index.ts';
import { activeArea } from '../../../components/module/areas.ts';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import { usePanelSchema } from '../../../components/module/inputs.tsx';
import { AreaHub, ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

const TemplatesEditor = lazyRouteComponent(
  () => import('../../../components/messages/templates.tsx'),
  'TemplatesEditor',
);

const PaletteEditor = lazyRouteComponent(
  () => import('../../../components/messages/palette.tsx'),
  'PaletteEditor',
);

export const Route = createFileRoute('/dashboard/$guildId/messages')({
  ...moduleRoute('messages', { areas: AREAS, preload: [TemplatesEditor, PaletteEditor] }),
  component: MessagesPage,
});

function MessagesPage(): ReactElement {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();
  const form = useModuleForm(guildId, 'messages', true);

  const area = activeArea(AREAS, search.area);

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={area} tabs={[]} />

      {area === undefined ? (
        <AreaHub areas={AREAS} config={form.config} />
      ) : (
        <ModuleSettings form={form}>
          {area.id === 'templates' ? <TemplatesArea form={form} /> : null}
          {area.id === 'components' ? <ComponentsArea form={form} /> : null}
        </ModuleSettings>
      )}
    </>
  );
}

function TemplatesArea({ form }: { form: ModuleForm }): ReactElement {
  const templates = form.value('templates', []) as SavedMessageEntry[];
  usePanelSchema('templates', 'Templates', templatesSchema, templates);

  return (
    <SectionCard id="messages:panel:templates" title="Templates">
      <TemplatesEditor
        templates={templates}
        channels={form.channels}
        roles={form.roles}
        tier={form.tier}
        // Live, not stored: a component saved in the palette is insertable before either half is.
        palette={form.value('components', []) as SavedComponent[]}
        onChange={(next) => form.set('templates', next)}
      />
    </SectionCard>
  );
}

function ComponentsArea({ form }: { form: ModuleForm }): ReactElement {
  const components = form.value('components', []) as SavedComponent[];
  usePanelSchema('components', 'Components', savedComponentsSchema, components);

  return (
    <SectionCard id="messages:panel:components" title="Components">
      <PaletteEditor
        components={components}
        roles={form.roles}
        onChange={(next) => form.set('components', next)}
      />
    </SectionCard>
  );
}
