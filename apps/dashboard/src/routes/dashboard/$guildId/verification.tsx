import { type ButtonStyle, type ProtonMessage, parseComponentEmoji } from '@proton/core';
import {
  BUTTON_LABEL_MAX,
  DEFAULT_PANEL,
  PANEL_BUTTON_STYLES,
  verificationPanelSchema,
} from '@proton/module-verification/config';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Callout, FieldRow, SectionCard, SettingsGrid } from '../../../components/form/section.tsx';
import { MessageBuilder } from '../../../components/message/builder.tsx';
import { ButtonFace } from '../../../components/message/button-face.tsx';
import { MessagePreview } from '../../../components/message/preview.tsx';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import {
  ChannelField,
  Choice,
  Duration,
  Num,
  RoleField,
  Toggle,
  usePanelSchema,
} from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { PostPanel } from '../../../components/module/post-panel.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';
import { moduleState } from '../../../components/shell/module-meta.ts';

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
        <SettingsGrid>
          {moduleState(form.summary) === 'off' ? (
            <Callout>
              Verification is switched off. Everything here is saved, and nobody is gated until the
              switch above is on.
            </Callout>
          ) : null}

          {/* The one instruction without which this module does nothing, and it was set in the
              quietest type on the page. */}
          <Callout tone="warn">
            Proton never rewrites your channels. Deny the unverified role everywhere except the
            verify channel, so a newcomer only sees that one.
          </Callout>

          <SectionCard id="verification:gate" title="The gate">
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
            <RoleField
              path="quarantineRoleId"
              label="Quarantine role"
              help="Anti-raid can put a suspected raider here too, instead of kicking them"
              optional
            />
            <Toggle
              path="applyUnverifiedOnJoin"
              label="Apply the unverified role on join"
              defaultValue={true}
            />
          </SectionCard>

          <SectionCard
            id="verification:panel"
            title="The panel"
            hint="Proton reposts it whenever these settings are saved. The verify button is attached to the message itself, so it can never be deleted on its own."
          >
            <ChannelField
              path="panelChannelId"
              label="Panel channel"
              help="Where Proton posts the message new members press"
              channelTypes={[0, 5]}
              optional
            />
            <Button form={form} />
            <PostPanel panelId="panel" label="Post the panel" />
          </SectionCard>

          <SectionCard
            id="verification:panel:message"
            title="The panel message"
            hint="Anything a Proton message can be, minus button rows — the verify button is the row."
            span="full"
          >
            <Panel form={form} />
          </SectionCard>

          {/* Hidden, never unmounted: the fields inside still hold values a save writes. */}
          <div className="grid-passthrough" hidden={notCaptcha}>
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
              <FieldRow>
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
              </FieldRow>
              <Duration
                path="captchaExpiry"
                label="Captcha expires after"
                defaultValue="5m"
                hidden={notCaptcha}
              />
            </SectionCard>
          </div>

          <div className="grid-passthrough" hidden={notCaptcha && notTimeout}>
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
        </SettingsGrid>
      </ModuleSettings>
    </>
  );
}

function Button({ form }: { form: ModuleForm }): ReactElement {
  const style = form.value('panelButtonStyle', 'success') as ButtonStyle;

  return (
    <ButtonFace
      label={String(form.value('panelButtonLabel', 'Verify') ?? '')}
      emoji={String(form.value('panelButtonEmoji', '') ?? '')}
      style={style}
      // Link is left out: a link button carries no custom_id, so picking it would post a panel
      // whose button never comes back to Proton and can verify nobody.
      styles={PANEL_BUTTON_STYLES}
      max={BUTTON_LABEL_MAX}
      paths={{
        label: 'panelButtonLabel',
        emoji: 'panelButtonEmoji',
        style: 'panelButtonStyle',
      }}
      onLabel={(value) => form.set('panelButtonLabel', value)}
      onEmoji={(value) => form.set('panelButtonEmoji', value === '' ? undefined : value)}
      onStyle={(next) => form.set('panelButtonStyle', next)}
    />
  );
}

function Panel({ form }: { form: ModuleForm }): ReactElement {
  const panel = form.value('panel', DEFAULT_PANEL) as ProtonMessage;
  usePanelSchema('panel', 'The panel message', verificationPanelSchema, panel);

  const emoji = parseComponentEmoji(String(form.value('panelButtonEmoji', '') ?? ''));
  const label = String(form.value('panelButtonLabel', 'Verify') ?? '');

  // What Discord is actually sent: the authored message plus the one row Proton attaches to it. The
  // builder cannot hold that row — it would be a component the next save wrote into the config.
  const posted: ProtonMessage = {
    ...panel,
    components: [
      {
        kind: 'buttons',
        buttons: [
          {
            key: 'verify',
            style: form.value('panelButtonStyle', 'success') as ButtonStyle,
            ...(label === '' ? {} : { label }),
            ...(emoji === undefined ? {} : { emoji }),
          },
        ],
      },
    ],
  };

  return (
    <div className="verify-panel panel-wide">
      <div className="saved-body">
        <div className="saved-edit">
          <MessageBuilder
            message={panel}
            channels={form.channels}
            roles={form.roles}
            // Embeds only. Proton attaches the verify button as the message's one action row, and
            // Discord will not put a row on a components-v2 layout.
            allow="embeds"
            onChange={(next) => form.set('panel', next)}
          />
        </div>

        <div className="saved-preview">
          <MessagePreview message={posted} channels={form.channels} roles={form.roles} />
        </div>
      </div>
    </div>
  );
}
