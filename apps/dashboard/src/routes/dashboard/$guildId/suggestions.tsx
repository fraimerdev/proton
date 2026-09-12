import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard, SettingsGrid } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import {
  ChannelField,
  POSTABLE_CHANNEL_TYPES,
  Toggle,
} from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

export const Route = createFileRoute('/dashboard/$guildId/suggestions')({
  ...moduleRoute('suggestions'),
  component: SuggestionsPage,
});

function SuggestionsPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'suggestions');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SettingsGrid>
          {/* The thread toggle sits with the channel because it is a permission on that channel,
              not a property of the suggestion. */}
          <SectionCard id="suggestions:general" title="Where suggestions go">
            <ChannelField
              path="channelId"
              label="Suggestion channel"
              help="Needs View Channel, Send Messages and Embed Links there"
              channelTypes={POSTABLE_CHANNEL_TYPES}
              optional
            />
            <Toggle
              path="createThread"
              label="Open a discussion thread for each suggestion"
              help="Also needs Create Public Threads in the suggestion channel"
              defaultValue={false}
            />
          </SectionCard>

          <SectionCard id="suggestions:voting" title="Authors and voting">
            <Toggle
              path="anonymous"
              label="Hide who wrote each suggestion"
              help="Proton still stores the author and can tell staff on request"
              defaultValue={false}
            />
            <Toggle
              path="allowSelfVote"
              label="Let members vote on their own suggestion"
              defaultValue={true}
            />
          </SectionCard>
        </SettingsGrid>
      </ModuleSettings>
    </>
  );
}
