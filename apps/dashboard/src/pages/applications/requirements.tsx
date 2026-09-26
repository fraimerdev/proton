import type { FormConfig, Requirements } from '@proton/module-applications/config';
import type {
  Eligibility,
  EligibilityPreview,
  RequirementLine,
} from '@proton/module-applications/view';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { MemberPicker } from '../../components/discord/member-picker.tsx';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import { Badge, NumberStepper, SegmentedControl, Switch } from '../../components/ui/controls.tsx';
import { LoadingArea, StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import type { GuildRole } from '../../lib/discord.ts';
import { readFailure } from '../../lib/errors.ts';
import { modulesQuery, rolesQuery } from '../../lib/queries.ts';
import { eligibilityPreviewQuery } from './admin-queries.ts';
import { type ApplicationsForm, type BadgeTone, updateFormAt } from './shape.ts';

const ROLE_MODES = [
  { value: 'any', label: 'Any of them' },
  { value: 'all', label: 'All of them' },
] as const;

const DAYS_MAX = 3650;

const CHECKED_TWICE =
  'Proton checks these before someone starts and again when they send it. Requirements are part ' +
  'of the published version.';

const SAVED_ONLY = 'Unsaved changes aren’t checked.';

const CHECKED: Readonly<Record<NonNullable<EligibilityPreview['checked']>, string>> = {
  published:
    'Checked against the published requirements, which members are held to right now. Saved ' +
    'changes count once you publish them.',
  saved:
    'Checked against the saved requirements. This form isn’t published yet, so no one can apply ' +
    'to it.',
};

export function checkedNote(checked: EligibilityPreview['checked']): string | null {
  return checked === undefined ? null : CHECKED[checked];
}

const UNSAVED_FORM = 'Save this form first, then check a member against it.';

const LEVELING_OFF =
  'Needs Leveling, which is off. While it’s off, nobody can apply to this form. Turn Leveling on ' +
  'or set this to 0.';

const CASES_OFF =
  'Needs Cases, which is off. While it’s off, nobody can apply to this form. Turn Cases on or ' +
  'turn these off.';

interface Labelled {
  tone: BadgeTone;
  label: string;
}

const ELIGIBILITY_LABEL: Readonly<Record<Eligibility['state'], Labelled>> = {
  eligible: { tone: 'success', label: 'Can apply' },
  ineligible: { tone: 'danger', label: 'Can’t apply' },
  blocked: { tone: 'warning', label: 'Can’t be checked' },
};

function lineBadge(line: RequirementLine): Labelled {
  if (line.passed === true) return { tone: 'success', label: 'Met' };
  if (line.passed === false) return { tone: 'danger', label: 'Not met' };
  return { tone: 'warning', label: 'Not checked' };
}

export function withRoleNames(text: string, roles: readonly GuildRole[] | undefined): string {
  const names = new Map((roles ?? []).map((role) => [role.id, role.name]));
  return text.replace(/<@&(\d+)>/g, (_, id: string) => `@${names.get(id) ?? 'deleted role'}`);
}

function MemberCheck({
  guildId,
  formId,
  saved,
  dirty,
}: {
  guildId: string;
  formId: string;
  saved: boolean;
  dirty: boolean;
}): ReactElement {
  const [userId, setUserId] = useState<string | null>(null);
  const preview = useQuery({
    ...eligibilityPreviewQuery(guildId, formId, userId),
    enabled: userId !== null && saved,
  });
  const roles = useQuery(rolesQuery(guildId));
  const checked = checkedNote(preview.data?.checked);

  return (
    <Section
      label="Check a member"
      intro="See what Proton would tell a member who tried to apply right now."
    >
      <Rows>
        <SettingRow title="Member" note={!saved ? UNSAVED_FORM : dirty ? SAVED_ONLY : undefined}>
          <MemberPicker
            guildId={guildId}
            label="Member to check"
            noneLabel="Nobody"
            value={userId}
            onChange={setUserId}
          />
        </SettingRow>
      </Rows>

      {userId !== null && saved ? (
        <div className="applications-check" aria-live="polite">
          {preview.isPending ? <LoadingArea label="Checking" minHeight={80} size="sm" /> : null}

          {preview.isError ? (
            <StatusBanner tone="danger">
              {readFailure(preview.error, 'that member’s check')}
            </StatusBanner>
          ) : null}

          {preview.data?.member === 'absent' ? (
            <StatusBanner tone="neutral">That member isn’t in this server.</StatusBanner>
          ) : null}

          {preview.data?.member === 'unavailable' ? (
            <StatusBanner tone="warning">
              Proton couldn’t read that member from Discord just now. Try again in a moment.
            </StatusBanner>
          ) : null}

          {preview.data?.eligibility ? (
            <div className="stack stack-8">
              <span className="inline inline-8">
                <Badge tone={ELIGIBILITY_LABEL[preview.data.eligibility.state].tone}>
                  {ELIGIBILITY_LABEL[preview.data.eligibility.state].label}
                </Badge>
                {preview.data.eligibility.lines.length === 0 ? (
                  <span className="text-sm text-secondary">
                    This form has no requirements, so anyone in the server can apply.
                  </span>
                ) : null}
              </span>

              {preview.data.eligibility.lines.length > 0 ? (
                <ul className="applications-lines">
                  {preview.data.eligibility.lines.map((line) => {
                    const badge = lineBadge(line);
                    return (
                      <li key={line.id}>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                        <span>{withRoleNames(line.text, roles.data)}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}

              {preview.data.eligibility.state === 'blocked'
                ? preview.data.eligibility.issues.map((issue) => (
                    <p key={issue.id} className="text-sm text-warning">
                      {issue.humanReason}
                    </p>
                  ))
                : null}

              {checked !== null ? <p className="text-xs text-muted">{checked}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

export function RequirementsTab({
  form,
  guildId,
  index,
  current,
  saved,
}: {
  form: ApplicationsForm;
  guildId: string;
  index: number;
  current: FormConfig;
  saved: boolean;
}): ReactElement {
  const modules = useQuery(modulesQuery(guildId));
  const requirements = current.requirements;
  const path = `forms.${index}.requirements`;

  const moduleOn = (id: string): boolean | undefined =>
    modules.data?.modules.find((module) => module.id === id)?.enabled;

  const levelingOff = moduleOn('leveling') === false;
  const casesOff = moduleOn('cases') === false;
  const usesCases = requirements.noActiveCase || requirements.noRecentCasesDays > 0;

  const set = (patch: Partial<Requirements>): void =>
    updateFormAt(form, index, (value) => ({
      ...value,
      requirements: { ...value.requirements, ...patch },
    }));

  const blockedOverlap = form.errorAt(`${path}.blockedRoleIds`);

  return (
    <>
      <Section label="Who can apply?" intro={CHECKED_TWICE}>
        <Rows>
          <SettingRow
            stacked
            title="Required roles"
            description="Leave empty to let anyone apply."
            error={form.errorAt(`${path}.roleIds`)}
          >
            <div className="stack stack-8">
              <RoleMultiPicker
                guildId={guildId}
                label="Add a required role"
                max={25}
                value={requirements.roleIds}
                onChange={(roleIds) => set({ roleIds })}
              />
              {requirements.roleIds.length > 1 ? (
                <span className="inline inline-8 text-sm text-secondary">
                  Members need
                  <SegmentedControl
                    label="Members need"
                    options={ROLE_MODES}
                    value={requirements.roleMode}
                    onChange={(roleMode) => set({ roleMode })}
                  />
                </span>
              ) : null}
            </div>
          </SettingRow>

          <SettingRow
            stacked
            title="Blocked roles"
            description="Members with any of these can’t apply."
            error={
              blockedOverlap ??
              (requirements.roleIds.some((id) => requirements.blockedRoleIds.includes(id))
                ? 'A role can’t be both required and blocked. Take it out of one of the two lists.'
                : undefined)
            }
          >
            <RoleMultiPicker
              guildId={guildId}
              label="Add a blocked role"
              max={25}
              value={requirements.blockedRoleIds}
              onChange={(blockedRoleIds) => set({ blockedRoleIds })}
            />
          </SettingRow>

          <SettingRow
            title="Account age"
            description="How old their Discord account must be. 0 turns this off."
            error={form.errorAt(`${path}.accountAgeDays`)}
          >
            <NumberStepper
              label="Account age"
              unit="days"
              width={148}
              min={0}
              max={DAYS_MAX}
              value={requirements.accountAgeDays}
              onChange={(next) => set({ accountAgeDays: next ?? 0 })}
            />
          </SettingRow>

          <SettingRow
            title="Time in server"
            description="How long they must have been a member here. 0 turns this off."
            error={form.errorAt(`${path}.memberAgeDays`)}
          >
            <NumberStepper
              label="Time in server"
              unit="days"
              width={148}
              min={0}
              max={DAYS_MAX}
              value={requirements.memberAgeDays}
              onChange={(next) => set({ memberAgeDays: next ?? 0 })}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section
        label="From other modules"
        help="These are filters, not a measure of how suited someone is. Proton never treats data it can’t read as a pass."
      >
        <Rows>
          <SettingRow
            title="Minimum level"
            description="Their Leveling level in this server. 0 turns this off."
            error={
              levelingOff && requirements.minLevel > 0
                ? LEVELING_OFF
                : form.errorAt(`${path}.minLevel`)
            }
            note={levelingOff ? 'Needs Leveling, which is off.' : undefined}
          >
            <NumberStepper
              label="Minimum level"
              width={128}
              min={0}
              max={1000}
              value={requirements.minLevel}
              onChange={(next) => set({ minLevel: next ?? 0 })}
            />
          </SettingRow>

          <SettingRow
            title="No open cases"
            description="Refuse members with an active moderation case here."
            note={casesOff ? 'Needs Cases, which is off.' : undefined}
            error={casesOff && usesCases ? CASES_OFF : undefined}
          >
            <Switch
              label="No open cases"
              checked={requirements.noActiveCase}
              onChange={(noActiveCase) => set({ noActiveCase })}
            />
          </SettingRow>

          <SettingRow
            title="No recent cases"
            description="Refuse members with a case in this many days. 0 turns this off."
            help="Applicants who don’t meet this only see that their moderation history in this server doesn’t meet the form’s requirements."
            note={casesOff ? 'Needs Cases, which is off.' : undefined}
            error={form.errorAt(`${path}.noRecentCasesDays`)}
          >
            <NumberStepper
              label="No recent cases"
              unit="days"
              width={148}
              min={0}
              max={DAYS_MAX}
              value={requirements.noRecentCasesDays}
              onChange={(next) => set({ noRecentCasesDays: next ?? 0 })}
            />
          </SettingRow>
        </Rows>
      </Section>

      <MemberCheck guildId={guildId} formId={current.id} saved={saved} dirty={form.dirty} />
    </>
  );
}
