import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
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
        <SectionCard id="suggestions:general" title="General">
          <ChannelField
            path="channelId"
            label="Suggestion channel"
            help="Needs View Channel, Send Messages and Embed Links there"
            channelTypes={POSTABLE_CHANNEL_TYPES}
            optional
          />
        </SectionCard>

        <SectionCard id="suggestions:posting" title="How suggestions are posted">
          <Toggle
            path="createThread"
            label="Open a discussion thread for each suggestion"
            help="Also needs Create Public Threads in the suggestion channel"
            defaultValue={false}
          />
          <Toggle
            path="anonymous"
            label="Hide who wrote each suggestion"
            help="Proton still stores the author and can tell staff on request"
            defaultValue={false}
          />
        </SectionCard>

        <SectionCard id="suggestions:voting" title="Voting">
          <Toggle
            path="allowSelfVote"
            label="Let members vote on their own suggestion"
            defaultValue={true}
          />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
