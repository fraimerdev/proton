import { MAX_TIMEOUT_MS, tryParseDuration } from '@proton/core';
import type { ActiveSeverity, AutomodConfig, Response } from '@proton/module-automod/config';
import { deletesAt, responseFor } from '@proton/module-automod/config';
import type { ReactElement } from 'react';
import { CHANNEL_TYPE, ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { DurationInput } from '../../components/discord/inputs.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import type { SelectOption } from '../../components/ui/controls.tsx';
import { Badge, Select } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { setField, withAlertChannel } from './shape.ts';

type Form = ModuleForm<AutomodConfig>;

const DELETE_OPTIONS: readonly SelectOption[] = [
  { value: 'low', label: 'Low and above' },
  { value: 'medium', label: 'Medium and above' },
  { value: 'high', label: 'High only' },
  { value: 'never', label: 'Never' },
];

const RESPONSE_OPTIONS: readonly SelectOption[] = [
  { value: 'none', label: 'Log only' },
  { value: 'warn', label: 'Warn' },
  { value: 'timeout', label: 'Timeout' },
  { value: 'kick', label: 'Kick' },
  { value: 'ban', label: 'Ban' },
];

const RESPONSE_PERMISSION: Partial<Record<Response, string>> = {
  timeout: 'Needs Timeout Members',
  kick: 'Needs Kick Members',
  ban: 'Needs Ban Members',
};

const RUNGS: readonly {
  severity: ActiveSeverity;
  label: string;
  tone: 'neutral' | 'warning' | 'danger';
}[] = [
  { severity: 'low', label: 'Low', tone: 'neutral' },
  { severity: 'medium', label: 'Medium', tone: 'warning' },
  { severity: 'high', label: 'High', tone: 'danger' },
];

// Verbatim from durationStringSchema, which states it as a predicate on the field's own name.
const DURATION_RULE = 'must be a number followed by s, m, h, d or w — for example 30m, 12h or 7d';

const TIMEOUT_CEILING = 'Discord caps timeouts at 28 days and applies anything longer as 28 days.';

const LOW_TIMEOUT = 'A low severity timeout uses the medium timeout duration.';

function withResponse(
  config: AutomodConfig,
  severity: ActiveSeverity,
  response: Response,
): AutomodConfig {
  if (severity === 'high') return setField(config, 'highResponse', response);
  if (severity === 'medium') return setField(config, 'mediumResponse', response);
  return setField(config, 'lowResponse', response);
}

function Rung({
  severity,
  label,
  tone,
  form,
}: {
  severity: ActiveSeverity;
  label: string;
  tone: 'neutral' | 'warning' | 'danger';
  form: Form;
}): ReactElement {
  const config = form.value;
  const response = responseFor(config, severity);
  const permission = RESPONSE_PERMISSION[response];

  const timeoutField = severity === 'high' ? 'highTimeout' : 'mediumTimeout';
  const timeoutLabel = severity === 'high' ? 'High timeout duration' : 'Medium timeout duration';
  const duration = config[timeoutField];
  const ms = tryParseDuration(duration);

  // Low has no field of its own because respond.ts spends the medium timeout on it, but the value
  // it will spend is still this rung's business, so the warnings below follow the response.
  const usesTimeout = response === 'timeout';
  const tunable = usesTimeout && severity !== 'low';

  return (
    <div>
      <div className="rung">
        <span className="automod-rung-label">
          <Badge tone={tone}>{label}</Badge>
        </span>

        <div className="rung-body">
          <Select
            width="sm"
            aria-label={`${label} severity action`}
            options={RESPONSE_OPTIONS}
            value={response}
            onChange={(value) =>
              form.setValue((current) => withResponse(current, severity, value as Response))
            }
          />

          {tunable ? (
            <>
              <span className="rung-connector">for</span>
              <DurationInput
                label={timeoutLabel}
                value={duration}
                invalid={ms === null}
                onChange={(next) =>
                  form.setValue((current) => setField(current, timeoutField, next))
                }
              />
            </>
          ) : null}

          <span className="rung-connector">·</span>
          <span className="text-sm text-muted">
            {deletesAt(config, severity) ? 'Message deleted' : 'Message left up'}
          </span>
        </div>

        {permission !== undefined ? (
          <div className="rung-aside">
            <Badge tone="neutral" icon="lock">
              {permission}
            </Badge>
          </div>
        ) : null}
      </div>

      {usesTimeout && severity === 'low' ? (
        <p className="automod-rung-note">{LOW_TIMEOUT}</p>
      ) : null}

      {usesTimeout && ms === null ? (
        <p className="automod-rung-note warning">{`${timeoutLabel} ${DURATION_RULE}`}</p>
      ) : null}

      {usesTimeout && ms !== null && ms > MAX_TIMEOUT_MS ? (
        <p className="automod-rung-note warning">{TIMEOUT_CEILING}</p>
      ) : null}
    </div>
  );
}

export function ResponseArea({ form, guildId }: { form: Form; guildId: string }): ReactElement {
  const config = form.value;

  return (
    <>
      <Section label="Messages">
        <Rows>
          <SettingRow
            title="Delete messages"
            description="Delete the matching message, whatever action is taken against the member."
            badge={
              config.deleteFrom !== 'never' ? (
                <Badge tone="neutral" icon="lock">
                  Needs Manage Messages
                </Badge>
              ) : undefined
            }
            error={form.errorAt('deleteFrom')}
          >
            <Select
              width="md"
              aria-label="Delete messages"
              options={DELETE_OPTIONS}
              value={config.deleteFrom}
              onChange={(value) =>
                form.setValue((current) =>
                  setField(current, 'deleteFrom', value as AutomodConfig['deleteFrom']),
                )
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section
        label="Actions"
        intro="Every check uses these actions. Set each check’s severity under Checks."
      >
        <div className="ladder">
          {RUNGS.map((rung) => (
            <Rung
              key={rung.severity}
              severity={rung.severity}
              label={rung.label}
              tone={rung.tone}
              form={form}
            />
          ))}
        </div>

        <p className="automod-note">
          Warnings and timeouts count toward warn escalation in Moderation when it is switched on.
        </p>
      </Section>

      <Section label="Alerts">
        <Rows>
          <SettingRow
            title="Alert channel"
            description="Where Proton reports Automod actions."
            badge={
              config.alertChannelId !== undefined ? (
                <Badge tone="neutral" icon="lock">
                  Needs View Channel and Send Messages there
                </Badge>
              ) : undefined
            }
            note={
              config.alertChannelId !== undefined
                ? 'The Discord AutoMod rules Proton creates also send their alerts here.'
                : undefined
            }
            error={form.errorAt('alertChannelId')}
          >
            <ChannelPicker
              guildId={guildId}
              label="Alert channel"
              noneLabel="No alert channel"
              placeholder="No alert channel"
              types={[
                CHANNEL_TYPE.text,
                CHANNEL_TYPE.announcement,
                CHANNEL_TYPE.publicThread,
                CHANNEL_TYPE.privateThread,
              ]}
              value={config.alertChannelId ?? null}
              onChange={(next) => form.setValue((current) => withAlertChannel(current, next))}
            />
          </SettingRow>
        </Rows>
      </Section>
    </>
  );
}
