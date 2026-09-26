import { type ModerationConfig, moderationConfigSchema } from '@proton/module-moderation/config';
import { moderationTemplates } from '@proton/module-moderation/placeholders';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { humaniseDuration } from '../components/discord/inputs.tsx';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { ModuleLink } from '../components/module/route.tsx';
import { useModuleToggle } from '../components/module/toggle.ts';
import { Switch } from '../components/ui/controls.tsx';
import { Spinner, StatusBanner } from '../components/ui/feedback.tsx';
import { NavigationRow, Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { useReplyOverrideNote } from './commands/reply-overrides.tsx';
import { BlockedArea } from './moderation/blocked.tsx';
import { EscalationArea } from './moderation/escalation.tsx';
import { ImmunityArea } from './moderation/immunity.tsx';
import { NotificationsArea } from './moderation/notifications.tsx';
import { useProblems, useSavedConfig } from './moderation/punish-shape.ts';
import { PunishmentsArea } from './moderation/punishments.tsx';
import { blockedCountQuery, caseCountQuery } from './moderation/queries.ts';
import { ReasonsArea } from './moderation/reasons.tsx';
import { ReportsArea, ReportsAside } from './moderation/reports/index.tsx';

const SUB_PAGES: Readonly<Record<string, string>> = {
  blocked: 'Blocked members',
  escalation: 'Warn escalation',
  punishments: 'Punish settings',
  immunity: 'Immunity',
  notifications: 'Member notifications',
  reasons: 'Predefined reasons',
  reports: 'User reports',
  'reports-queue': 'User reports',
  'reports-settings': 'User reports',
  'reports-automation': 'User reports',
  'reports-messages': 'User reports',
};

const MAIN_VIEW = { area: undefined, q: undefined, page: undefined, id: undefined };

const MAIN_AREA = 'policy';

function ownerOf(path: string): string {
  if (path.startsWith('punish.immunity')) return 'immunity';
  if (path.startsWith('punish.notifications')) return 'notifications';
  if (path.startsWith('punish.reasons')) return 'reasons';
  if (path.startsWith('punish.')) return 'punishments';
  if (path.startsWith('escalation')) return 'escalation';
  if (path.startsWith('reports.automation')) return 'reports-automation';
  if (path.startsWith('reports.notifications')) return 'reports-messages';
  if (path.startsWith('reports.')) return 'reports-settings';
  return MAIN_AREA;
}

function sameArea(area: string, owner: string): boolean {
  return area === owner || (area.startsWith('reports') && owner.startsWith('reports'));
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

function Aside({ broken, children }: { broken: boolean; children: ReactNode }): ReactElement {
  return broken ? (
    <span className="moderation-aside text-danger text-sm">Needs fixing</span>
  ) : (
    <span className="moderation-aside text-muted text-sm">{children}</span>
  );
}

export default function ModerationPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({
    guildId,
    moduleId: meta.id,
    schema: moderationConfigSchema,
    templates: moderationTemplates,
  });
  const toggle = useModuleToggle(guildId, summary);
  const problems = useProblems(form);
  const saved = useSavedConfig(form);
  const overridden = useReplyOverrideNote(guildId, meta.id);

  const crumb = SUB_PAGES[area];
  const owners = new Set(problems.paths.map(ownerOf));
  const stray =
    crumb === undefined ? undefined : [...owners].find((owner) => !sameArea(area, owner));
  const strayLabel =
    stray === undefined
      ? undefined
      : (SUB_PAGES[stray] ?? (stray.startsWith('reports') ? 'User reports' : meta.label));

  const enabled = summary?.enabled ?? form.view.enabled;
  const config: ModerationConfig = form.value;
  const { punish } = config;

  const immuneRoles = new Set([
    ...punish.immunity.global,
    ...punish.immunity.ban,
    ...punish.immunity.kick,
    ...punish.immunity.timeout,
    ...punish.immunity.warn,
  ]).size;

  const notices = [
    punish.notifications.onPunish,
    punish.notifications.onUnpunish,
    punish.notifications.onPunishByOthers,
    punish.notifications.onUnpunishByOthers,
  ].filter(Boolean).length;

  const steps = config.escalationLadder.length;

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
        offNote="Settings are saved, but its commands aren’t registered and warn escalation doesn’t run until you turn it on."
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}

        {stray !== undefined && strayLabel !== undefined ? (
          <StatusBanner
            tone="danger"
            actions={
              <ModuleLink
                guildId={guildId}
                moduleId={meta.id}
                search={stray === MAIN_AREA ? MAIN_VIEW : { area: stray }}
                className="button button-secondary button-sm"
              >
                Open {strayLabel}
              </ModuleLink>
            }
          >
            {`A setting under ${strayLabel} needs fixing before you can save.`}
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      {area === 'blocked' ? <BlockedArea guildId={guildId} moduleId={meta.id} /> : null}

      {area === 'escalation' ? <EscalationArea form={form} /> : null}

      {area === 'punishments' ? (
        <PunishmentsArea guildId={guildId} form={form} problems={problems} />
      ) : null}

      {area === 'immunity' ? (
        <ImmunityArea guildId={guildId} form={form} problems={problems} />
      ) : null}

      {area === 'notifications' ? (
        <NotificationsArea guildId={guildId} form={form} problems={problems} />
      ) : null}

      {area === 'reasons' ? <ReasonsArea form={form} problems={problems} /> : null}

      {area.startsWith('reports') ? (
        <ReportsArea guildId={guildId} moduleId={meta.id} meta={meta} area={area} form={form} />
      ) : null}

      {crumb === undefined ? (
        <>
          <Destinations
            guildId={guildId}
            moduleId={meta.id}
            reports={
              <ReportsAside
                guildId={guildId}
                saved={saved}
                broken={[...owners].some((owner) => owner.startsWith('reports'))}
              />
            }
          />

          <Section label="Punishments">
            <Rows>
              <NavigationRow
                guildId={guildId}
                moduleId={meta.id}
                search={{ area: 'punishments' }}
                icon="gavel"
                title="Punish settings"
                description="Reasons, audit-log wording, default lengths and what else happens with each punishment."
                aside={
                  <Aside broken={owners.has('punishments')}>
                    {`${humaniseDuration(punish.types.timeout.defaultDuration)} timeouts`}
                  </Aside>
                }
              />

              <NavigationRow
                guildId={guildId}
                moduleId={meta.id}
                search={{ area: 'immunity' }}
                icon="shield-check"
                title="Immunity"
                description="Members who can’t be punished by moderators or automatic punishments."
                aside={
                  <Aside broken={owners.has('immunity')}>
                    {punish.immunity.useHierarchy
                      ? 'Hierarchy'
                      : immuneRoles === 0
                        ? 'No roles'
                        : plural(immuneRoles, 'role', 'roles')}
                  </Aside>
                }
              />

              <NavigationRow
                guildId={guildId}
                moduleId={meta.id}
                search={{ area: 'notifications' }}
                icon="chat-teardrop-text"
                title="Member notifications"
                description="DMs to members when they’re punished or a punishment is lifted."
                aside={
                  <Aside broken={owners.has('notifications')}>
                    {notices === 0 ? 'Off' : `${notices} of 4 on`}
                  </Aside>
                }
              />

              <NavigationRow
                guildId={guildId}
                moduleId={meta.id}
                search={{ area: 'reasons' }}
                icon="list-checks"
                title="Predefined reasons"
                description="Reasons moderators pick while typing, with short aliases."
                aside={
                  <Aside broken={owners.has('reasons')}>
                    {punish.reasons.length === 0
                      ? 'None'
                      : plural(punish.reasons.length, 'reason', 'reasons')}
                  </Aside>
                }
              />

              <NavigationRow
                guildId={guildId}
                moduleId={meta.id}
                search={{ area: 'escalation' }}
                icon="stairs"
                title="Warn escalation"
                description="Time out, kick or ban members who collect too many warnings."
                aside={
                  <Aside broken={owners.has('escalation')}>
                    {steps === 0
                      ? 'No steps'
                      : `${plural(steps, 'step', 'steps')} within ${humaniseDuration(config.escalationWindow)}`}
                  </Aside>
                }
              />
            </Rows>
          </Section>

          <Section label="Replies">
            <Rows>
              <SettingRow
                title="Reply publicly"
                note={
                  config.publicReplies && overridden === undefined ? undefined : (
                    <>
                      {config.publicReplies
                        ? null
                        : 'Only the moderator who used the command sees the reply. '}
                      {overridden}
                    </>
                  )
                }
                error={problems.at('publicReplies')}
              >
                <Switch
                  label="Reply publicly"
                  checked={config.publicReplies}
                  onChange={(next) =>
                    form.setValue((current) => ({ ...current, publicReplies: next }))
                  }
                />
              </SettingRow>
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

function Destinations({
  guildId,
  moduleId,
  reports,
}: {
  guildId: string;
  moduleId: string;
  reports: ReactNode;
}): ReactElement {
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
          description="Every moderation action, with the moderator and reason."
          aside={
            cases.isPending ? (
              <Spinner label="Loading cases" />
            ) : cases.data ? (
              <span className="text-muted text-sm">
                {cases.data.total === 0 ? 'No cases' : plural(cases.data.total, 'case', 'cases')}
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
          description="Members who can’t pass verification until their block is lifted."
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

        <NavigationRow
          guildId={guildId}
          moduleId={moduleId}
          search={{ area: 'reports' }}
          icon="flag"
          title="User reports"
          description="Reports members file about each other, and how staff review them."
          aside={reports}
        />
      </Rows>
    </Section>
  );
}
