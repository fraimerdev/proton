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
import { Badge, NumberStepper, Select } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Panel, Rows, Section, SettingRow } from '../components/ui/layout.tsx';
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

const RESPONSE_ACTIVE: Record<RaidResponse, string> = {
  verify: 'gives them the verification role',
  quarantine: 'quarantines them for moderators to review',
  kick: 'kicks them',
};

const ROLE_UNSET: Record<'verify' | 'quarantine', string> = {
  verify:
    'No verification role is set, so Proton cannot act on flagged members. Set one, or choose an ' +
    'action that needs no role.',
  quarantine:
    'No quarantine role is set, so Proton cannot act on flagged members. Set one, or choose an ' +
    'action that needs no role.',
};

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

interface ScoreTerm {
  label: string;
  weight: number;
}

function pathTerms(profile: JoinProfile, brandNewAge: string, newAge: string): ScoreTerm[] {
  const terms: ScoreTerm[] = [];

  if (profile.burst) terms.push({ label: 'During a raid', weight: SIGNAL_WEIGHTS.joinBurst });

  if (profile.age === 'brandNew') {
    terms.push({
      label: `Account under ${brandNewAge} old`,
      weight: SIGNAL_WEIGHTS.brandNewAccount,
    });
  } else if (profile.age === 'new') {
    terms.push({ label: `Account under ${newAge} old`, weight: SIGNAL_WEIGHTS.newAccount });
  }

  if (profile.avatarless) terms.push({ label: 'No avatar', weight: SIGNAL_WEIGHTS.avatarless });

  return terms;
}

const profileKey = (profile: JoinProfile): string =>
  `${profile.burst}-${profile.age}-${profile.avatarless}`;

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
      ? `must not be longer than the new-account age (${config.newAccountAge}) — brand-new ` +
        'accounts are a subset of new ones, and the heavier score belongs to the younger set'
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
        guildId={guildId}
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}

        {!enabled ? (
          <StatusBanner tone="neutral">
            {meta.label} is switched off. Settings are saved, but nothing runs until you switch it
            on.
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      <Section label="Detection">
        <Panel className="antiraid-rule">
          <p className="antiraid-rule-line">
            Proton treats it as a raid when <strong>{config.joinThreshold}</strong> members join
            within <strong>{humaniseDuration(config.joinWindow)}</strong>. Each new member is scored
            out of {MAX_JOIN_SCORE}. At <strong>{config.scoreThreshold}</strong> or higher, Proton{' '}
            {RESPONSE_ACTIVE[config.response]}.
          </p>

          {agesOrdered ? (
            <>
              <p className="antiraid-paths-label">Ways to reach {config.scoreThreshold}</p>

              <ul className="antiraid-paths">
                {paths.map((profile) => (
                  <li className="antiraid-path" key={profileKey(profile)}>
                    <span className="antiraid-path-terms">
                      {pathTerms(profile, brandNewAge, newAge).map((term, index) => (
                        <span className="antiraid-term" key={term.label}>
                          {index > 0 ? <span className="antiraid-term-plus">+</span> : null}
                          {term.label}
                          <span className="antiraid-term-weight">{term.weight}</span>
                        </span>
                      ))}
                    </span>

                    {profile.burst ? null : <Badge tone="warning">No raid needed</Badge>}

                    <span className="antiraid-path-total">
                      <span className="antiraid-path-equals">=</span>
                      {profileScore(profile)}
                    </span>
                  </li>
                ))}
              </ul>

              {burstOnly ? (
                <p className="antiraid-rule-note">
                  No member can reach {config.scoreThreshold} outside a raid, so Proton only acts
                  during one.
                </p>
              ) : null}
            </>
          ) : (
            <p className="antiraid-rule-note antiraid-rule-note-warning">
              {ageConflict !== undefined
                ? `Brand-new account age ${ageConflict}.`
                : 'One of the account ages is not a valid duration, so Proton cannot score new members.'}{' '}
              Fix them below.
            </p>
          )}

          <p className="antiraid-rule-note">
            Bots are never screened. If an account’s age or avatar cannot be read, Proton scores the
            member without that signal instead of guessing.
          </p>
        </Panel>

        <Rows>
          <SettingRow
            title="Join rate"
            description={`How many joins within the window count as a raid. Members who join during a raid score ${SIGNAL_WEIGHTS.joinBurst}.`}
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

          <SettingRow
            title="Score to act"
            description={`The minimum is ${MIN_ACTIONABLE_SCORE}, so one signal alone is never enough.`}
            error={form.errorAt('scoreThreshold')}
          >
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
        intro={`Members who score ${config.scoreThreshold} or higher are ${RESPONSE_OUTCOMES[config.response]}, even outside a raid.`}
      >
        <Rows>
          <SettingRow
            title="Action"
            description="What Proton does to members who reach the score to act."
            error={form.errorAt('response')}
          >
            <Select
              aria-label="Action"
              width="lg"
              options={RESPONSE_OPTIONS}
              invalid={form.errorAt('response') !== undefined}
              value={config.response}
              onChange={(event) =>
                form.setValue((current) => ({
                  ...current,
                  response: event.currentTarget.value as RaidResponse,
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
        intro="Proton posts one alert when a raid starts, and no more until the join window has passed."
      >
        <Rows>
          <SettingRow
            title="Alert channel"
            error={form.errorAt('alertChannelId')}
            note={
              config.alertChannelId === undefined
                ? 'No alert channel is set, so raids are recorded only in Proton’s logs.'
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

      <SaveBar dirty={form.dirty} saving={form.saving} onSave={form.save} onReset={form.reset} />
    </>
  );
}
