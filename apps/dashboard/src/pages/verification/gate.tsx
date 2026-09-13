import { tryParseDuration } from '@proton/core';
import type {
  CaptchaDelivery,
  VerificationConfig,
  VerificationFailureAction,
  VerificationMode,
} from '@proton/module-verification/config';
import type { ReactElement, ReactNode } from 'react';
import { DurationInput } from '../../components/discord/inputs.tsx';
import { RolePicker } from '../../components/discord/role-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { NumberStepper, SegmentedControl, Select, Switch } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';

const QUARANTINE_ANCHOR = 'verification-quarantine-role';

const DURATION_INVALID =
  'must be a number followed by s, m, h, d or w — for example 30m, 12h or 7d';

// gate.ts:78-84, without the clause naming the member who joined: no member is in scope here.
const UNGATED =
  'This server has "Apply the unverified role on join" switched off, so a member who joins ' +
  'without the unverified role is NOT gated. The invite they used does not grant the role — add ' +
  'it under Server Settings → Invites, or turn the setting back on.';

// failure.ts:66-76, trimmed at the sentence that points back at this page.
const QUARANTINE_UNSET =
  'Verification is set to quarantine members who run out of attempts, but no quarantine role is ' +
  'chosen, so Proton cannot act on them.';

// What pressing the panel button actually does in each mode — interactions.ts:123-132, and for
// website the link's own lifetime from panel.ts:109-110. Nothing on this page configures the
// website flow, so the mode itself has to say what it does.
const MODE_EXPLAINS: Record<VerificationMode, string> = {
  button: 'Members are verified as soon as they press the button.',
  captcha: 'Members read a code from an image and type it in.',
  website:
    'Members get a private link to sign in with Discord. The link stops working after 15 minutes.',
};

const QUARANTINE_EXPLAINS =
  '/quarantine add removes a member’s other roles and gives them this one. /quarantine remove ' +
  'gives their roles back.';

const MODE_LABEL = 'Verification method';
const APPLY_ON_JOIN_LABEL = 'Apply the unverified role on join';
const CAPTCHA_DELIVERY_LABEL = 'Send captcha';
const FAILURE_ACTION_LABEL = 'Action';
const QUARANTINE_ROLE_LABEL = 'Quarantine role';

type RolePath = 'unverifiedRoleId' | 'verifiedRoleId' | 'quarantineRoleId';
type NumberPath = 'captchaLength' | 'captchaAttempts';
type DurationPath = 'captchaExpiry' | 'failureTimeout';

interface AreaProps {
  guildId: string;
  form: ModuleForm<VerificationConfig>;
  enabled: boolean;
}

function RoleRow({
  guildId,
  form,
  path,
  label,
  description,
  word,
  title,
  note,
}: {
  guildId: string;
  form: ModuleForm<VerificationConfig>;
  path: RolePath;
  label: string;
  description?: string | undefined;
  word: string;
  title?: ReactNode;
  note?: ReactNode;
}): ReactElement {
  const value = form.value[path] ?? null;

  const error =
    value === guildId
      ? `The ${word} role is set to @everyone, which Discord does not let anyone add or remove.`
      : form.errorAt(path);

  return (
    <SettingRow title={title ?? label} description={description} error={error} note={note}>
      <RolePicker
        guildId={guildId}
        label={label}
        invalid={error !== undefined}
        value={value}
        onChange={(next) => form.set(path, next ?? undefined)}
      />
    </SettingRow>
  );
}

function NumberRow({
  form,
  path,
  label,
  min,
  max,
}: {
  form: ModuleForm<VerificationConfig>;
  path: NumberPath;
  label: string;
  min: number;
  max: number;
}): ReactElement {
  // Read through get(), not value[path]: an emptied stepper writes null, and the row has to say so
  // rather than render the stale number the type promises.
  const raw = form.get(path);
  const value = typeof raw === 'number' ? raw : null;

  const error = value === null ? `Enter a number between ${min} and ${max}.` : form.errorAt(path);

  return (
    <SettingRow title={label} error={error}>
      <NumberStepper
        value={value}
        min={min}
        max={max}
        label={label}
        invalid={error !== undefined}
        onChange={(next) => form.set(path, next)}
      />
    </SettingRow>
  );
}

function DurationRow({
  form,
  path,
  label,
  description,
}: {
  form: ModuleForm<VerificationConfig>;
  path: DurationPath;
  label: string;
  description?: string | undefined;
}): ReactElement {
  const value = form.value[path];
  const error = tryParseDuration(value) === null ? DURATION_INVALID : form.errorAt(path);

  return (
    <SettingRow title={label} description={description} error={error}>
      <DurationInput
        value={value}
        label={label}
        invalid={error !== undefined}
        onChange={(next) => form.set(path, next)}
      />
    </SettingRow>
  );
}

export function GateArea({ guildId, form, enabled }: AreaProps): ReactElement {
  const config = form.value;
  const captcha = config.mode === 'captcha';
  const quarantineUnset = config.failureAction === 'quarantine' && !config.quarantineRoleId;

  return (
    <>
      <Section label="Access">
        <Rows>
          <SettingRow title={MODE_LABEL} description={MODE_EXPLAINS[config.mode]} stacked>
            <SegmentedControl
              label={MODE_LABEL}
              value={config.mode}
              options={[
                { value: 'button', label: 'Press a button' },
                { value: 'captcha', label: 'Solve a captcha' },
                { value: 'website', label: 'Sign in on Proton’s website' },
              ]}
              onChange={(next) => form.set('mode', next)}
            />
          </SettingRow>

          <RoleRow
            guildId={guildId}
            form={form}
            path="unverifiedRoleId"
            label="Unverified role"
            description="Removed when a member verifies. Until Proton adds it, new members briefly have full access."
            word="unverified"
          />

          <RoleRow
            guildId={guildId}
            form={form}
            path="verifiedRoleId"
            label="Member role"
            word="member"
          />

          <SettingRow
            title={APPLY_ON_JOIN_LABEL}
            note={enabled && !config.applyUnverifiedOnJoin ? UNGATED : undefined}
          >
            <Switch
              checked={config.applyUnverifiedOnJoin}
              label={APPLY_ON_JOIN_LABEL}
              onChange={(next) => form.set('applyUnverifiedOnJoin', next)}
            />
          </SettingRow>
        </Rows>
      </Section>

      {captcha ? (
        <Section label="Captcha">
          <Rows>
            <SettingRow
              title={CAPTCHA_DELIVERY_LABEL}
              description="Members with DMs closed always get it in the channel."
            >
              <Select
                aria-label={CAPTCHA_DELIVERY_LABEL}
                className="verification-select-wide"
                options={[
                  { value: 'channel', label: 'Privately in the channel' },
                  { value: 'dm', label: 'By direct message' },
                ]}
                value={config.captchaDelivery}
                onChange={(value) => form.set('captchaDelivery', value as CaptchaDelivery)}
              />
            </SettingRow>

            <NumberRow form={form} path="captchaLength" label="Characters" min={4} max={8} />
            <NumberRow
              form={form}
              path="captchaAttempts"
              label="Attempts allowed"
              min={1}
              max={5}
            />
            <DurationRow form={form} path="captchaExpiry" label="Expires after" />
          </Rows>
        </Section>
      ) : null}

      {captcha ? (
        <Section label="Response">
          <Rows>
            <SettingRow
              title={FAILURE_ACTION_LABEL}
              description="What Proton does when a member runs out of attempts."
              error={quarantineUnset ? QUARANTINE_UNSET : form.errorAt('failureAction')}
            >
              <div className="stack stack-6">
                <Select
                  aria-label={FAILURE_ACTION_LABEL}
                  width="lg"
                  invalid={quarantineUnset}
                  options={[
                    { value: 'none', label: 'Nothing — let them try again' },
                    { value: 'kick', label: 'Kick' },
                    { value: 'ban', label: 'Ban' },
                    { value: 'timeout', label: 'Timeout' },
                    { value: 'quarantine', label: 'Add quarantine role' },
                  ]}
                  value={config.failureAction}
                  onChange={(value) =>
                    form.set('failureAction', value as VerificationFailureAction)
                  }
                />
                {quarantineUnset ? (
                  <a href={`#${QUARANTINE_ANCHOR}`} className="button button-ghost button-sm">
                    Choose quarantine role
                  </a>
                ) : null}
              </div>
            </SettingRow>

            {config.failureAction === 'timeout' ? (
              <DurationRow
                form={form}
                path="failureTimeout"
                label="Timeout duration"
                description="Discord caps timeouts at 28 days."
              />
            ) : null}
          </Rows>
        </Section>
      ) : null}

      <Section label="Quarantine">
        <Rows>
          <RoleRow
            guildId={guildId}
            form={form}
            path="quarantineRoleId"
            label={QUARANTINE_ROLE_LABEL}
            word="quarantine"
            title={<span id={QUARANTINE_ANCHOR}>{QUARANTINE_ROLE_LABEL}</span>}
            note={QUARANTINE_EXPLAINS}
          />
        </Rows>
      </Section>
    </>
  );
}
