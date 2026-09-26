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

const HOLDING_COLLAPSED = 'The first timeout is skipped with this action.';

const ACTION_NONE =
  'Nothing is done to the member, but the DM, message deletion, incident log, counter and block ' +
  'still happen.';

const WAIT_HELP =
  'More messages from the same member don’t extend the wait. If they leave or are banned first, ' +
  'the action is cancelled.';

const OVER_28_DAYS = 'Discord caps timeouts at 28 days.';

const REASON_HELP = 'Also used as the reason on the member’s case, and on their block.';

function overLongTimeout(value: string): boolean {
  const ms = tryParseDuration(value);
  return ms !== null && ms > MAX_TIMEOUT_MS;
}

export function ConsequencesArea({ form }: { form: HoneypotForm }): ReactElement {
  const config = form.value;
  const patch = (fields: Partial<HoneypotConfig>): void =>
    form.setValue((current) => ({ ...current, ...fields }));

  return (
    <Section label="Enforcement">
      <Rows>
        <SettingRow
          title="Action"
          error={form.errorAt('action')}
          note={config.action === 'none' ? ACTION_NONE : undefined}
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
          description="How long to wait after a member triggers Honeypot. Leave at 0 to act at once."
          help={WAIT_HELP}
          error={form.errorAt('waitBeforeActingSeconds')}
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
          stacked
          help={REASON_HELP}
          error={form.errorAt('auditLogReason')}
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
  );
}
