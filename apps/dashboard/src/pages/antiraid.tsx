import { tryParseDuration } from '@proton/core';
import {
  antiraidConfigSchema,
  RAID_RESPONSES,
  type RaidResponse,
} from '@proton/module-antiraid/config';
import {
  MAX_JOIN_SCORE,
  MIN_ACTIONABLE_SCORE,
  SIGNAL_WEIGHTS,
} from '@proton/module-antiraid/score';
import { type ReactElement, useMemo } from 'react';
import { ChannelPicker } from '../components/discord/channel-picker.tsx';
import { DurationInput, humaniseDuration } from '../components/discord/inputs.tsx';
import { RolePicker } from '../components/discord/role-picker.tsx';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { NumberStepper, Select } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { ACTION_LABELS } from '../lib/enum-labels.ts';

const JOIN_THRESHOLD_MIN = 2;
const JOIN_THRESHOLD_MAX = 500;

const RESPONSE_OPTIONS = RAID_RESPONSES.map((value) => ({
  value,
  label: ACTION_LABELS[value],
}));

const RESPONSE_OUTCOMES: Record<RaidResponse, string> = {
  verify: 'given the verification role',
  quarantine: 'quarantined for moderators to review',
  kick: 'kicked',
};

const ROLE_UNSET: Record<'verify' | 'quarantine', string> = {
  verify:
    'No verification role is set, so Proton can’t act on flagged members. Set one, or choose an ' +
    'action that doesn’t need a role.',
  quarantine:
    'No quarantine role is set, so Proton can’t act on flagged members. Set one, or choose an ' +
    'action that doesn’t need a role.',
};

const SCORE_HELP =
  `Joining during a raid adds ${SIGNAL_WEIGHTS.joinBurst}, a brand-new account ` +
  `${SIGNAL_WEIGHTS.brandNewAccount}, a new account ${SIGNAL_WEIGHTS.newAccount}, and no avatar ` +
  `${SIGNAL_WEIGHTS.avatarless}. The lowest setting is ${MIN_ACTIONABLE_SCORE}, so one signal ` +
  'alone is never enough.';

const AGE_RANK = { older: 0, new: 1, brandNew: 2 } as const;

type AgeTier = keyof typeof AGE_RANK;

const AGE_TIERS: readonly AgeTier[] = ['older', 'new', 'brandNew'];

const AGE_WEIGHT: Record<AgeTier, number> = {
  older: 0,
  new: SIGNAL_WEIGHTS.newAccount,
  brandNew: SIGNAL_WEIGHTS.brandNewAccount,
};

interface JoinProfile {
  burst: boolean;
  age: AgeTier;
  avatarless: boolean;
}

const ALL_PROFILES: JoinProfile[] = [false, true].flatMap((burst) =>
  AGE_TIERS.flatMap((age) => [false, true].map((avatarless) => ({ burst, age, avatarless }))),
);

function profileScore(profile: JoinProfile): number {
  return (
    (profile.burst ? SIGNAL_WEIGHTS.joinBurst : 0) +
    AGE_WEIGHT[profile.age] +
    (profile.avatarless ? SIGNAL_WEIGHTS.avatarless : 0)
  );
}

function covers(a: JoinProfile, b: JoinProfile): boolean {
  return (
    (!a.burst || b.burst) && AGE_RANK[a.age] <= AGE_RANK[b.age] && (!a.avatarless || b.avatarless)
  );
}

// The minimal qualifying profiles, not every qualifying one: scoring rises with each signal, so
// dropping the profiles that merely add signals to a lighter profile loses no way of reaching the
// threshold. Listing all twelve would repeat the same three rules with extras bolted on.
function minimalPaths(threshold: number): JoinProfile[] {
  const qualifying = ALL_PROFILES.filter((profile) => profileScore(profile) >= threshold);

  return qualifying
    .filter((profile) => !qualifying.some((other) => other !== profile && covers(other, profile)))
    .sort((a, b) => profileScore(a) - profileScore(b) || Number(b.burst) - Number(a.burst));
}

export default function AntiraidPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: antiraidConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;
  const config = form.value;

  const brandNewMs = tryParseDuration(config.brandNewAccountAge);
  const newMs = tryParseDuration(config.newAccountAge);
  const agesOrdered = brandNewMs !== null && newMs !== null && brandNewMs <= newMs;

  const ageConflict =
    brandNewMs !== null && newMs !== null && brandNewMs > newMs
      ? `Brand-new account age can’t be longer than the new account age (${config.newAccountAge}).`
      : undefined;

  const brandNewAge = humaniseDuration(config.brandNewAccountAge);
  const newAge = humaniseDuration(config.newAccountAge);

  const paths = useMemo(() => minimalPaths(config.scoreThreshold), [config.scoreThreshold]);
  const burstOnly = paths.every((profile) => profile.burst);

  const ageError =
    ageConflict ?? form.errorAt('brandNewAccountAge') ?? form.errorAt('newAccountAge');
  const rateError = form.errorAt('joinThreshold') ?? form.errorAt('joinWindow');

  return (
    <>
      <ModuleHeader
        meta={meta}
        actions={
          <ModuleSwitch
            name={meta.label}
            enabled={enabled}
            state={summary ? moduleState(summary) : 'off'}
            busy={toggle.busy}
            onToggle={toggle.toggle}
          />
        }
      />

      <ModuleBanners
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        offNote="Settings are saved, but new members aren’t checked until you turn it on."
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      <Section label="Detection">
        <Rows>
          <SettingRow
            title="Join rate"
            description="How many joins within the window count as a raid."
            stacked
            error={rateError}
          >
            <div className="antiraid-rate">
              <NumberStepper
                label="Joins per window"
                value={config.joinThreshold}
                min={JOIN_THRESHOLD_MIN}
                max={JOIN_THRESHOLD_MAX}
                invalid={form.errorAt('joinThreshold') !== undefined}
                onChange={(next) => form.set('joinThreshold', next)}
              />
              <span className="antiraid-rate-word">joins within</span>
              <DurationInput
                label="Join window"
                value={config.joinWindow}
                invalid={form.errorAt('joinWindow') !== undefined}
                onChange={(next) => form.setValue((current) => ({ ...current, joinWindow: next }))}
              />
            </div>
          </SettingRow>

          <SettingRow
            title="Account age"
            description="Younger accounts score higher. Only the youngest matching band counts."
            stacked
            error={ageError}
          >
            <div className="antiraid-ages">
              <div className="antiraid-age-inputs">
                <span className="antiraid-age-input">
                  <span className="antiraid-age-label">Brand new, under</span>
                  <DurationInput
                    label="Brand-new account age"
                    value={config.brandNewAccountAge}
                    invalid={
                      ageConflict !== undefined || form.errorAt('brandNewAccountAge') !== undefined
                    }
                    onChange={(next) =>
                      form.setValue((current) => ({ ...current, brandNewAccountAge: next }))
                    }
                  />
                </span>

                <span className="antiraid-age-input">
                  <span className="antiraid-age-label">New, under</span>
                  <DurationInput
                    label="New account age"
                    value={config.newAccountAge}
                    invalid={form.errorAt('newAccountAge') !== undefined}
                    onChange={(next) =>
                      form.setValue((current) => ({ ...current, newAccountAge: next }))
                    }
                  />
                </span>
              </div>

              {agesOrdered ? (
                <div className="antiraid-band">
                  <span className="antiraid-band-seg antiraid-band-heavy">
                    <span className="antiraid-band-range">under {brandNewAge}</span>
                    <span className="antiraid-band-weight">
                      {SIGNAL_WEIGHTS.brandNewAccount} brand new
                    </span>
                  </span>

                  <span
                    className={`antiraid-band-seg antiraid-band-light${
                      brandNewMs === newMs ? ' antiraid-band-void' : ''
                    }`}
                  >
                    <span className="antiraid-band-range">
                      {brandNewMs === newMs
                        ? 'no account lands here'
                        : `${brandNewAge} to ${newAge}`}
                    </span>
                    <span className="antiraid-band-weight">{SIGNAL_WEIGHTS.newAccount} new</span>
                  </span>

                  <span className="antiraid-band-seg">
                    <span className="antiraid-band-range">{newAge} or older</span>
                    <span className="antiraid-band-weight">0 established</span>
                  </span>
                </div>
              ) : null}
            </div>
          </SettingRow>

          <SettingRow title="Score to act" help={SCORE_HELP} error={form.errorAt('scoreThreshold')}>
            <NumberStepper
              label="Score to act"
              value={config.scoreThreshold}
              min={MIN_ACTIONABLE_SCORE}
              max={MAX_JOIN_SCORE}
              unit={`/ ${MAX_JOIN_SCORE}`}
              width={132}
              invalid={form.errorAt('scoreThreshold') !== undefined}
              onChange={(next) => form.set('scoreThreshold', next)}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section
        label="Response"
        intro={`Members who score ${config.scoreThreshold} or higher are ${RESPONSE_OUTCOMES[config.response]}${burstOnly ? '' : ', even outside a raid'}.`}
      >
        <Rows>
          <SettingRow title="Action" error={form.errorAt('response')}>
            <Select
              aria-label="Action"
              width="lg"
              options={RESPONSE_OPTIONS}
              invalid={form.errorAt('response') !== undefined}
              value={config.response}
              onChange={(value) =>
                form.setValue((current) => ({
                  ...current,
                  response: value as RaidResponse,
                }))
              }
            />
          </SettingRow>

          {config.response === 'verify' ? (
            <SettingRow
              title="Verification role"
              description="Given to flagged members. It restricts nothing unless its permissions deny access."
              error={form.errorAt('verificationRoleId')}
              note={
                config.verificationRoleId === undefined ? (
                  <span className="text-warning">{ROLE_UNSET.verify}</span>
                ) : undefined
              }
            >
              <RolePicker
                guildId={guildId}
                label="Verification role"
                noneLabel="No role"
                invalid={form.errorAt('verificationRoleId') !== undefined}
                value={config.verificationRoleId ?? null}
                onChange={(next) =>
                  form.setValue((current) => ({
                    ...current,
                    verificationRoleId: next ?? undefined,
                  }))
                }
              />
            </SettingRow>
          ) : null}

          {config.response === 'quarantine' ? (
            <SettingRow
              title="Quarantine role"
              description="Given to flagged members. It stays until a moderator removes it."
              error={form.errorAt('quarantineRoleId')}
              note={
                config.quarantineRoleId === undefined ? (
                  <span className="text-warning">{ROLE_UNSET.quarantine}</span>
                ) : undefined
              }
            >
              <RolePicker
                guildId={guildId}
                label="Quarantine role"
                noneLabel="No role"
                invalid={form.errorAt('quarantineRoleId') !== undefined}
                value={config.quarantineRoleId ?? null}
                onChange={(next) =>
                  form.setValue((current) => ({
                    ...current,
                    quarantineRoleId: next ?? undefined,
                  }))
                }
              />
            </SettingRow>
          ) : null}
        </Rows>
      </Section>

      <Section
        label="Alerts"
        help="Proton posts one alert when a raid starts, and no more until the join window has passed."
      >
        <Rows>
          <SettingRow
            title="Alert channel"
            error={form.errorAt('alertChannelId')}
            note={
              config.alertChannelId === undefined
                ? 'No alert channel is set, so no one is alerted when a raid starts.'
                : undefined
            }
          >
            <ChannelPicker
              guildId={guildId}
              label="Alert channel"
              noneLabel="No alert channel"
              invalid={form.errorAt('alertChannelId') !== undefined}
              value={config.alertChannelId ?? null}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, alertChannelId: next ?? undefined }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        failures={form.failures}
        onSave={form.save}
        onReset={form.reset}
      />
    </>
  );
}
