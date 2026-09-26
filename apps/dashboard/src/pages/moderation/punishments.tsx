import { SAMPLE_NOW } from '@proton/core/placeholders';
import type { PunishDirection, PunishKind } from '@proton/module-moderation/config';
import {
  AUDIT_REASON_SURFACE,
  type AuditedDirection,
  renderAuditReasonTemplate,
} from '@proton/module-moderation/placeholders';
import type { ReactElement } from 'react';
import { useId, useState } from 'react';
import { DurationInput } from '../../components/discord/inputs.tsx';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import { PlaceholderSuggestions } from '../../components/placeholders/placeholder-suggestions.tsx';
import {
  TemplateDiagnostics,
  visibleDiagnostics,
} from '../../components/placeholders/template-diagnostics.tsx';
import { usePlaceholderAutocomplete } from '../../components/placeholders/use-placeholder-autocomplete.ts';
import {
  Button,
  NumberStepper,
  SegmentedControl,
  Switch,
  TextArea,
  TextInput,
} from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { SegmentedTabs } from '../../components/ui/tabs.tsx';
import type { ModerationForm, Problems } from './punish-shape.ts';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const TIMEOUT_CAP_MS = 28 * DAY_MS;
const DURATION_MAX_MS = 365 * DAY_MS;
const REASON_MAX = 512;
const ROLES_MAX = 25;
const BAN_DELETE_MIN = 0;
const BAN_DELETE_MAX = 7;
const NEW_BAN_LENGTH = '7d';

const BAN_LENGTH_PATH = 'punish.types.ban.defaultDuration';
const BAN_DELETE_PATH = 'punish.types.ban.deleteMessageDays';
const TIMEOUT_LENGTH_PATH = 'punish.types.timeout.defaultDuration';
const RECENT_WINDOW_PATH = 'punish.confirmRecentCase.window';

const TABS = [
  { id: 'ban', label: 'Ban' },
  { id: 'kick', label: 'Kick' },
  { id: 'timeout', label: 'Timeout' },
  { id: 'warn', label: 'Warn' },
] as const satisfies readonly { id: PunishKind; label: string }[];

const COVERS: Readonly<Record<PunishKind, readonly PunishDirection[]>> = {
  ban: ['ban', 'unban'],
  kick: ['kick'],
  timeout: ['timeout', 'untimeout'],
  warn: ['warn', 'unwarn'],
};

const PROOF =
  'Deletes the member’s message when you punish from a message or accept a message report. ' +
  'A copy stays on the case for 30 days.';

const PUNISH_AUTHOR_OFF =
  'Discord still lists Punish author under Apps, and moderators who use it are told it’s off. ' +
  'To hide it, turn it off on the Commands page.';

const HISTORY_PRIVACY =
  'While on, Proton holds members’ recent messages for up to an hour, and cases keep them for ' +
  '30 days.';

const HISTORY_HELP =
  'Up to 5 messages per member in each channel are held, and deleted ones for 30 minutes. The ' +
  'message a member is punished from is kept on the case for 30 days either way.';

const LENGTH_OPTIONS = [
  { value: 'permanent', label: 'Permanent' },
  { value: 'temporary', label: 'Temporary' },
] as const;

interface AreaProps {
  guildId: string;
  form: ModerationForm;
  problems: Problems;
}

function broken(problems: Problems, kind: PunishKind): boolean {
  return COVERS[kind].some((direction) =>
    problems.paths.some((path) => path.startsWith(`punish.types.${direction}.`)),
  );
}

function auditSample(template: string, durationMs: number | null): string {
  const sample = AUDIT_REASON_SURFACE.samples[0];
  if (sample === undefined) return '';

  return renderAuditReasonTemplate(template, { ...sample.facts, durationMs }, SAMPLE_NOW);
}

function RequireReasonRow({
  form,
  problems,
  direction,
  label,
  description,
}: Omit<AreaProps, 'guildId'> & {
  direction: PunishDirection;
  label: string;
  description: string;
}): ReactElement {
  const path = `punish.types.${direction}.forceReason`;

  return (
    <SettingRow title="Require a reason" description={description} error={problems.at(path)}>
      <Switch
        label={label}
        checked={form.value.punish.types[direction].forceReason}
        onChange={(next) => form.set(path, next)}
      />
    </SettingRow>
  );
}

function DefaultReasonRow({
  form,
  problems,
  direction,
  label,
  description,
}: Omit<AreaProps, 'guildId'> & {
  direction: PunishDirection;
  label: string;
  description: string;
}): ReactElement {
  const path = `punish.types.${direction}.defaultReason`;
  const error = problems.at(path);

  return (
    <SettingRow stacked title="Default reason" description={description} error={error}>
      <TextInput
        width="full"
        aria-label={label}
        placeholder="No reason"
        maxLength={REASON_MAX}
        invalid={error !== undefined}
        value={form.value.punish.types[direction].defaultReason}
        onChange={(event) => form.set(path, event.currentTarget.value)}
      />
    </SettingRow>
  );
}

function AuditReasonRow({
  form,
  problems,
  direction,
  label,
  description,
  sampleDurationMs,
}: Omit<AreaProps, 'guildId'> & {
  direction: AuditedDirection;
  label: string;
  description: string;
  sampleDurationMs: number | null;
}): ReactElement {
  const id = useId();
  const path = `punish.types.${direction}.auditReason`;
  const value = form.value.punish.types[direction].auditReason;
  const change = (next: string): void => form.set(path, next);

  const autocomplete = usePlaceholderAutocomplete({
    surface: AUDIT_REASON_SURFACE,
    path,
    onChange: change,
  });

  const diagnostics = form.templateDiagnosticsAt(path);
  const error = problems.at(path);
  const explained = error !== undefined && diagnostics.some(({ message }) => message === error);
  const listed = visibleDiagnostics(diagnostics, autocomplete.pending).shown.length > 0;
  const sample = auditSample(value, sampleDurationMs);

  return (
    <SettingRow
      stacked
      title="Audit-log reason"
      description={description}
      error={explained ? undefined : error}
    >
      <div className="message-field wide">
        <TextArea
          {...autocomplete.field}
          rows={2}
          spellCheck={false}
          aria-label={label}
          aria-describedby={listed ? id : undefined}
          maxLength={REASON_MAX}
          invalid={error !== undefined}
          value={value}
          onChange={(event) => change(event.currentTarget.value)}
        />
        <PlaceholderSuggestions autocomplete={autocomplete} />
        {listed ? (
          <TemplateDiagnostics id={id} diagnostics={diagnostics} autocomplete={autocomplete} />
        ) : null}
        <p className="field-hint">
          {sample === '' ? (
            'Sample: the audit log shows no reason.'
          ) : (
            <>
              Sample: <span className="mono">{sample}</span>
            </>
          )}
        </p>
      </div>
    </SettingRow>
  );
}

function ReviewRows({
  form,
  problems,
  kind,
  label,
  description,
}: Omit<AreaProps, 'guildId'> & {
  kind: PunishKind;
  label: string;
  description: string;
}): ReactElement {
  const reviewPath = `punish.types.${kind}.alwaysReview`;
  const proofPath = `punish.types.${kind}.deleteProof`;
  const settings = form.value.punish.types[kind];

  return (
    <Rows>
      <SettingRow title="Always review" description={description} error={problems.at(reviewPath)}>
        <Switch
          label={`Always review ${label}`}
          checked={settings.alwaysReview}
          onChange={(next) => form.set(reviewPath, next)}
        />
      </SettingRow>

      <SettingRow title="Delete proof message" description={PROOF} error={problems.at(proofPath)}>
        <Switch
          label={`Delete the proof message on ${label}`}
          checked={settings.deleteProof}
          onChange={(next) => form.set(proofPath, next)}
        />
      </SettingRow>
    </Rows>
  );
}

function RoleActionRows({
  guildId,
  form,
  problems,
  direction,
  addDescription,
  removeDescription,
}: AreaProps & {
  direction: 'timeout' | 'untimeout' | 'warn' | 'unwarn';
  addDescription: string;
  removeDescription: string;
}): ReactElement {
  const base = `punish.types.${direction}.actions`;
  const actions = form.value.punish.types[direction].actions;
  const addError = problems.at(`${base}.addRoleIds`);
  const removeError = problems.at(`${base}.removeRoleIds`);

  return (
    <>
      <SettingRow stacked title="Add roles" description={addDescription} error={addError}>
        <RoleMultiPicker
          guildId={guildId}
          label="Add a role to give"
          value={actions.addRoleIds}
          max={ROLES_MAX}
          requireAssignable
          invalid={addError !== undefined}
          onChange={(next) => form.set(`${base}.addRoleIds`, next)}
        />
      </SettingRow>

      <SettingRow stacked title="Remove roles" description={removeDescription} error={removeError}>
        <RoleMultiPicker
          guildId={guildId}
          label="Add a role to take away"
          value={actions.removeRoleIds}
          max={ROLES_MAX}
          requireAssignable
          invalid={removeError !== undefined}
          onChange={(next) => form.set(`${base}.removeRoleIds`, next)}
        />
      </SettingRow>
    </>
  );
}

function DisconnectRow({
  form,
  problems,
  kind,
  description,
}: Omit<AreaProps, 'guildId'> & {
  kind: 'timeout' | 'warn';
  description: string;
}): ReactElement {
  const path = `punish.types.${kind}.actions.disconnectVoice`;

  return (
    <SettingRow title="Disconnect from voice" description={description} error={problems.at(path)}>
      <Switch
        label="Disconnect from voice"
        checked={form.value.punish.types[kind].actions.disconnectVoice}
        onChange={(next) => form.set(path, next)}
      />
    </SettingRow>
  );
}

function BanSettings({ form, problems }: AreaProps): ReactElement {
  const { ban, unban } = form.value.punish.types;
  const lengthError = problems.at(BAN_LENGTH_PATH);
  const deleteError = problems.at(BAN_DELETE_PATH);
  const length = ban.defaultDuration;

  return (
    <>
      <Section label="When punishing">
        <Rows>
          <RequireReasonRow
            form={form}
            problems={problems}
            direction="ban"
            label="Require a reason to ban"
            description="A moderator who bans without a reason is refused, and nothing is done."
          />
          {ban.forceReason ? null : (
            <DefaultReasonRow
              form={form}
              problems={problems}
              direction="ban"
              label="Default ban reason"
              description="Used when a moderator bans without a reason."
            />
          )}
          <AuditReasonRow
            form={form}
            problems={problems}
            direction="ban"
            label="Ban audit-log reason"
            description="What Discord’s audit log shows for the ban. Type { to add a placeholder, like {moderator.username}: {punishment.reason}."
            sampleDurationMs={length === null ? null : HOUR_MS}
          />
        </Rows>

        <Rows>
          <SettingRow
            title="Default length"
            description="Used when /ban add is run without a duration. A temporary ban is lifted when it ends."
            error={length === null ? lengthError : undefined}
          >
            <SegmentedControl
              label="Default ban length"
              options={LENGTH_OPTIONS}
              value={length === null ? 'permanent' : 'temporary'}
              onChange={(next) =>
                form.set(BAN_LENGTH_PATH, next === 'permanent' ? null : (length ?? NEW_BAN_LENGTH))
              }
            />
          </SettingRow>

          {length === null ? null : (
            <SettingRow title="Ban lasts" error={lengthError}>
              <DurationInput
                label="Ban lasts"
                value={length}
                max={DURATION_MAX_MS}
                invalid={lengthError !== undefined}
                onChange={(next) => form.set(BAN_LENGTH_PATH, next)}
              />
            </SettingRow>
          )}

          <SettingRow
            title="Delete messages on ban"
            description="How many days of the member’s messages a ban deletes when the moderator doesn’t choose. Discord allows at most 7 days."
            error={deleteError}
          >
            <NumberStepper
              label="Delete messages on ban"
              value={ban.deleteMessageDays}
              min={BAN_DELETE_MIN}
              max={BAN_DELETE_MAX}
              unit="days"
              width={140}
              invalid={deleteError !== undefined}
              onChange={(next) => form.set(BAN_DELETE_PATH, next ?? ban.deleteMessageDays)}
            />
          </SettingRow>
        </Rows>

        <ReviewRows
          form={form}
          problems={problems}
          kind="ban"
          label="bans"
          description="Opens a form for the moderator to check the reason and length before a ban goes through."
        />
      </Section>

      <Section label="When lifting">
        <Rows>
          <RequireReasonRow
            form={form}
            problems={problems}
            direction="unban"
            label="Require a reason to unban"
            description="A moderator who unbans without a reason is refused, and nothing is done."
          />
          {unban.forceReason ? null : (
            <DefaultReasonRow
              form={form}
              problems={problems}
              direction="unban"
              label="Default unban reason"
              description="Used when a moderator unbans without a reason."
            />
          )}
          <AuditReasonRow
            form={form}
            problems={problems}
            direction="unban"
            label="Unban audit-log reason"
            description="What Discord’s audit log shows for the unban."
            sampleDurationMs={null}
          />
        </Rows>
      </Section>
    </>
  );
}

function KickSettings({ form, problems }: AreaProps): ReactElement {
  const { kick } = form.value.punish.types;

  return (
    <Section label="When punishing">
      <Rows>
        <RequireReasonRow
          form={form}
          problems={problems}
          direction="kick"
          label="Require a reason to kick"
          description="A moderator who kicks without a reason is refused, and nothing is done."
        />
        {kick.forceReason ? null : (
          <DefaultReasonRow
            form={form}
            problems={problems}
            direction="kick"
            label="Default kick reason"
            description="Used when a moderator kicks without a reason."
          />
        )}
        <AuditReasonRow
          form={form}
          problems={problems}
          direction="kick"
          label="Kick audit-log reason"
          description="What Discord’s audit log shows for the kick. Type { to add a placeholder, like {moderator.username}: {punishment.reason}."
          sampleDurationMs={null}
        />
      </Rows>

      <ReviewRows
        form={form}
        problems={problems}
        kind="kick"
        label="kicks"
        description="Opens a form for the moderator to check the reason before a kick goes through."
      />
    </Section>
  );
}

function TimeoutSettings({ guildId, form, problems }: AreaProps): ReactElement {
  const { timeout, untimeout } = form.value.punish.types;
  const extended = form.value.punish.extendTimeouts;
  const lengthError = problems.at(TIMEOUT_LENGTH_PATH);
  const multiplePath = 'punish.types.timeout.allowMultiple';

  return (
    <>
      <Section label="When punishing">
        <Rows>
          <RequireReasonRow
            form={form}
            problems={problems}
            direction="timeout"
            label="Require a reason to time out"
            description="A moderator who times someone out without a reason is refused, and nothing is done."
          />
          {timeout.forceReason ? null : (
            <DefaultReasonRow
              form={form}
              problems={problems}
              direction="timeout"
              label="Default timeout reason"
              description="Used when a moderator times someone out without a reason."
            />
          )}
          <AuditReasonRow
            form={form}
            problems={problems}
            direction="timeout"
            label="Timeout audit-log reason"
            description="What Discord’s audit log shows for the timeout. Type { to add a placeholder, like {moderator.username}: {punishment.reason}."
            sampleDurationMs={HOUR_MS}
          />
        </Rows>

        <Rows>
          <SettingRow
            title="Default duration"
            description="Used when /timeout add is run without a duration."
            help={
              extended
                ? 'With Extend timeouts on, a timeout can last up to 365 days.'
                : 'Discord caps timeouts at 28 days.'
            }
            error={lengthError}
          >
            <DurationInput
              label="Default timeout duration"
              value={timeout.defaultDuration}
              max={extended ? DURATION_MAX_MS : TIMEOUT_CAP_MS}
              invalid={lengthError !== undefined}
              onChange={(next) => form.set(TIMEOUT_LENGTH_PATH, next)}
            />
          </SettingRow>

          <SettingRow
            title="Multiple timeouts"
            description="A new timeout runs alongside the member’s current one instead of replacing it, and they stay timed out until the last one ends."
            help="Timeouts from Proton count, including warn escalation and AutoMod. One set by hand in Discord is kept, but never renewed or logged."
            error={problems.at(multiplePath)}
          >
            <Switch
              label="Multiple timeouts"
              checked={timeout.allowMultiple}
              onChange={(next) => form.set(multiplePath, next)}
            />
          </SettingRow>
        </Rows>

        <ReviewRows
          form={form}
          problems={problems}
          kind="timeout"
          label="timeouts"
          description="Opens a form for the moderator to check the reason and duration before a timeout goes through."
        />

        <Rows>
          <RoleActionRows
            guildId={guildId}
            form={form}
            problems={problems}
            direction="timeout"
            addDescription="Given to the member when they’re timed out."
            removeDescription="Taken from the member when they’re timed out."
          />
          <DisconnectRow
            form={form}
            problems={problems}
            kind="timeout"
            description="Disconnects the member from voice when they’re timed out. Needs Move Members."
          />
        </Rows>
      </Section>

      <Section label="When lifting">
        <Rows>
          <RequireReasonRow
            form={form}
            problems={problems}
            direction="untimeout"
            label="Require a reason to remove a timeout"
            description="A moderator who removes a timeout without a reason is refused, and nothing is done."
          />
          {untimeout.forceReason ? null : (
            <DefaultReasonRow
              form={form}
              problems={problems}
              direction="untimeout"
              label="Default timeout removal reason"
              description="Used when a moderator removes a timeout without a reason."
            />
          )}
          <AuditReasonRow
            form={form}
            problems={problems}
            direction="untimeout"
            label="Timeout removal audit-log reason"
            description="What Discord’s audit log shows when the timeout is removed."
            sampleDurationMs={null}
          />
        </Rows>

        <Rows>
          <RoleActionRows
            guildId={guildId}
            form={form}
            problems={problems}
            direction="untimeout"
            addDescription="Given to the member when a moderator removes their timeout."
            removeDescription="Taken from the member when a moderator removes their timeout."
          />
        </Rows>
      </Section>
    </>
  );
}

function WarnSettings({ guildId, form, problems }: AreaProps): ReactElement {
  const { warn, unwarn } = form.value.punish.types;

  return (
    <>
      <Section label="When punishing">
        <Rows>
          <RequireReasonRow
            form={form}
            problems={problems}
            direction="warn"
            label="Require a reason to warn"
            description="A moderator who warns without a reason is refused, and nothing is done."
          />
          {warn.forceReason ? null : (
            <DefaultReasonRow
              form={form}
              problems={problems}
              direction="warn"
              label="Default warning reason"
              description="Used when a moderator warns without a reason."
            />
          )}
        </Rows>

        <ReviewRows
          form={form}
          problems={problems}
          kind="warn"
          label="warnings"
          description="Opens a form for the moderator to check the reason before a warning is given."
        />

        <Rows>
          <RoleActionRows
            guildId={guildId}
            form={form}
            problems={problems}
            direction="warn"
            addDescription="Given to the member when they’re warned."
            removeDescription="Taken from the member when they’re warned."
          />
          <DisconnectRow
            form={form}
            problems={problems}
            kind="warn"
            description="Disconnects the member from voice when they’re warned. Needs Move Members."
          />
        </Rows>
      </Section>

      <Section label="When lifting">
        <Rows>
          <RequireReasonRow
            form={form}
            problems={problems}
            direction="unwarn"
            label="Require a reason to remove a warning"
            description="A moderator who removes a warning without a reason is refused, and nothing is done."
          />
          {unwarn.forceReason ? null : (
            <DefaultReasonRow
              form={form}
              problems={problems}
              direction="unwarn"
              label="Default warning removal reason"
              description="Used when a moderator removes a warning without a reason."
            />
          )}
        </Rows>

        <Rows>
          <RoleActionRows
            guildId={guildId}
            form={form}
            problems={problems}
            direction="unwarn"
            addDescription="Given to the member when a moderator removes their warning."
            removeDescription="Taken from the member when a moderator removes their warning."
          />
        </Rows>
      </Section>
    </>
  );
}

function MoreOptions({ form, problems }: Omit<AreaProps, 'guildId'>): ReactElement {
  const punish = form.value.punish;
  const windowError = problems.at(RECENT_WINDOW_PATH);

  return (
    <Section label="More options">
      <Rows>
        <SettingRow
          title="Extend timeouts"
          description="Renews timeouts longer than Discord’s 28-day limit until they end. Only timeouts Proton applied are extended."
          error={problems.at('punish.extendTimeouts')}
        >
          <Switch
            label="Extend timeouts"
            checked={punish.extendTimeouts}
            onChange={(next) => form.set('punish.extendTimeouts', next)}
          />
        </SettingRow>

        <SettingRow
          title="Punish from a message"
          description="Adds Apps → Punish author to messages."
          note={punish.punishFromMessage ? undefined : PUNISH_AUTHOR_OFF}
          error={problems.at('punish.punishFromMessage')}
        >
          <Switch
            label="Punish from a message"
            checked={punish.punishFromMessage}
            onChange={(next) => form.set('punish.punishFromMessage', next)}
          />
        </SettingRow>

        <SettingRow
          title="Confirm when a recent case exists"
          description="Asks the moderator to confirm before punishing a member who already got the same punishment recently."
          error={problems.at('punish.confirmRecentCase.enabled')}
        >
          <Switch
            label="Confirm when a recent case exists"
            checked={punish.confirmRecentCase.enabled}
            onChange={(next) => form.set('punish.confirmRecentCase.enabled', next)}
          />
        </SettingRow>

        {punish.confirmRecentCase.enabled ? (
          <SettingRow
            title="Recent means within"
            description="How far back Proton looks for the same punishment."
            error={windowError}
          >
            <DurationInput
              label="Recent case window"
              value={punish.confirmRecentCase.window}
              invalid={windowError !== undefined}
              onChange={(next) => form.set(RECENT_WINDOW_PATH, next)}
            />
          </SettingRow>
        ) : null}

        <SettingRow
          title="Log expired timeouts when the member left"
          description="Still records the end of a timeout Proton applied when the member has left the server by then."
          error={problems.at('punish.logExpiredWhenAbsent')}
        >
          <Switch
            label="Log expired timeouts when the member left"
            checked={punish.logExpiredWhenAbsent}
            onChange={(next) => form.set('punish.logExpiredWhenAbsent', next)}
          />
        </SettingRow>

        <SettingRow
          title="Keep recent messages for cases"
          description="Attaches the member’s last messages to each case, so moderators can see what led to it."
          note={HISTORY_PRIVACY}
          help={HISTORY_HELP}
          error={problems.at('punish.messageHistory')}
        >
          <Switch
            label="Keep recent messages for cases"
            checked={punish.messageHistory}
            onChange={(next) => form.set('punish.messageHistory', next)}
          />
        </SettingRow>
      </Rows>
    </Section>
  );
}

export function PunishmentsArea({ guildId, form, problems }: AreaProps): ReactElement {
  const [kind, setKind] = useState<PunishKind>(
    () => TABS.find((tab) => broken(problems, tab.id))?.id ?? 'ban',
  );

  const elsewhere = TABS.filter((tab) => tab.id !== kind && broken(problems, tab.id));
  const props = { guildId, form, problems };

  return (
    <>
      <div className="moderation-kinds">
        <SegmentedTabs label="Punishment" items={TABS} value={kind} onChange={setKind} />
      </div>

      {elsewhere.length > 0 ? (
        <div className="moderation-banners">
          {elsewhere.map((tab) => (
            <StatusBanner
              key={tab.id}
              tone="danger"
              actions={
                <Button size="sm" onClick={() => setKind(tab.id)}>
                  Show {tab.label}
                </Button>
              }
            >
              {`A ${tab.label.toLowerCase()} setting needs fixing before you can save.`}
            </StatusBanner>
          ))}
        </div>
      ) : null}

      {kind === 'ban' ? <BanSettings {...props} /> : null}
      {kind === 'kick' ? <KickSettings {...props} /> : null}
      {kind === 'timeout' ? <TimeoutSettings {...props} /> : null}
      {kind === 'warn' ? <WarnSettings {...props} /> : null}

      <MoreOptions form={form} problems={problems} />
    </>
  );
}
