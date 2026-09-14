import { type ModerationConfig, moderationConfigSchema } from '@proton/module-moderation/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { DurationInput, humaniseDuration } from '../components/discord/inputs.tsx';
import { type ModuleForm, useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { ModuleLink } from '../components/module/route.tsx';
import { useModuleToggle } from '../components/module/toggle.ts';
import { NumberStepper, Switch } from '../components/ui/controls.tsx';
import { Spinner, StatusBanner } from '../components/ui/feedback.tsx';
import { NavigationRow, Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { BlockedArea } from './moderation/blocked.tsx';
import { EscalationArea } from './moderation/escalation.tsx';
import { blockedCountQuery, caseCountQuery } from './moderation/queries.ts';

const TIMEOUT_CAP_MS = 28 * 86_400_000;

const BAN_DELETE_MIN = 0;
const BAN_DELETE_MAX = 7;

const SWITCHED_OFF =
  'Moderation is switched off. Settings are saved, but nothing runs until you switch it on. Its ' +
  'commands are not registered and warn escalation does not run.';

// perform.ts, verbatim: what a moderator is told when they leave the reason option empty.
const REASON_REFUSAL =
  'This server requires a reason for moderation actions. Run the command again with the `reason` ' +
  'option filled in.';

const SUB_PAGES: Readonly<Record<string, string>> = {
  blocked: 'Blocked members',
  escalation: 'Warn escalation',
};

const MAIN_VIEW = { area: undefined, q: undefined, page: undefined, id: undefined };

const ERROR_ELSEWHERE = 'A setting under Policy needs fixing before you can save.';

export default function ModerationPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: moderationConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const crumb = SUB_PAGES[area];
  const errorElsewhere =
    crumb !== undefined &&
    [...form.errors.keys()].some((path) => area !== 'escalation' || !path.startsWith('escalation'));

  const enabled = summary?.enabled ?? form.view.enabled;
  const config = form.value;

  return (
    <>
      <ModuleHeader
        meta={meta}
        crumb={crumb}
        backTo={
          crumb !== undefined ? (
            <ModuleLink guildId={guildId} moduleId={meta.id} search={MAIN_VIEW}>
              {meta.label}
            </ModuleLink>
          ) : undefined
        }
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
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}

        {errorElsewhere ? (
          <StatusBanner
            tone="danger"
            actions={
              <ModuleLink
                guildId={guildId}
                moduleId={meta.id}
                search={MAIN_VIEW}
                className="button button-secondary button-sm"
              >
                Open Policy
              </ModuleLink>
            }
          >
            {ERROR_ELSEWHERE}
          </StatusBanner>
        ) : null}

        {!enabled ? <StatusBanner tone="neutral">{SWITCHED_OFF}</StatusBanner> : null}
      </ModuleBanners>

      {area === 'blocked' ? <BlockedArea guildId={guildId} moduleId={meta.id} /> : null}

      {area === 'escalation' ? <EscalationArea form={form} /> : null}

      {crumb === undefined ? (
        <>
          <Destinations guildId={guildId} moduleId={meta.id} />

          <Section label="Policy">
            <Rows>
              <SettingRow
                title="Reply publicly"
                note={
                  config.publicReplies
                    ? undefined
                    : 'Only the moderator who used the command sees the reply.'
                }
                error={form.errorAt('publicReplies')}
              >
                <Switch
                  label="Reply publicly"
                  checked={config.publicReplies}
                  onChange={(next) =>
                    form.setValue((current) => ({ ...current, publicReplies: next }))
                  }
                />
              </SettingRow>

              <SettingRow
                title="Require a reason"
                note={config.requireReason ? REASON_REFUSAL : undefined}
                error={form.errorAt('requireReason')}
              >
                <Switch
                  label="Require a reason"
                  checked={config.requireReason}
                  onChange={(next) =>
                    form.setValue((current) => ({ ...current, requireReason: next }))
                  }
                />
              </SettingRow>

              <SettingRow
                title="Default timeout duration"
                description="Used when /timeout add is run without a duration. Discord caps timeouts at 28 days."
                error={form.errorAt('defaultTimeoutDuration')}
              >
                <DurationInput
                  label="Default timeout duration"
                  value={config.defaultTimeoutDuration}
                  max={TIMEOUT_CAP_MS}
                  invalid={form.errorAt('defaultTimeoutDuration') !== undefined}
                  onChange={(next) =>
                    form.setValue((current) => ({ ...current, defaultTimeoutDuration: next }))
                  }
                />
              </SettingRow>

              <SettingRow
                title="Delete messages on ban"
                description="How many days of messages /ban add deletes when no number is given. Discord allows at most 7 days."
                error={form.errorAt('defaultBanDeleteDays')}
              >
                <NumberStepper
                  label="Delete messages on ban"
                  value={config.defaultBanDeleteDays}
                  min={BAN_DELETE_MIN}
                  max={BAN_DELETE_MAX}
                  invalid={form.errorAt('defaultBanDeleteDays') !== undefined}
                  onChange={(next) => form.set('defaultBanDeleteDays', next)}
                />
              </SettingRow>

              <EscalationRow guildId={guildId} moduleId={meta.id} form={form} />
            </Rows>
          </Section>
        </>
      ) : null}

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

function EscalationRow({
  guildId,
  moduleId,
  form,
}: {
  guildId: string;
  moduleId: string;
  form: ModuleForm<ModerationConfig>;
}): ReactElement {
  const steps = form.value.escalationLadder.length;
  const broken = [...form.errors.keys()].some((path) => path.startsWith('escalation'));

  return (
    <NavigationRow
      guildId={guildId}
      moduleId={moduleId}
      search={{ area: 'escalation' }}
      icon="stairs"
      title="Warn escalation"
      description="Time out, kick or ban members who collect too many warnings."
      aside={
        broken ? (
          <span className="text-danger text-sm">Needs fixing</span>
        ) : (
          <span className="text-muted text-sm">
            {steps === 0
              ? 'No steps'
              : `${steps} ${steps === 1 ? 'step' : 'steps'} within ${humaniseDuration(form.value.escalationWindow)}`}
          </span>
        )
      }
    />
  );
}

function Destinations({ guildId, moduleId }: { guildId: string; moduleId: string }): ReactElement {
  const cases = useQuery(caseCountQuery(guildId));
  const blocked = useQuery(blockedCountQuery(guildId));

  return (
    <Section>
      <Rows>
        <NavigationRow
          guildId={guildId}
          moduleId="cases"
          search={{ area: 'log' }}
          icon="clipboard-text"
          title="Case log"
          description="Every action Proton has recorded, with the moderator and reason."
          aside={
            cases.isPending ? (
              <Spinner label="Loading cases" />
            ) : cases.data ? (
              <span className="text-muted text-sm">
                {cases.data.total === 0
                  ? 'No cases'
                  : `${cases.data.total.toLocaleString('en-US')} ${cases.data.total === 1 ? 'case' : 'cases'}`}
              </span>
            ) : null
          }
        />

        <NavigationRow
          guildId={guildId}
          moduleId={moduleId}
          search={{ area: 'blocked' }}
          icon="prohibit"
          title="Blocked members"
          description="Members who cannot pass verification until their block is lifted."
          aside={
            blocked.isPending ? (
              <Spinner label="Loading blocked members" />
            ) : blocked.data ? (
              <span className="text-muted text-sm">
                {blocked.data.total === 0 ? 'No blocked members' : `${blocked.data.total} blocked`}
              </span>
            ) : null
          }
        />
      </Rows>
    </Section>
  );
}
