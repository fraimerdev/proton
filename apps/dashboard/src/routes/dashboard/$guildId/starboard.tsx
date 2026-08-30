import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { ChannelField, Num, Text, Toggle, Tokens } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

export const Route = createFileRoute('/dashboard/$guildId/starboard')({
  ...moduleRoute('starboard'),
  component: StarboardPage,
});

function StarboardPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'starboard');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="starboard:general" title="General">
          <ChannelField
            path="boardChannelId"
            label="Board channel"
            channelTypes={[0, 5, 11, 12]}
            optional
          />
        </SectionCard>

        <SectionCard id="starboard:threshold" title="Stars">
          <Text
            path="emoji"
            label="Star emoji"
            help="Unicode emoji, or a custom one pasted straight from chat"
            minLength={1}
            maxLength={64}
            defaultValue="⭐"
          />
          <Num path="threshold" label="Stars needed" min={1} max={100} defaultValue={3} />
        </SectionCard>

        <SectionCard id="starboard:scope" title="What can be starred">
          <Tokens
            path="sourceChannelIds"
            kind="channel-id"
            label="Source channels"
            help="Empty watches every channel Proton can see"
            maxItems={50}
          />
          <Toggle path="ignoreBots" label="Ignore bot messages" defaultValue={true} />
          <Toggle path="selfStarAllowed" label="Count self-stars" defaultValue={false} />
          <Toggle path="ignoreNsfw" label="Ignore age-restricted channels" defaultValue={true} />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
