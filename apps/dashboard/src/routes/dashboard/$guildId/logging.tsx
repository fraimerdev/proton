import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import {
  Duration,
  POSTABLE_CHANNEL_TYPES,
  Toggle,
  Tokens,
} from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

export const Route = createFileRoute('/dashboard/$guildId/logging')({
  ...moduleRoute('logging'),
  component: LoggingPage,
});

function LoggingPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'logging');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="logging:general" title="General">
          <Toggle path="logEdits" label="Log edits" defaultValue={true} />
          <Toggle path="logDeletes" label="Log deletions" defaultValue={true} />
        </SectionCard>

        <SectionCard id="logging:cache" title="Recent message text">
          <Toggle
            path="cacheMessageContent"
            label="Remember recent message text"
            help="Personal data, held in memory apart from the 30-day archive"
            defaultValue={false}
          />
          <Duration path="cacheRetention" label="How long to remember" defaultValue="24h" />
        </SectionCard>

        <SectionCard id="logging:privacy" title="Privacy">
          <Tokens
            path="ignoredChannels"
            kind="channel-id"
            label="Ignored channels"
            channelTypes={POSTABLE_CHANNEL_TYPES}
            maxItems={50}
          />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
