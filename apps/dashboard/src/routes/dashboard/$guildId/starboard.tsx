import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { FieldRow, SectionCard, SettingsGrid } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import {
  ChannelField,
  Emoji,
  Num,
  POSTABLE_CHANNEL_TYPES,
  Toggle,
  Tokens,
} from '../../../components/module/inputs.tsx';
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
        <SettingsGrid>
          <SectionCard
            id="starboard:general"
            title="The board"
            hint="Where starred messages are posted, and what it takes to get there."
          >
            <ChannelField
              path="boardChannelId"
              label="Board channel"
              channelTypes={[0, 5, 11, 12]}
              optional
            />
            <FieldRow>
              <Emoji
                path="emoji"
                label="Star emoji"
                help="The reaction members add. This server’s own emoji work too."
                defaultValue="⭐"
              />
              <Num path="threshold" label="Stars needed" min={1} max={100} defaultValue={3} />
            </FieldRow>
          </SectionCard>

          <SectionCard id="starboard:scope" title="What can be starred" span="full">
            <Tokens
              path="sourceChannelIds"
              kind="channel-id"
              label="Source channels"
              help="Empty watches every channel Proton can see"
              channelTypes={POSTABLE_CHANNEL_TYPES}
              maxItems={50}
            />
            <Toggle path="ignoreBots" label="Ignore bot messages" defaultValue={true} />
            <Toggle path="selfStarAllowed" label="Count self-stars" defaultValue={false} />
            <Toggle path="ignoreNsfw" label="Ignore age-restricted channels" defaultValue={true} />
          </SectionCard>
        </SettingsGrid>
      </ModuleSettings>
    </>
  );
}
