import { countV2Components, V2_COMPONENTS_MAX } from '@proton/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { EditorPreviewLayout } from '../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { Switch, TextInput } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { guildQuery } from '../../lib/queries.ts';
import { LayoutBuilder } from './layout-builder.tsx';
import { configErrors, dmOffersAppeal, dmPreview, type HoneypotForm } from './shape.ts';

const INVITE_URL_MAX = 512;

const APPEAL_ADDRESS = 'The Appeal button gets a separate link for each caught member.';

const APPEAL_FROM_ESCALATION =
  'The Appeal button comes from the appeal form chosen under Follow-up, and only a ban offers one.';

const NOT_SENT = 'The direct message is switched off. This layout is kept, but nothing is sent.';

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

  const { data: guild } = useQuery(guildQuery(guildId));
  const guildName = guild?.name ?? 'this server';

  return (
    <EditorPreviewLayout
      previewTitle="What the member receives"
      editor={
        <>
          {config.sendDirectMessage ? null : <StatusBanner tone="neutral">{NOT_SENT}</StatusBanner>}

          <Section label="Delivery">
            <Rows>
              <SettingRow
                title="Send a direct message"
                description="Sent just before Proton acts, while the member is still in the server."
              >
                <Switch
                  label="Send a direct message"
                  checked={config.sendDirectMessage}
                  onChange={(next) => form.setValue((c) => ({ ...c, sendDirectMessage: next }))}
                />
              </SettingRow>

              {config.sendDirectMessage ? (
                <SettingRow title="Offer a way back in">
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
                  description="The server invite behind the Rejoin button. Proton cannot create one."
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

            <p className="section-intro">
              <span className="mono">{'{server}'}</span> is replaced with the server name, and{' '}
              <span className="mono">{'{action}'}</span> with what happened to the member. Proton
              adds recovery advice and any buttons below.
            </p>

            <LayoutBuilder
              guildId={guildId}
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
            message={{ v2: dmPreview(config, form.view.tier, guildName) }}
            empty="This layout sends nothing. Discord refuses an empty message."
          />
          <p className="text-xs text-muted">
            {dmOffersAppeal(config) ? APPEAL_ADDRESS : APPEAL_FROM_ESCALATION}
          </p>
          {form.view.tier === 'free' ? <p className="text-xs text-muted">{FREE_TIER}</p> : null}
        </div>
      }
    />
  );
}
