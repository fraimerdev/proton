import { countV2Components, V2_COMPONENTS_MAX } from '@proton/core';
import { HONEYPOT_DM_SURFACE } from '@proton/module-honeypot/placeholders';
import type { ReactElement } from 'react';
import { EditorPreviewLayout } from '../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { TestMessage } from '../../components/module/test-message.tsx';
import { Switch, TextInput } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { LayoutBuilder } from './layout-builder.tsx';
import { configErrors, dmOffersAppeal, dmPreview, type HoneypotForm } from './shape.ts';

const INVITE_URL_MAX = 512;

const PLACEHOLDERS =
  'Type { in any text or link to add a placeholder. Proton adds account recovery advice and any ' +
  'buttons below your layout.';

const APPEAL_ADDRESS = 'The Appeal button gets a separate link for each caught member.';

const APPEAL_FROM_ESCALATION =
  'The Appeal button comes from the appeal form chosen under Follow-up, and only a ban offers one.';

const EMPTY = 'This layout sends nothing. Discord refuses an empty message.';

const REFUSED = 'With its placeholders filled in, this message can’t be sent.';

const BUILT_IN =
  'With its placeholders filled in, this layout can’t be sent, so Proton sends its own wording ' +
  'instead (shown here). Check the links, and any text that could come out empty.';

const NOT_SENT = 'The DM is off. Your layout is kept, but nothing is sent.';

const FREE_TIER =
  'On the Free plan, Proton sends its own wording. Yours is saved and used once the server is on ' +
  'a paid plan.';

export function DirectMessageArea({
  form,
  guildId,
}: {
  form: HoneypotForm;
  guildId: string;
}): ReactElement {
  const config = form.value;
  const errors = configErrors(form);
  const layoutError = form.errorAt('dmLayout.v2');
  const preview = dmPreview(config, form.view.tier);

  return (
    <EditorPreviewLayout
      previewTitle="What the member receives"
      previewActions={
        <TestMessage
          guildId={guildId}
          moduleId="honeypot"
          simulations={form.view.simulations}
          simulationId="honeypot.dm"
          draft={config as unknown as Record<string, unknown>}
          dirty={form.dirty}
          configuredChannelId={null}
        />
      }
      editor={
        <>
          {config.sendDirectMessage ? null : <StatusBanner tone="neutral">{NOT_SENT}</StatusBanner>}

          <Section label="Delivery">
            <Rows>
              <SettingRow
                title="Send a DM"
                description="Sent just before Proton acts, while the member is still in the server."
              >
                <Switch
                  label="Send a DM"
                  checked={config.sendDirectMessage}
                  onChange={(next) => form.setValue((c) => ({ ...c, sendDirectMessage: next }))}
                />
              </SettingRow>

              {config.sendDirectMessage ? (
                <SettingRow
                  title="Offer a way back in"
                  description="Add a Rejoin button with your server invite."
                >
                  <Switch
                    label="Offer a way back in"
                    checked={config.offerWayBackIn}
                    onChange={(next) => form.setValue((c) => ({ ...c, offerWayBackIn: next }))}
                  />
                </SettingRow>
              ) : null}

              {config.sendDirectMessage && config.offerWayBackIn ? (
                <SettingRow
                  title="Invite link"
                  description="The server invite behind the Rejoin button. Proton can’t create one for you."
                  stacked
                  error={form.errorAt('inviteUrl')}
                >
                  <TextInput
                    aria-label="Invite link"
                    width="full"
                    placeholder="https://discord.gg/…"
                    maxLength={INVITE_URL_MAX}
                    invalid={form.errorAt('inviteUrl') !== undefined}
                    value={config.inviteUrl ?? ''}
                    onChange={(event) =>
                      form.setValue((c) => ({
                        ...c,
                        inviteUrl: event.currentTarget.value || undefined,
                      }))
                    }
                  />
                </SettingRow>
              ) : null}
            </Rows>
          </Section>

          <Section
            label="Layout"
            note={`${countV2Components(config.dmLayout.v2)} / ${V2_COMPONENTS_MAX} components`}
          >
            {layoutError !== undefined ? (
              <p className="row-error honeypot-layout-error">{layoutError}</p>
            ) : null}

            <p className="section-intro">{PLACEHOLDERS}</p>

            <LayoutBuilder
              guildId={guildId}
              surface={HONEYPOT_DM_SURFACE}
              diagnosticsAt={form.templateDiagnosticsAt}
              value={config.dmLayout.v2}
              errors={errors}
              prefix="dmLayout.v2"
              onChange={(next) =>
                form.setValue((c) => ({ ...c, dmLayout: { ...c.dmLayout, v2: next } }))
              }
            />
          </Section>
        </>
      }
      preview={
        <div className="stack stack-10">
          <DiscordPreview
            message={{ v2: preview.v2 ?? [] }}
            mentionNames={preview.mentionNames}
            now={preview.now}
            empty={preview.v2 === null ? REFUSED : EMPTY}
          />
          <p className="text-xs text-muted">{preview.caption}</p>
          {preview.builtIn ? <p className="field-warning">{BUILT_IN}</p> : null}
          <p className="text-xs text-muted">
            {dmOffersAppeal(config) ? APPEAL_ADDRESS : APPEAL_FROM_ESCALATION}
          </p>
          {form.view.tier === 'free' ? <p className="text-xs text-muted">{FREE_TIER}</p> : null}
        </div>
      }
    />
  );
}
