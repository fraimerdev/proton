import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import {
  ChannelField,
  Choice,
  Duration,
  Num,
  RoleField,
  Text,
  Toggle,
} from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

const MODES = ['button', 'captcha', 'website'] as const;

const MODE_LABELS: Record<string, string> = {
  button: 'Press a button',
  captcha: 'Solve a captcha',
  website: 'Sign in on Proton’s website',
};

const DELIVERIES = ['channel', 'dm'] as const;

const DELIVERY_LABELS: Record<string, string> = {
  channel: 'In the channel, where only they can see it',
  dm: 'By direct message',
};

const FAILURE_ACTIONS = ['none', 'kick', 'ban', 'timeout', 'quarantine'] as const;

const FAILURE_LABELS: Record<string, string> = {
  none: 'Nothing — let them try again',
  kick: 'Kick them',
  ban: 'Ban them',
  timeout: 'Time them out',
  quarantine: 'Give them the quarantine role',
};

export const Route = createFileRoute('/dashboard/$guildId/verification')({
  ...moduleRoute('verification'),
  component: VerificationPage,
});

function VerificationPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'verification');

  const mode = form.value('mode');
  const failureAction = form.value('failureAction');

  // Fails open on an absent controller: hiding a field with no way back is worse than showing it.
  const notCaptcha = mode !== undefined && mode !== 'captcha';
  const notTimeout = failureAction !== undefined && failureAction !== 'timeout';

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="verification:gate" title="Verification gate">
          <Choice
            path="mode"
            label="How members verify"
            options={MODES}
            optionLabels={MODE_LABELS}
            defaultValue="button"
          />
          <RoleField
            path="unverifiedRoleId"
            label="Unverified role"
            help="New members are briefly ungated until Proton applies it"
            optional
          />
          <RoleField path="verifiedRoleId" label="Member role" optional />
          <Toggle
            path="applyUnverifiedOnJoin"
            label="Apply the unverified role on join"
            defaultValue={true}
          />
        </SectionCard>

        <SectionCard id="verification:panel" title="Panel">
          <ChannelField
            path="panelChannelId"
            label="Panel channel"
            help="Where Proton posts the message new members press"
            channelTypes={[0, 5]}
            optional
          />
          <Text
            path="panelTitle"
            label="Panel heading"
            maxLength={256}
            defaultValue="Verify to get access"
          />
          <Text
            path="panelBody"
            label="Panel text"
            maxLength={1800}
            defaultValue="Press the button below to unlock the rest of the server."
          />
          <Text
            path="panelButtonLabel"
            label="Button label"
            minLength={1}
            maxLength={80}
            defaultValue="Verify"
          />
        </SectionCard>

        {/* Hidden, never unmounted: the fields inside still hold values a save writes. */}
        <div hidden={notCaptcha}>
          <SectionCard id="verification:captcha" title="Captcha">
            <Choice
              path="captchaDelivery"
              label="Send the captcha"
              help="A member with DMs closed is always answered in the channel instead"
              options={DELIVERIES}
              optionLabels={DELIVERY_LABELS}
              defaultValue="channel"
              hidden={notCaptcha}
            />
            <Num
              path="captchaLength"
              label="Characters"
              min={4}
              max={8}
              defaultValue={6}
              hidden={notCaptcha}
            />
            <Num
              path="captchaAttempts"
              label="Attempts allowed"
              min={1}
              max={5}
              defaultValue={3}
              hidden={notCaptcha}
            />
            <Duration
              path="captchaExpiry"
              label="Captcha expires after"
              defaultValue="5m"
              hidden={notCaptcha}
            />
          </SectionCard>
        </div>

        <div hidden={notCaptcha && notTimeout}>
          <SectionCard id="verification:failure" title="Failed verification">
            <Choice
              path="failureAction"
              label="When a member runs out of attempts"
              options={FAILURE_ACTIONS}
              optionLabels={FAILURE_LABELS}
              defaultValue="none"
              hidden={notCaptcha}
            />
            <Duration
              path="failureTimeout"
              label="Timeout length"
              help="Discord caps timeouts at 28 days"
              defaultValue="1h"
              hidden={notTimeout}
            />
          </SectionCard>
        </div>

        <SectionCard id="verification:quarantine" title="Quarantine">
          <RoleField path="quarantineRoleId" label="Quarantine role" optional />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
