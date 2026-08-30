import { type RolemenuMenu, rolemenuMenusSchema } from '@proton/module-rolemenu/config';
import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import { usePanelSchema } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

const RolemenuEditor = lazyRouteComponent(
  () => import('../../../components/rolemenu/menus.tsx'),
  'RolemenuEditor',
);

export const Route = createFileRoute('/dashboard/$guildId/rolemenu')({
  ...moduleRoute('rolemenu', { preload: [RolemenuEditor] }),
  component: RolemenuPage,
});

function RolemenuPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'rolemenu');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="rolemenu:panel:menus" title="Role menus">
          <Menus form={form} />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}

function Menus({ form }: { form: ModuleForm }): ReactElement {
  const menus = form.value('menus', []) as RolemenuMenu[];
  usePanelSchema('menus', 'Role menus', rolemenuMenusSchema, menus);

  return (
    <RolemenuEditor
      menus={menus}
      roles={form.roles}
      channels={form.channels}
      onChange={(next) => form.set('menus', next)}
    />
  );
}
