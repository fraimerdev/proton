import { TEXT_CHANNEL_TYPE } from '@proton/module-tickets/config';
import {
  TICKET_BLACKLIST_SURFACE,
  TICKET_CLOSE_SURFACE,
  TICKET_NAME_SURFACE,
} from '@proton/module-tickets/placeholders';
import type { ReactElement } from 'react';
import { ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { DurationInput } from '../../components/discord/inputs.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import { PlaceholderSuggestions } from '../../components/placeholders/placeholder-suggestions.tsx';
import { TemplateDiagnostics } from '../../components/placeholders/template-diagnostics.tsx';
import { NumberStepper, TextArea, TextInput } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { listCeiling } from '../../lib/limits.ts';
import {
  closingPreview,
  namePreview,
  type TicketsForm,
  useTemplateField,
  useTicketTemplates,
} from './shape.ts';

const NAME_PATTERN_MAX = 100;
const CLOSE_CONFIRMATION_MAX = 2000;
const BLACKLIST_MESSAGE_MAX = 500;
const STAFF_ROLES_MAX = 20;

const NO_STAFF_ANYWHERE =
  'No staff roles are set here or on any ticket type, so only the member who opens a ticket can ' +
  'see it.';

const BLACKLIST_NOTE =
  'Shown to blacklisted members when they try to open a ticket. Proton adds the reason and when ' +
  'the block lifts below it. Use /ticket blacklist in Discord to add or remove members.';

export function SettingsArea({
  form,
  guildId,
}: {
  form: TicketsForm;
  guildId: string;
}): ReactElement {
  const config = form.value;
  const tier = form.view.tier;
  const report = useTicketTemplates(form);

  const noStaffAnywhere =
    config.staffRoleIds.length === 0 &&
    config.types.every((type) => type.staffRoleIds.length === 0);

  const perUserCeiling = listCeiling(tier, 'openTicketsPerUser');
  const overPlan = config.maxOpenPerUser > perUserCeiling;

  const setNamePattern = (namePattern: string): void =>
    form.setValue((current) => ({ ...current, namePattern }));

  const setCloseConfirmation = (closeConfirmation: string): void =>
    form.setValue((current) => ({ ...current, closeConfirmation }));

  const setBlacklistMessage = (blacklistMessage: string): void =>
    form.setValue((current) => ({ ...current, blacklistMessage }));

  const name = useTemplateField({
    surface: TICKET_NAME_SURFACE,
    report,
    path: 'namePattern',
    onChange: setNamePattern,
    error: form.errorAt('namePattern'),
  });

  const closing = useTemplateField({
    surface: TICKET_CLOSE_SURFACE,
    report,
    path: 'closeConfirmation',
    onChange: setCloseConfirmation,
    error: form.errorAt('closeConfirmation'),
  });

  const blacklist = useTemplateField({
    surface: TICKET_BLACKLIST_SURFACE,
    report,
    path: 'blacklistMessage',
    onChange: setBlacklistMessage,
    error: form.errorAt('blacklistMessage'),
  });

  const sampleName = namePreview('namePattern', config.namePattern);
  const sampleClosing = closingPreview(config.closeConfirmation);

  return (
    <>
      <Section label="Staff">
        <Rows>
          <SettingRow
            title="Staff roles"
            description="Roles that can access every ticket. Each ticket type can add more."
            error={form.errorAt('staffRoleIds')}
            note={noStaffAnywhere ? NO_STAFF_ANYWHERE : undefined}
            stacked
          >
            <RoleMultiPicker
              guildId={guildId}
              label="Staff roles"
              max={STAFF_ROLES_MAX}
              value={config.staffRoleIds}
              onChange={(next) => form.setValue((current) => ({ ...current, staffRoleIds: next }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Ticket channels">
        <Rows>
          <SettingRow
            title="Name pattern"
            description="How new ticket channels are named. Ticket types can set their own."
            error={name.error}
            note={
              <>
                {sampleName.caption}. Channel: <span className="mono">#{sampleName.text}</span>
              </>
            }
          >
            <div className="message-field">
              <TextInput
                {...name.autocomplete.field}
                width="md"
                aria-label="Name pattern"
                aria-describedby={name.describedBy}
                maxLength={NAME_PATTERN_MAX}
                spellCheck={false}
                invalid={name.invalid}
                value={config.namePattern}
                onChange={(event) => setNamePattern(event.currentTarget.value)}
              />
              <PlaceholderSuggestions autocomplete={name.autocomplete} />
              <TemplateDiagnostics id={name.diagnosticsId} diagnostics={name.diagnostics} />
            </div>
          </SettingRow>

          <SettingRow
            title="Closing message"
            description="Posted in the ticket channel when it closes."
            error={closing.error}
            stacked
          >
            <div className="stack stack-12">
              <div className="message-field">
                <TextArea
                  {...closing.autocomplete.field}
                  aria-label="Closing message"
                  aria-describedby={closing.describedBy}
                  rows={3}
                  maxLength={CLOSE_CONFIRMATION_MAX}
                  invalid={closing.invalid}
                  value={config.closeConfirmation}
                  onChange={(event) => setCloseConfirmation(event.currentTarget.value)}
                />
                <PlaceholderSuggestions autocomplete={closing.autocomplete} />
                <TemplateDiagnostics id={closing.diagnosticsId} diagnostics={closing.diagnostics} />
              </div>

              <div>
                <DiscordPreview
                  message={{ content: sampleClosing.text }}
                  mentionNames={sampleClosing.mentionNames}
                  now={sampleClosing.now}
                />
                <p className="tickets-preview-note">{sampleClosing.caption}</p>
              </div>
            </div>
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Limits">
        <Rows>
          <SettingRow
            title="Open tickets per member"
            description="Ticket types can set a lower limit. Your plan caps this too."
            error={form.errorAt('maxOpenPerUser')}
            note={
              overPlan
                ? `Your plan allows ${perUserCeiling} open tickets per member, so ${perUserCeiling} applies instead of ${config.maxOpenPerUser}.`
                : undefined
            }
          >
            <NumberStepper
              label="Open tickets per member"
              min={1}
              max={100}
              value={config.maxOpenPerUser}
              invalid={form.errorAt('maxOpenPerUser') !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({
                  ...current,
                  maxOpenPerUser: next ?? current.maxOpenPerUser,
                }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Total open tickets"
            description="How many tickets can be open at once. Discord allows up to 500 channels in a server."
            error={form.errorAt('maxOpenPerGuild')}
          >
            <NumberStepper
              label="Total open tickets"
              min={1}
              max={500}
              value={config.maxOpenPerGuild}
              invalid={form.errorAt('maxOpenPerGuild') !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({
                  ...current,
                  maxOpenPerGuild: next ?? current.maxOpenPerGuild,
                }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Creation cooldown"
            description="How long a member must wait before opening another ticket."
            error={form.errorAt('creationCooldown')}
          >
            <DurationInput
              label="Creation cooldown"
              value={config.creationCooldown}
              invalid={form.errorAt('creationCooldown') !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, creationCooldown: next }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Blacklist message"
            error={blacklist.error}
            note={BLACKLIST_NOTE}
            stacked
          >
            <div className="message-field">
              <TextArea
                {...blacklist.autocomplete.field}
                aria-label="Blacklist message"
                aria-describedby={blacklist.describedBy}
                rows={2}
                maxLength={BLACKLIST_MESSAGE_MAX}
                invalid={blacklist.invalid}
                value={config.blacklistMessage}
                onChange={(event) => setBlacklistMessage(event.currentTarget.value)}
              />
              <PlaceholderSuggestions autocomplete={blacklist.autocomplete} />
              <TemplateDiagnostics
                id={blacklist.diagnosticsId}
                diagnostics={blacklist.diagnostics}
              />
            </div>
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Logs and transcripts">
        <Rows>
          <SettingRow
            title="Log channel"
            description="Where Proton logs when tickets are opened, claimed, closed and deleted."
            error={form.errorAt('logChannelId')}
          >
            <ChannelPicker
              guildId={guildId}
              label="Log channel"
              noneLabel="No log channel"
              placeholder="No log channel"
              types={[TEXT_CHANNEL_TYPE]}
              value={config.logChannelId ?? null}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, logChannelId: next ?? undefined }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Transcript channel"
            description="Where Proton posts ticket transcripts. Ticket types can set their own."
            error={form.errorAt('transcriptChannelId')}
          >
            <ChannelPicker
              guildId={guildId}
              label="Transcript channel"
              noneLabel="No transcript channel"
              placeholder="No transcript channel"
              types={[TEXT_CHANNEL_TYPE]}
              value={config.transcriptChannelId ?? null}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, transcriptChannelId: next ?? undefined }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>
    </>
  );
}
