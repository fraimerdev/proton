import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { ChannelField, Text } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

export const Route = createFileRoute('/dashboard/$guildId/ping')({
  ...moduleRoute('ping'),
  component: PingPage,
});

function PingPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'ping');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="ping:general" title="General">
          <Text
            path="response"
            label="Reply text"
            minLength={1}
            maxLength={200}
            defaultValue="Pong!"
          />
          <ChannelField
            path="restrictToChannel"
            label="Restrict to channel"
            channelTypes={[0]}
            optional
          />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
