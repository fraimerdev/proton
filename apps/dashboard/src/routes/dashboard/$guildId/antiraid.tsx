import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import {
  ChannelField,
  Choice,
  Duration,
  Num,
  POSTABLE_CHANNEL_TYPES,
  RoleField,
} from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

const RAID_RESPONSES = ['verify', 'quarantine', 'kick'] as const;

// MIN_ACTIONABLE_SCORE and MAX_JOIN_SCORE, derived from SIGNAL_WEIGHTS this package cannot import.
const MIN_ACTIONABLE_SCORE = 3;
const MAX_JOIN_SCORE = 5;

export const Route = createFileRoute('/dashboard/$guildId/antiraid')({
  ...moduleRoute('antiraid'),
  component: AntiraidPage,
});

function AntiraidPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'antiraid');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="antiraid:general" title="General">
          <ChannelField
            path="alertChannelId"
            label="Alert channel"
            channelTypes={POSTABLE_CHANNEL_TYPES}
            optional
          />
        </SectionCard>

        <SectionCard id="antiraid:detection" title="Detection">
          <Duration path="joinWindow" label="Join window" defaultValue="10s" />
          <Num path="joinThreshold" label="Joins per window" min={2} max={500} defaultValue={10} />
          <Duration path="newAccountAge" label="New account age" defaultValue="7d" />
          <Duration path="brandNewAccountAge" label="Brand-new account age" defaultValue="1d" />
          <Num
            path="scoreThreshold"
            label="Score to act"
            min={MIN_ACTIONABLE_SCORE}
            max={MAX_JOIN_SCORE}
            defaultValue={MIN_ACTIONABLE_SCORE}
          />
        </SectionCard>

        <SectionCard id="antiraid:response" title="Response">
          <Choice path="response" label="Response" options={RAID_RESPONSES} defaultValue="verify" />
          <RoleField
            path="verificationRoleId"
            label="Verification role"
            help="Gates nothing unless the role’s own permissions deny access"
            optional
          />
          <RoleField
            path="quarantineRoleId"
            label="Quarantine role"
            help="Stays on until a staff member takes it off"
            optional
          />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
