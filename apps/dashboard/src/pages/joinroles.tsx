import type { JoinrolesConfig } from '@proton/module-joinroles/config';
import { joinrolesConfigSchema } from '@proton/module-joinroles/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { RoleMultiPicker, roleColour } from '../components/discord/role-picker.tsx';
import type { ModuleForm } from '../components/module/form.ts';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { LimitCounter } from '../components/ui/collection.tsx';
import { Switch } from '../components/ui/controls.tsx';
import { LoadingBoundary, Spinner, StatusBanner } from '../components/ui/feedback.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { Pair, Pairs, Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { SegmentedTabLinks } from '../components/ui/tabs.tsx';
import type { GuildRole } from '../lib/discord.ts';
import { rolesQuery } from '../lib/queries.ts';

type Form = ModuleForm<JoinrolesConfig>;

type RoleListPath = 'memberRoleIds' | 'botRoleIds' | 'stickyRoleIds';

interface RoleIndex {
  byId: ReadonlyMap<string, GuildRole>;
  known: boolean;
  pending: boolean;
}

interface RoleIssue {
  roleId: string;
  role: GuildRole | undefined;
  reason: string;
}

const SWITCHED_OFF = 'Settings are saved, but nothing runs until you switch it on.';

const SCREENING_INTRO =
  'If enabled, members get their roles after they pass Membership Screening instead of when they ' +
  'join.';

function configuredButOff(count: number): string {
  return `${count} ${count === 1 ? 'role is' : 'roles are'} set to be given on join, but Join Roles is switched off, so none are given.`;
}

function useRoleIndex(guildId: string): RoleIndex {
  const { data, isPending } = useQuery(rolesQuery(guildId));

  return useMemo(
    () => ({
      byId: new Map((data ?? []).map((role) => [role.id, role])),
      known: data !== undefined,
      pending: isPending,
    }),
    [data, isPending],
  );
}

function grantIssue(
  roleId: string,
  guildId: string,
  byId: ReadonlyMap<string, GuildRole>,
): string | undefined {
  // fetchGuildRoles drops @everyone, so it has to be recognised by id before the lookup below
  // decides it no longer exists.
  if (roleId === guildId) return 'It is @everyone, which Discord gives every member automatically.';

  const role = byId.get(roleId);
  if (!role) return 'It no longer exists.';

  if (role.managed) {
    return 'It is managed by Discord or an integration, so it cannot be given by hand.';
  }

  if (!role.assignable) {
    return (
      'It is above Proton’s role, and Discord does not let a bot give roles above its own. Drag ' +
      'Proton’s role above it in Server Settings → Roles.'
    );
  }

  return undefined;
}

function roleIssues(ids: readonly string[], guildId: string, index: RoleIndex): RoleIssue[] {
  if (!index.known) return [];

  const issues: RoleIssue[] = [];

  for (const roleId of ids) {
    const reason = grantIssue(roleId, guildId, index.byId);
    if (reason === undefined) continue;

    issues.push({ roleId, role: index.byId.get(roleId), reason });
  }

  return issues;
}

function RoleLabel({
  role,
  roleId,
}: {
  role: GuildRole | undefined;
  roleId: string;
}): ReactElement {
  if (!role) return <span className="mono">{roleId}</span>;

  return (
    <span className="joinroles-role">
      <span className="role-swatch" style={{ background: roleColour(role) }} />
      {role.name}
    </span>
  );
}

function RoleIssues({ issues }: { issues: readonly RoleIssue[] }): ReactElement | null {
  if (issues.length === 0) return null;

  return (
    <ul className="joinroles-issues">
      {issues.map(({ roleId, role, reason }) => (
        <li key={roleId}>
          <Icon name="warning" size={13} weight="fill" />
          <span>
            <span className="joinroles-issue-role">
              <RoleLabel role={role} roleId={roleId} />
            </span>{' '}
            {reason}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RoleList({
  ids,
  index,
  guildId,
  empty,
}: {
  ids: readonly string[];
  index: RoleIndex;
  guildId: string;
  empty: string;
}): ReactElement {
  if (ids.length === 0) return <span className="text-muted text-sm">{empty}</span>;
  if (index.pending) return <Spinner label="Loading roles…" />;

  return (
    <span className="joinroles-roles">
      {ids.map((roleId) => {
        const reason = index.known ? grantIssue(roleId, guildId, index.byId) : undefined;

        return (
          <span className="joinroles-role-entry" key={roleId}>
            <RoleLabel role={index.byId.get(roleId)} roleId={roleId} />
            {reason !== undefined ? (
              <span className="joinroles-role-flag" title={reason}>
                <Icon name="warning" size={12} weight="fill" label={reason} />
              </span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

function Summary({
  form,
  index,
  guildId,
}: {
  form: Form;
  index: RoleIndex;
  guildId: string;
}): ReactElement {
  const sticky = form.value.stickyRoleIds;

  return (
    <div className="panel-sunken joinroles-summary">
      <Pairs>
        <Pair label="Members get">
          <RoleList
            ids={form.value.memberRoleIds}
            index={index}
            guildId={guildId}
            empty="No roles"
          />
        </Pair>
        <Pair label="Bots get">
          <RoleList ids={form.value.botRoleIds} index={index} guildId={guildId} empty="No roles" />
        </Pair>
        <Pair label="On rejoin">
          {!form.value.stickyEnabled ? (
            <span className="text-muted text-sm">Nothing is restored</span>
          ) : sticky.length === 0 ? (
            <span className="text-sm">Every role the member had</span>
          ) : (
            <RoleList ids={sticky} index={index} guildId={guildId} empty="No roles" />
          )}
        </Pair>
      </Pairs>
    </div>
  );
}

function RoleListRow({
  title,
  description,
  path,
  max,
  form,
  guildId,
  index,
}: {
  title: string;
  description?: string | undefined;
  path: RoleListPath;
  max: number;
  form: Form;
  guildId: string;
  index: RoleIndex;
}): ReactElement {
  const value = form.value[path];
  const error = form.errorAt(path);

  return (
    <SettingRow
      title={title}
      description={description}
      badge={<LimitCounter used={value.length} ceiling={max} label="roles" />}
      error={error}
      stacked
    >
      <div className="stack stack-10">
        <RoleMultiPicker
          guildId={guildId}
          label={title}
          value={value}
          max={max}
          requireAssignable
          invalid={error !== undefined}
          onChange={(next) => form.set(path, next)}
        />
        <RoleIssues issues={roleIssues(value, guildId, index)} />
      </div>
    </SettingRow>
  );
}

function PeopleArea({
  form,
  guildId,
  index,
}: {
  form: Form;
  guildId: string;
  index: RoleIndex;
}): ReactElement {
  return (
    <Section label="Roles on join">
      <Rows>
        <RoleListRow
          title="Member roles"
          path="memberRoleIds"
          max={10}
          form={form}
          guildId={guildId}
          index={index}
        />
      </Rows>
    </Section>
  );
}

function BotsArea({
  form,
  guildId,
  index,
}: {
  form: Form;
  guildId: string;
  index: RoleIndex;
}): ReactElement {
  return (
    <Section label="Roles on join">
      <Rows>
        <RoleListRow
          title="Bot roles"
          path="botRoleIds"
          max={10}
          form={form}
          guildId={guildId}
          index={index}
        />
      </Rows>
    </Section>
  );
}

function StickyArea({
  form,
  guildId,
  index,
}: {
  form: Form;
  guildId: string;
  index: RoleIndex;
}): ReactElement {
  return (
    <Section label="Returning members">
      <Rows>
        <SettingRow title="Restore roles on rejoin" error={form.errorAt('stickyEnabled')}>
          <Switch
            label="Restore roles on rejoin"
            checked={form.value.stickyEnabled}
            onChange={(next) => form.set('stickyEnabled', next)}
          />
        </SettingRow>

        {form.value.stickyEnabled ? (
          <RoleListRow
            title="Roles to restore"
            description="Leave empty to restore every role the member had."
            path="stickyRoleIds"
            max={25}
            form={form}
            guildId={guildId}
            index={index}
          />
        ) : null}
      </Rows>
    </Section>
  );
}

function OptionsArea({ form }: { form: Form }): ReactElement {
  return (
    <Section label="Timing" intro={SCREENING_INTRO}>
      <Rows>
        <SettingRow
          title="Wait for Membership Screening"
          error={form.errorAt('grantWhenScreeningPasses')}
        >
          <Switch
            label="Wait for Membership Screening"
            checked={form.value.grantWhenScreeningPasses}
            onChange={(next) => form.set('grantWhenScreeningPasses', next)}
          />
        </SettingRow>
      </Rows>
    </Section>
  );
}

export default function JoinRolesPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: joinrolesConfigSchema });
  const toggle = useModuleToggle(guildId, summary);
  const index = useRoleIndex(guildId);

  const enabled = summary?.enabled ?? form.view.enabled;
  const granted = form.value.memberRoleIds.length + form.value.botRoleIds.length;

  const notices =
    toggle.failure !== null || !enabled ? (
      <>
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}

        {!enabled ? (
          <StatusBanner tone={granted > 0 ? 'warning' : 'neutral'}>
            {granted > 0
              ? configuredButOff(granted)
              : `${meta.label} is switched off. ${SWITCHED_OFF}`}
          </StatusBanner>
        ) : null}
      </>
    ) : undefined;

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
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {notices}
      </ModuleBanners>

      <Summary form={form} index={index} guildId={guildId} />

      {meta.areas && meta.areas.length > 1 ? (
        <div className="joinroles-tabs">
          <SegmentedTabLinks
            guildId={guildId}
            moduleId={meta.id}
            areas={meta.areas}
            current={area}
          />
        </div>
      ) : null}

      <LoadingBoundary key={area} label={`Loading ${meta.label}`} minHeight={280}>
        {area === 'people' ? <PeopleArea form={form} guildId={guildId} index={index} /> : null}

        {area === 'bots' ? <BotsArea form={form} guildId={guildId} index={index} /> : null}

        {area === 'sticky' ? <StickyArea form={form} guildId={guildId} index={index} /> : null}

        {area === 'options' ? <OptionsArea form={form} /> : null}
      </LoadingBoundary>

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
