import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { Toggle } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

export const Route = createFileRoute('/dashboard/$guildId/help')({
  ...moduleRoute('help'),
  component: HelpPage,
});

function HelpPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'help');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="help:general" title="General">
          <Toggle
            path="ephemeral"
            label="Show the reply only to whoever ran it"
            help="Turn this off to post the overview into the channel, where everyone can read it."
            defaultValue={true}
          />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
