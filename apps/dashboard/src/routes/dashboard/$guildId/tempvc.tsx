import { type TempVcHub, tempVcHubsSchema } from '@proton/module-tempvc/config';
import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Callout, SectionCard, SettingsGrid } from '../../../components/form/section.tsx';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import { Num, Toggle, usePanelSchema } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';
import { moduleState } from '../../../components/shell/module-meta.ts';

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

  const hubs = form.value('hubs', []) as TempVcHub[];

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SettingsGrid>
          {moduleState(form.summary) === 'off' ? (
            <Callout>
              Temporary channels is switched off. Everything here is saved, and no creator channel
              makes anything until the switch above is on.
            </Callout>
          ) : null}

          {hubs.length === 0 ? (
            <Callout>
              Nothing runs yet. Pick the voice channel members will join to get one of their own,
              choose the category its channels land in, then switch the module on.
            </Callout>
          ) : null}

          <SectionCard id="tempvc:panel:hubs" title="Creator channels" span="full">
            <Hubs form={form} />
          </SectionCard>

          <SectionCard id="tempvc:live" title="Channels live now">
            <div className="empty-state">
              <span className="empty-state-title">The live list is only in Discord</span>
              <p className="status">
                Proton records every channel it makes — which creator channel made it, who owns it
                and when it was created — but there is no route from the dashboard to that table
                yet, and occupancy is only ever Discord’s own.
              </p>
            </div>
          </SectionCard>

          <SectionCard
            id="tempvc:general"
            title="General"
            hint="Applies to every creator channel in the server."
          >
            <Toggle
              path="ownerCommands"
              label="Let owners manage their own channel"
              help="Off takes /voice and the control panel away everywhere, whatever a creator channel allows."
              defaultValue={true}
            />
            <Num
              path="serverCreationLimit"
              label="New channels per minute"
              help="Discord rate-limits channel creation per server; past this Proton waits."
              min={1}
              max={200}
              defaultValue={30}
            />
          </SectionCard>
        </SettingsGrid>
      </ModuleSettings>
    </>
  );
}

function Hubs({ form }: { form: ModuleForm }): ReactElement {
  const hubs = form.value('hubs', []) as TempVcHub[];
  usePanelSchema('hubs', 'Creator channels', tempVcHubsSchema, hubs);

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
