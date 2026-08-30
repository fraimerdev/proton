import { type TempVcHub, tempVcHubsSchema } from '@proton/module-tempvc/config';
import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import { Num, Toggle, usePanelSchema } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

const HubsEditor = lazyRouteComponent(
  () => import('../../../components/tempvc/hubs.tsx'),
  'HubsEditor',
);

export const Route = createFileRoute('/dashboard/$guildId/tempvc')({
  ...moduleRoute('tempvc', { preload: [HubsEditor] }),
  component: TempVcPage,
});

function TempVcPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'tempvc');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="tempvc:general" title="General">
          <Toggle
            path="ownerCommands"
            label="Let owners manage their own channel"
            help="Turns off /voice and the control panel everywhere, whatever each creator channel allows"
            defaultValue={true}
          />
        </SectionCard>

        <SectionCard id="tempvc:protection" title="Protection">
          <Num
            path="serverCreationLimit"
            label="New channels per minute"
            help="Discord rate-limits channel creation per server; past this Proton waits"
            min={1}
            max={200}
            defaultValue={30}
          />
        </SectionCard>

        <SectionCard id="tempvc:panel:hubs" title="Hubs">
          <Hubs form={form} />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}

function Hubs({ form }: { form: ModuleForm }): ReactElement {
  const hubs = form.value('hubs', []) as TempVcHub[];
  usePanelSchema('hubs', 'Hubs', tempVcHubsSchema, hubs);

  return (
    <HubsEditor
      hubs={hubs}
      channels={form.channels}
      roles={form.roles}
      tier={form.tier}
      onChange={(next) => form.set('hubs', next)}
    />
  );
}
