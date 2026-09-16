import { formatDuration, MAX_TIMEOUT_MS, tryParseDuration } from '@proton/core';
import {
  AUDIT_REASON_MAX,
  DELETE_SECONDS_MAX,
  describeWindow,
  HONEYPOT_ACTIONS,
  type HoneypotAction,
  type HoneypotConfig,
  WAIT_SECONDS_MAX,
} from '@proton/module-honeypot/config';
import { consequenceOf, purgeSentence } from '@proton/module-honeypot/notice';
import type { ReactElement } from 'react';
import { DurationInput } from '../../components/discord/inputs.tsx';
import { Select, Switch, TextInput } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import type { HoneypotForm } from './shape.ts';

const ACTION_LABELS: Record<HoneypotAction, string> = {
  softban: 'Softban',
  ban: 'Ban',
  kick: 'Kick',
  timeout: 'Timeout',
  warn: 'Warn',
  none: 'Log only',
};

const WINDOWS = [0, 3600, 21_600, 43_200, 86_400, 259_200, DELETE_SECONDS_MAX] as const;

function windowLabel(seconds: number): string {
  const described = describeWindow(seconds);
  return `${described.charAt(0).toUpperCase()}${described.slice(1)}`;
}

function windowOptions(stored: number): { value: string; label: string }[] {
  const values = WINDOWS.includes(stored as (typeof WINDOWS)[number])
    ? [...WINDOWS]
    : [stored, ...WINDOWS];

  return values.map((seconds) => ({ value: String(seconds), label: windowLabel(seconds) }));
}

const HOLDING_COLLAPSED =
  'With this action, the first timeout is skipped. Two timeouts on one member would only ' +
  'overwrite each other.';

const ACTION_NONE =
  'Nothing is done to the member. The direct message, message deletion, incident log, count and ' +
  'block still happen.';

const WAIT_NOTE =
  'Later messages from the same member do not extend the wait. If the member leaves or is banned ' +
  'first, the action is cancelled.';

const OVER_28_DAYS =
  'A timeout cannot be longer than 28 days.';

const REASON_NOTE = 'This is also the reason recorded against a blocked member.';

function overLongTimeout(value: string): boolean {
  const ms = tryParseDuration(value);
  return ms !== null && ms > MAX_TIMEOUT_MS;
}

function actionSentence(config: HoneypotConfig): string {
  const purge =
    (config.action === 'softban' || config.action === 'ban') && config.deleteMessageSeconds > 0
      ? ` Their messages from ${describeWindow(config.deleteMessageSeconds)} are deleted.`
      : '';

  switch (config.action) {
    case 'softban':
      return `The member is banned and immediately unbanned.${purge}`;
    case 'ban':
      return `The member is banned.${purge}`;
    case 'kick':
      return 'The member is kicked.';
    case 'timeout':
      return `The member is timed out for ${config.timeoutDuration}.`;
    case 'warn':
      return 'The member is warned.';
    case 'none':
      return 'Nothing is done to the member.';
  }
}

function sequence(config: HoneypotConfig): string[] {
  const steps: string[] = [];

  const anyExemption =
    config.exemptAdministrators ||
    config.exemptAdminRoleId !== undefined ||
    config.exemptRoleIds.length > 0;

  if (anyExemption) {
    steps.push('Exempt members are logged and counted, and nothing below happens to them.');
  }

  if (config.waitBeforeActingSeconds > 0) {
    steps.push(`Proton waits ${formatDuration(config.waitBeforeActingSeconds * 1000)}.`);
  }

  if (config.sendDirectMessage) {
    steps.push('The direct message is sent while the member is still in the server.');
  }

  if (config.timeoutFirst && config.action !== 'timeout' && config.action !== 'none') {
    steps.push(`The member is timed out for ${config.timeoutFirstDuration} so they stop posting.`);
  }

  steps.push(actionSentence(config));

  if (config.deleteTriggerMessage) steps.push('The message that triggered Honeypot is deleted.');

  steps.push(
    config.logChannelId === undefined
      ? 'Nothing is reported, because no incident log is set.'
      : config.quoteMessage
        ? 'The detection is reported in the incident log, with the message quoted.'
        : 'The detection is reported in the incident log.',
  );

  steps.push('The bait channel’s count goes up.');

  if (config.addToBlacklist) steps.push('The member is blocked.');

  return steps;
}

export function ConsequencesArea({ form }: { form: HoneypotForm }): ReactElement {
  const config = form.value;
  const patch = (fields: Partial<HoneypotConfig>): void =>
    form.setValue((current) => ({ ...current, ...fields }));

  const steps = sequence(config);

  return (
    <>
      <Section label="Enforcement">
        <Rows>
          <SettingRow
            title="Action"
            error={form.errorAt('action')}
            note={
              <>
                {/* The notice template supplies the full stop after {consequence}; the helper does not. */}
                “{consequenceOf(config.action)}.{purgeSentence(config)}” is what the warning tells a
                member.
                {config.action === 'none' ? <> {ACTION_NONE}</> : null}
              </>
            }
          >
            <Select
              aria-label="Action"
              width="md"
              value={config.action}
              options={HONEYPOT_ACTIONS.map((action) => ({
                value: action,
                label: ACTION_LABELS[action],
              }))}
              onChange={(value) => patch({ action: value as HoneypotAction })}
            />
          </SettingRow>

          <SettingRow
            title="Timeout first"
            description="Time out the member before the main action, so they stop posting at once."
            note={
              config.timeoutFirst && (config.action === 'timeout' || config.action === 'none')
                ? HOLDING_COLLAPSED
                : undefined
            }
          >
            <Switch
              label="Timeout first"
              checked={config.timeoutFirst}
              onChange={(next) => patch({ timeoutFirst: next })}
            />
          </SettingRow>

          {config.timeoutFirst ? (
            <SettingRow
              title="First timeout duration"
              error={form.errorAt('timeoutFirstDuration')}
              note={overLongTimeout(config.timeoutFirstDuration) ? OVER_28_DAYS : undefined}
            >
              <DurationInput
                label="First timeout duration"
                value={config.timeoutFirstDuration}
                invalid={form.errorAt('timeoutFirstDuration') !== undefined}
                onChange={(next) => patch({ timeoutFirstDuration: next })}
              />
            </SettingRow>
          ) : null}

          {config.action === 'timeout' ? (
            <SettingRow
              title="Timeout duration"
              error={form.errorAt('timeoutDuration')}
              note={overLongTimeout(config.timeoutDuration) ? OVER_28_DAYS : undefined}
            >
              <DurationInput
                label="Timeout duration"
                value={config.timeoutDuration}
                invalid={form.errorAt('timeoutDuration') !== undefined}
                onChange={(next) => patch({ timeoutDuration: next })}
              />
            </SettingRow>
          ) : null}

          {config.action === 'softban' || config.action === 'ban' ? (
            <SettingRow
              title="Delete messages"
              description="How far back to delete the member’s messages."
              error={form.errorAt('deleteMessageSeconds')}
            >
              <Select
                aria-label="Delete messages"
                width="md"
                value={String(config.deleteMessageSeconds)}
                options={windowOptions(config.deleteMessageSeconds)}
                onChange={(value) => patch({ deleteMessageSeconds: Number(value) })}
              />
            </SettingRow>
          ) : null}

          <SettingRow
            title="Wait before acting"
            description="How long to wait after a member triggers Honeypot. Leave at zero to act immediately."
            error={form.errorAt('waitBeforeActingSeconds')}
            note={config.waitBeforeActingSeconds > 0 ? WAIT_NOTE : undefined}
          >
            <DurationInput
              label="Wait before acting"
              value={formatDuration(config.waitBeforeActingSeconds * 1000)}
              max={WAIT_SECONDS_MAX * 1000}
              invalid={form.errorAt('waitBeforeActingSeconds') !== undefined}
              onChange={(next) => {
                const ms = tryParseDuration(next);
                if (ms !== null) patch({ waitBeforeActingSeconds: Math.floor(ms / 1000) });
              }}
            />
          </SettingRow>

          <SettingRow
            title="Audit log reason"
            description="The reason shown in Discord’s audit log."
            stacked
            error={form.errorAt('auditLogReason')}
            note={REASON_NOTE}
          >
            <TextInput
              aria-label="Audit log reason"
              width="full"
              maxLength={AUDIT_REASON_MAX}
              invalid={form.errorAt('auditLogReason') !== undefined}
              value={config.auditLogReason}
              onChange={(event) => patch({ auditLogReason: event.currentTarget.value })}
            />
          </SettingRow>

          <SettingRow title="Delete trigger message">
            <Switch
              label="Delete trigger message"
              checked={config.deleteTriggerMessage}
              onChange={(next) => patch({ deleteTriggerMessage: next })}
            />
          </SettingRow>
        </Rows>
      </Section>
    </>
  );
}
