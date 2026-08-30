import { type Counter, countersListSchema } from '@proton/module-counters/config';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { CountersEditor } from '../../../components/counters/counters.tsx';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { usePanelSchema } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

export const Route = createFileRoute('/dashboard/$guildId/counters')({
  ...moduleRoute('counters'),
  component: CountersPage,
});

function CountersPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'counters');
  const counters = form.value('counters', []) as Counter[];

  // The editor already draws these errors; without the gate Save went out anyway and the API
  // rejected the whole module for the same incomplete counter the page was showing in red.
  usePanelSchema('counters', 'Counter channels', countersListSchema, counters);

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="counters:panel:counters" title="Counter channels">
          <CountersEditor
            counters={counters}
            channels={form.channels}
            tier={form.tier}
            onChange={(next) => form.set('counters', next)}
          />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
