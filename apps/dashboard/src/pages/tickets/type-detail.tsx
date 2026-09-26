import {
  type ContainerChild,
  formatComponentEmoji,
  parseComponentEmoji,
  tryParseDuration,
  type V2Component,
} from '@proton/core';
import {
  CATEGORY_CHANNEL_TYPE,
  PRIORITY_LABELS,
  staffRolesFor,
  TEXT_CHANNEL_TYPE,
  type TicketsConfig,
  type TicketType,
} from '@proton/module-tickets/config';
import { TICKET_NAME_SURFACE, TICKET_WELCOME_SURFACE } from '@proton/module-tickets/placeholders';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { EmojiPicker } from '../../components/discord/emoji-picker.tsx';
import { DurationInput } from '../../components/discord/inputs.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { RoleMultiPicker, RoleName } from '../../components/discord/role-picker.tsx';
import { PlaceholderSuggestions } from '../../components/placeholders/placeholder-suggestions.tsx';
import { TemplateDiagnostics } from '../../components/placeholders/template-diagnostics.tsx';
import {
  Button,
  Chip,
  IconButton,
  NumberStepper,
  Select,
  Switch,
  TextArea,
  TextInput,
} from '../../components/ui/controls.tsx';
import { Spinner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { rolesQuery } from '../../lib/queries.ts';
import { FormBuilder } from './form-builder.tsx';
import {
  answerPlaceholders,
  CLAIM_MODE_OPTIONS,
  modalFields,
  namePreview,
  namesEachTicket,
  openingPreview,
  opensAModal,
  PRIORITY_OPTIONS,
  SAMPLE_TICKET_NUMBER,
  sampleAnswer,
  TICKET_ACCENT,
  type TicketsForm,
  TRANSCRIPT_OPTIONS,
  updateTypeAt,
  useTemplateField,
  useTicketTemplates,
} from './shape.ts';

const NAME_MAX = 64;
const EMOJI_MAX = 64;
const DESCRIPTION_MAX = 100;
const NAME_PATTERN_MAX = 100;
const WELCOME_MAX = 2000;
const STAFF_ROLES_MAX = 20;

const ID_FIXED = 'The ID can’t be changed.';

const ID_HELP = 'Posted panels and tickets already opened refer to this ticket type by its ID.';

const DESCRIPTION_NOTE = 'Shown under the name in dropdown panels. Button panels don’t show it.';

const ARCHIVE_NOTE = 'Closed ticket channels move here when Archive on close is on.';

const NO_DELETE_NOTE =
  'With no duration, closed ticket channels are kept. They move to the archive category only if ' +
  'Archive on close is on.';

const NO_PLACEHOLDER =
  'Without the ticket number or the member in it, such as {ticket.number} or {user.username}, ' +
  'every ticket of this type gets the same channel name.';

const RESOLVED_ROLES = 'All staff roles for this ticket type:';

const MENTION_HELP =
  'Proton pings them in a separate message, because mentions inside the opening message don’t ' +
  'notify anyone.';

const PER_TYPE_LIMIT =
  'Applies on top of the limit in Settings, and counts only tickets of this type.';

const PRIORITY_SLOT =
  'Asking for priority uses one of Discord’s 5 form slots, so the form can show 4 other questions.';

const NO_MODAL = 'No form is shown, so the ticket opens straight away.';

const CLAIM_RESTRICT =
  'Only the staff member who claimed a ticket can use its controls until they hand it over.';

const CLAIM_RESTRICT_HELP =
  'Members with Manage Channels or Manage Server can still use the controls and unclaim the ticket.';

const NO_REOPEN = 'Closed tickets of this type show Transcript and Delete, but no Reopen.';

const RATING_DESCRIPTION =
  'After a ticket closes, Proton asks the member to rate the help from 1 to 5.';

const RATING_HELP =
  'Proton asks by DM, or in the ticket channel if the member’s DMs are closed. The wording can’t ' +
  'be changed.';

const WARN_NOTE = 'Only sent while the ticket is waiting on the member, not on staff.';

const WARN_TOO_LATE = 'The warning wouldn’t arrive before the ticket closes.';

const AUTO_CLOSE_DESCRIPTION = 'Close tickets that have been quiet for this long.';

const TIMERS_HELP =
  'Auto-close and the inactivity warning count from the last message in the ticket, so a new ' +
  'message restarts both.';

const CLOSE_REQUEST_NOTE = 'If the member doesn’t answer in time, Proton closes the ticket.';

const CAPTURE_DESCRIPTION =
  'Save every message sent in these tickets so transcripts include them. Saved messages are ' +
  'deleted after 30 days.';

const CAPTURE_HELP =
  'Without it, transcripts still list participants, form answers and events, but no messages.';

function OptionalDuration({
  label,
  value,
  seed,
  invalid,
  onChange,
}: {
  label: string;
  value: string | undefined;
  seed: string;
  invalid?: boolean | undefined;
  onChange: (value: string | undefined) => void;
}): ReactElement {
  if (value === undefined) {
    return (
      <Button size="sm" icon="alarm" onClick={() => onChange(seed)}>
        Set duration
      </Button>
    );
  }

  return (
    <span className="inline inline-6">
      <DurationInput label={label} value={value} invalid={invalid} onChange={onChange} />
      <IconButton
        icon="x"
        tone="ghost"
        size="sm"
        label={`Clear ${label}`}
        onClick={() => onChange(undefined)}
      />
    </span>
  );
}

function welcomePreview(config: TicketsConfig, type: TicketType, opening: string): V2Component[] {
  const staff = staffRolesFor(config, type)
    .map((roleId) => `<@&${roleId}>`)
    .join(' ');

  const children: ContainerChild[] = [
    { kind: 'text', content: `## Ticket #${SAMPLE_TICKET_NUMBER}` },
    { kind: 'text', content: opening },
    { kind: 'separator', divider: true, spacing: 'small' },
    {
      kind: 'text',
      content:
        `**Type**\n${type.name}\n\n**Priority**\n${PRIORITY_LABELS[type.defaultPriority]}` +
        (staff ? `\n\n**Who can see this**\nYou and ${staff}` : ''),
    },
  ];

  const asked = modalFields(type);

  if (asked.length > 0) {
    children.push(
      { kind: 'separator', divider: true, spacing: 'small' },
      {
        kind: 'text',
        content: asked
          .map((field) => `**${field.label || 'Untitled question'}**\n${sampleAnswer(field)}`)
          .join('\n\n'),
      },
    );
  }

  children.push({ kind: 'separator', divider: false, spacing: 'small' });

  const buttons = [
    { key: 'close', style: 'danger' as const, label: 'Close' },
    ...(type.claimMode === 'off'
      ? []
      : [{ key: 'claim', style: 'success' as const, label: 'Claim' }]),
    { key: 'add', style: 'secondary' as const, label: 'Add member' },
    { key: 'opts', style: 'secondary' as const, label: 'Options' },
  ];

  children.push({ kind: 'row', row: { kind: 'buttons', buttons } });

  return [{ kind: 'container', accentColor: TICKET_ACCENT, children }];
}

export function TypeDetail({
  form,
  guildId,
  type,
  index,
}: {
  form: TicketsForm;
  guildId: string;
  type: TicketType;
  index: number;
}): ReactElement {
  const config = form.value;
  const path = `types.${index}`;

  const { data: roles, isPending: rolesPending } = useQuery(rolesQuery(guildId));
  const roleById = new Map((roles ?? []).map((role) => [role.id, role]));
  const resolvedStaff = staffRolesFor(config, type);

  const pattern = type.namePattern ?? config.namePattern;
  const sample = namePreview(`${path}.namePattern`, pattern, type.name);
  const patternMissesPlaceholder =
    type.namePattern !== undefined && !namesEachTicket(type.namePattern);

  const closeMs = tryParseDuration(type.autoCloseAfter ?? '');
  const warnMs = tryParseDuration(type.inactivityWarnAfter ?? '');
  const warnTooLate = closeMs !== null && warnMs !== null && warnMs >= closeMs;

  const archiveInstead = type.autoDeleteAfter === undefined && type.archiveCategoryId !== undefined;

  const patch = (change: Partial<TicketType>): void => updateTypeAt(form, index, change);

  const report = useTicketTemplates(form);
  const answers = useMemo(() => answerPlaceholders([type]), [type]);

  const setNamePattern = (next: string): void =>
    patch({ namePattern: next === '' ? undefined : next });

  const namePattern = useTemplateField({
    surface: TICKET_NAME_SURFACE,
    report,
    path: `${path}.namePattern`,
    onChange: setNamePattern,
    error: form.errorAt(`${path}.namePattern`),
  });

  const opening = useTemplateField({
    surface: TICKET_WELCOME_SURFACE,
    report,
    path: `${path}.welcomeMessage`,
    onChange: (welcomeMessage) => patch({ welcomeMessage }),
    error: form.errorAt(`${path}.welcomeMessage`),
    dynamic: answers,
  });

  const openingSample = openingPreview(type, index);

  return (
    <>
      <Section label="Details">
        <Rows>
          <SettingRow title="ID" note={ID_FIXED} help={ID_HELP}>
            <Chip className="mono">{type.id}</Chip>
          </SettingRow>

          <SettingRow title="Name" error={form.errorAt(`${path}.name`)}>
            <TextInput
              width="md"
              aria-label="Name"
              maxLength={NAME_MAX}
              invalid={form.errorAt(`${path}.name`) !== undefined}
              value={type.name}
              onChange={(event) => patch({ name: event.currentTarget.value })}
            />
          </SettingRow>

          <SettingRow
            title="Emoji"
            description="Shown on this ticket type’s button, or beside it in a dropdown."
            error={form.errorAt(`${path}.emoji`)}
          >
            <EmojiPicker
              guildId={guildId}
              label="Emoji"
              value={parseComponentEmoji(type.emoji)}
              onChange={(next) => {
                const written = next === null ? '' : formatComponentEmoji(next);
                patch({ emoji: written === '' ? undefined : written.slice(0, EMOJI_MAX) });
              }}
            />
          </SettingRow>

          <SettingRow title="Description" note={DESCRIPTION_NOTE}>
            <TextInput
              width="lg"
              aria-label="Description"
              maxLength={DESCRIPTION_MAX}
              value={type.description ?? ''}
              onChange={(event) =>
                patch({
                  description:
                    event.currentTarget.value === '' ? undefined : event.currentTarget.value,
                })
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Channel">
        <Rows>
          <SettingRow
            title="Category"
            description="Where new ticket channels are created."
            error={form.errorAt(`${path}.categoryId`)}
          >
            <ChannelPicker
              guildId={guildId}
              label="Category"
              noneLabel="No category"
              placeholder="No category"
              types={[CATEGORY_CHANNEL_TYPE]}
              value={type.categoryId ?? null}
              onChange={(next) => patch({ categoryId: next ?? undefined })}
            />
          </SettingRow>

          <SettingRow
            title="Archive category"
            note={ARCHIVE_NOTE}
            error={form.errorAt(`${path}.archiveCategoryId`)}
          >
            <ChannelPicker
              guildId={guildId}
              label="Archive category"
              noneLabel="No archive category"
              placeholder="No archive category"
              types={[CATEGORY_CHANNEL_TYPE]}
              value={type.archiveCategoryId ?? null}
              onChange={(next) => patch({ archiveCategoryId: next ?? undefined })}
            />
          </SettingRow>

          <SettingRow
            title="Name pattern"
            description={`Leave empty to use the default pattern, ${config.namePattern}.`}
            error={namePattern.error}
            note={
              <>
                {patternMissesPlaceholder ? (
                  <span className="text-warning">{NO_PLACEHOLDER} </span>
                ) : null}
                {sample.caption}. Channel: <span className="mono">#{sample.text}</span>
              </>
            }
          >
            <div className="message-field tickets-name-field">
              <TextInput
                {...namePattern.autocomplete.field}
                width="md"
                aria-label="Name pattern"
                aria-describedby={namePattern.describedBy}
                spellCheck={false}
                placeholder={config.namePattern}
                maxLength={NAME_PATTERN_MAX}
                invalid={namePattern.invalid}
                value={type.namePattern ?? ''}
                onChange={(event) => setNamePattern(event.currentTarget.value)}
              />
              <PlaceholderSuggestions autocomplete={namePattern.autocomplete} />
              <TemplateDiagnostics
                id={namePattern.diagnosticsId}
                diagnostics={namePattern.diagnostics}
                autocomplete={namePattern.autocomplete}
              />
            </div>
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Staff">
        <Rows>
          <SettingRow
            title="Extra staff roles"
            description="Roles that can see and handle these tickets, on top of the staff roles in Settings."
            error={form.errorAt(`${path}.staffRoleIds`)}
            note={
              resolvedStaff.length === 0
                ? 'No staff roles apply to this ticket type, so only the member who opens a ticket can see it.'
                : undefined
            }
            stacked
          >
            <div className="stack stack-8">
              <RoleMultiPicker
                guildId={guildId}
                label="Extra staff roles"
                max={STAFF_ROLES_MAX}
                value={type.staffRoleIds}
                onChange={(next) => patch({ staffRoleIds: next })}
              />
              {resolvedStaff.length > 0 ? (
                <div className="stack stack-4">
                  <span className="text-xs text-muted">{RESOLVED_ROLES}</span>
                  <span className="inline inline-6 inline-wrap">
                    {rolesPending ? (
                      <Spinner label="Loading roles" />
                    ) : (
                      resolvedStaff.map((roleId) => (
                        <RoleName key={roleId} role={roleById.get(roleId)} id={roleId} />
                      ))
                    )}
                  </span>
                </div>
              ) : null}
            </div>
          </SettingRow>

          {resolvedStaff.length > 0 ? (
            <SettingRow
              title="Ping staff roles"
              description="Ping this type’s staff roles when a ticket opens."
              help={MENTION_HELP}
            >
              <Switch
                label="Ping staff roles"
                checked={type.mentionStaffOnOpen}
                onChange={(next) => patch({ mentionStaffOnOpen: next })}
              />
            </SettingRow>
          ) : null}
        </Rows>
      </Section>

      <Section label="Opening">
        <div className="editor tickets-opening">
          <div className="editor-main">
            <Rows>
              <SettingRow
                title="Opening message"
                description="Posted in the new ticket channel."
                error={opening.error}
                stacked
              >
                <div className="message-field grow">
                  <TextArea
                    {...opening.autocomplete.field}
                    aria-label="Opening message"
                    aria-describedby={opening.describedBy}
                    rows={6}
                    maxLength={WELCOME_MAX}
                    invalid={opening.invalid}
                    value={type.welcomeMessage}
                    onChange={(event) => patch({ welcomeMessage: event.currentTarget.value })}
                  />
                  <PlaceholderSuggestions autocomplete={opening.autocomplete} />
                  <TemplateDiagnostics
                    id={opening.diagnosticsId}
                    diagnostics={opening.diagnostics}
                    autocomplete={opening.autocomplete}
                  />
                </div>
              </SettingRow>

              <SettingRow
                title="Ask for priority"
                note={type.askPriority ? PRIORITY_SLOT : undefined}
              >
                <Switch
                  label="Ask for priority"
                  checked={type.askPriority}
                  onChange={(next) => patch({ askPriority: next })}
                />
              </SettingRow>
            </Rows>
          </div>

          <div className="editor-preview">
            <div className="editor-preview-head">
              <span className="editor-preview-title">In the ticket channel</span>
            </div>
            <DiscordPreview
              message={{ v2: welcomePreview(config, type, openingSample.text) }}
              mentionNames={openingSample.mentionNames}
              now={openingSample.now}
            />
            <p className="tickets-preview-note">{openingSample.caption}</p>
          </div>
        </div>

        <FormBuilder form={form} type={type} index={index} />

        {!opensAModal(type) ? <p className="tickets-foot-note">{NO_MODAL}</p> : null}
      </Section>

      <Section label="Limits">
        <Rows>
          <SettingRow
            title="Default priority"
            description="The priority a ticket starts with when the member isn’t asked."
          >
            <Select
              width="md"
              aria-label="Default priority"
              options={PRIORITY_OPTIONS}
              value={type.defaultPriority}
              onChange={(value) =>
                patch({ defaultPriority: value as TicketType['defaultPriority'] })
              }
            />
          </SettingRow>

          <SettingRow
            title="Open tickets per member"
            description="How many tickets of this type a member can have open at once."
            help={PER_TYPE_LIMIT}
            error={form.errorAt(`${path}.maxOpenPerUser`)}
          >
            <NumberStepper
              label="Open tickets per member"
              min={1}
              max={100}
              value={type.maxOpenPerUser ?? null}
              onChange={(next) => patch({ maxOpenPerUser: next ?? undefined })}
            />
          </SettingRow>

          <SettingRow
            title="Creation cooldown"
            description={`Leave unset to use the default cooldown, ${config.creationCooldown}.`}
            error={form.errorAt(`${path}.cooldown`)}
          >
            <OptionalDuration
              label="Creation cooldown"
              seed={config.creationCooldown}
              value={type.cooldown}
              invalid={form.errorAt(`${path}.cooldown`) !== undefined}
              onChange={(next) => patch({ cooldown: next })}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Lifecycle">
        <Rows>
          <SettingRow title="Claim mode" description="Choose how staff can claim tickets.">
            <Select
              width="lg"
              aria-label="Claim mode"
              options={CLAIM_MODE_OPTIONS}
              value={type.claimMode}
              onChange={(value) => patch({ claimMode: value as TicketType['claimMode'] })}
            />
          </SettingRow>

          {type.claimMode !== 'off' ? (
            <SettingRow
              title="Limit controls to claimer"
              description={CLAIM_RESTRICT}
              help={CLAIM_RESTRICT_HELP}
            >
              <Switch
                label="Limit controls to claimer"
                checked={type.claimRestrictsReplies}
                onChange={(next) => patch({ claimRestrictsReplies: next })}
              />
            </SettingRow>
          ) : null}

          <SettingRow
            title="Ask before closing"
            description="When staff press Close, the ticket’s owner must confirm first. /ticket close doesn’t ask."
          >
            <Switch
              label="Ask before closing"
              checked={type.closeRequiresConfirmation}
              onChange={(next) => patch({ closeRequiresConfirmation: next })}
            />
          </SettingRow>

          {type.closeRequiresConfirmation ? (
            <SettingRow
              title="Close if unanswered after"
              note={type.closeRequestExpiresAfter === undefined ? undefined : CLOSE_REQUEST_NOTE}
              error={form.errorAt(`${path}.closeRequestExpiresAfter`)}
            >
              <OptionalDuration
                label="Close if unanswered after"
                seed="1d"
                value={type.closeRequestExpiresAfter}
                invalid={form.errorAt(`${path}.closeRequestExpiresAfter`) !== undefined}
                onChange={(next) => patch({ closeRequestExpiresAfter: next })}
              />
            </SettingRow>
          ) : null}

          <SettingRow title="Allow reopening" note={type.reopenEnabled ? undefined : NO_REOPEN}>
            <Switch
              label="Allow reopening"
              checked={type.reopenEnabled}
              onChange={(next) => patch({ reopenEnabled: next })}
            />
          </SettingRow>

          <SettingRow
            title="Archive on close"
            description="Move the channel into the archive category when the ticket closes."
          >
            <Switch
              label="Archive on close"
              checked={type.archiveOnClose}
              onChange={(next) => patch({ archiveOnClose: next })}
            />
          </SettingRow>

          <SettingRow title="Ask for a rating" description={RATING_DESCRIPTION} help={RATING_HELP}>
            <Switch
              label="Ask for a rating"
              checked={type.askRating}
              onChange={(next) => patch({ askRating: next })}
            />
          </SettingRow>

          <SettingRow
            title="Auto-close after"
            description={AUTO_CLOSE_DESCRIPTION}
            help={TIMERS_HELP}
            error={form.errorAt(`${path}.autoCloseAfter`)}
          >
            <OptionalDuration
              label="Auto-close after"
              seed="3d"
              value={type.autoCloseAfter}
              invalid={form.errorAt(`${path}.autoCloseAfter`) !== undefined}
              onChange={(next) => patch({ autoCloseAfter: next })}
            />
          </SettingRow>

          <SettingRow
            title="Inactivity warning after"
            error={form.errorAt(`${path}.inactivityWarnAfter`)}
            note={
              <>
                {warnTooLate ? <span className="text-warning">{WARN_TOO_LATE} </span> : null}
                {WARN_NOTE}
              </>
            }
          >
            <OptionalDuration
              label="Inactivity warning after"
              seed="1d"
              value={type.inactivityWarnAfter}
              invalid={form.errorAt(`${path}.inactivityWarnAfter`) !== undefined}
              onChange={(next) => patch({ inactivityWarnAfter: next })}
            />
          </SettingRow>

          <SettingRow
            title="Delete after closing"
            note={archiveInstead ? NO_DELETE_NOTE : undefined}
            error={form.errorAt(`${path}.autoDeleteAfter`)}
          >
            <OptionalDuration
              label="Delete after closing"
              seed="7d"
              value={type.autoDeleteAfter}
              invalid={form.errorAt(`${path}.autoDeleteAfter`) !== undefined}
              onChange={(next) => patch({ autoDeleteAfter: next })}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Transcripts">
        <Rows>
          <SettingRow title="Transcript">
            <Select
              width="lg"
              aria-label="Transcript"
              options={TRANSCRIPT_OPTIONS}
              value={type.transcript}
              onChange={(value) => patch({ transcript: value as TicketType['transcript'] })}
            />
          </SettingRow>

          {type.transcript === 'channel' || type.transcript === 'both' ? (
            <SettingRow
              title="Transcript channel"
              description={
                config.transcriptChannelId === undefined
                  ? 'No default transcript channel is set, so no transcript is posted to a channel unless you choose one here.'
                  : undefined
              }
              error={form.errorAt(`${path}.transcriptChannelId`)}
            >
              <ChannelPicker
                guildId={guildId}
                label="Transcript channel"
                noneLabel="Use default"
                placeholder="Use default"
                types={[TEXT_CHANNEL_TYPE]}
                value={type.transcriptChannelId ?? null}
                onChange={(next) => patch({ transcriptChannelId: next ?? undefined })}
              />
            </SettingRow>
          ) : null}

          <SettingRow
            title="Capture messages"
            description={CAPTURE_DESCRIPTION}
            help={CAPTURE_HELP}
          >
            <Switch
              label="Capture messages"
              checked={type.captureMessages}
              onChange={(next) => patch({ captureMessages: next })}
            />
          </SettingRow>
        </Rows>
      </Section>
    </>
  );
}
