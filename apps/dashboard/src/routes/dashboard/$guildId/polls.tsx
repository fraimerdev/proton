import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { ChannelField, Num, Toggle } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

export const Route = createFileRoute('/dashboard/$guildId/polls')({
  ...moduleRoute('polls'),
  component: PollsPage,
});

function PollsPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'polls');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="polls:general" title="General">
          <Num
            path="defaultDurationHours"
            label="Default length in hours"
            min={1}
            max={768}
            defaultValue={24}
          />
        </SectionCard>

        <SectionCard id="polls:results" title="When a poll closes">
          <Toggle path="announceResults" label="Announce when a poll closes" defaultValue={true} />
          <ChannelField
            path="announceChannelId"
            label="Announce in"
            help="Empty announces in the channel the poll was started in"
            channelTypes={[0, 5, 11, 12]}
            optional
          />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
