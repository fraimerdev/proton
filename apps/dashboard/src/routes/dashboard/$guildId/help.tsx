import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard, SettingsGrid } from '../../../components/form/section.tsx';
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
        <SettingsGrid>
          <SectionCard id="help:reply" title="How the help reply is posted">
            <Toggle
              path="ephemeral"
              label="Show the reply only to whoever ran it"
              defaultValue={true}
            />
          </SectionCard>
        </SettingsGrid>
      </ModuleSettings>
    </>
  );
}
