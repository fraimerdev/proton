import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { FieldRow, SectionCard, SettingsGrid } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { ChannelField, Choice, Duration, Tokens } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

const ACTIONS = ['none', 'timeout', 'kick', 'ban'] as const;

export const Route = createFileRoute('/dashboard/$guildId/phishing')({
  ...moduleRoute('phishing'),
  component: PhishingPage,
});

function PhishingPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'phishing');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SettingsGrid>
          <SectionCard
            id="phishing:response"
            title="Response"
            hint="What happens to a member who posts a blocked link, and where Proton reports it."
          >
            <FieldRow>
              <Choice
                path="action"
                label="Action"
                help="The message itself is never deleted"
                options={ACTIONS}
                defaultValue="timeout"
              />
              <Duration
                path="timeoutDuration"
                label="Timeout length"
                help="Discord caps timeouts at 28 days"
                defaultValue="1h"
              />
            </FieldRow>
            <ChannelField
              path="alertChannel"
              label="Alert channel"
              channelTypes={[0, 5, 11, 12]}
              optional
            />
          </SectionCard>

          {/* Full-width: each list holds a hundred domains, and the chips wrap. */}
          <SectionCard id="phishing:lists" title="Domain lists" span="full">
            <Tokens
              path="blockDomains"
              kind="string"
              label="Extra blocked domains"
              maxItems={100}
            />
            <Tokens
              path="allowDomains"
              kind="string"
              label="Never blocked"
              help="Also allows every subdomain"
              maxItems={100}
            />
          </SectionCard>
        </SettingsGrid>
      </ModuleSettings>
    </>
  );
}
