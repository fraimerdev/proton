import type { FieldDescriptor } from '@proton/core';
import { zodToDescriptors } from '@proton/core';
import type { EscalationRung } from '@proton/module-cases';
import type { RoleReward } from '@proton/module-leveling';
import { commandOverridesFormSchema } from '@proton/module-permissions';
import type { RolemenuMenu } from '@proton/module-rolemenu';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { type ReactElement, useMemo, useState } from 'react';
import { z } from 'zod';
import { EscalationLadderEditor } from '../components/cases/escalation-ladder.tsx';
import { GeneratedForm } from '../components/form/generated-form.tsx';
import { RoleRewardsEditor } from '../components/leveling/role-rewards.tsx';
import { RolemenuEditor } from '../components/rolemenu/menus.tsx';
import { toConfig, toFormValues } from '../lib/config-paths.ts';
import {
  getGuildChannels,
  getGuildRoles,
  getModuleConfig,
  listModules,
  updateModuleConfig,
} from '../server/modules.ts';

export const Route = createFileRoute('/guilds/$guildId/modules/$moduleId')({
  loader: async ({ params }) => {
    const [modules, view, channels, roles] = await Promise.all([
      listModules({ data: { guildId: params.guildId } }),
      getModuleConfig({ data: { guildId: params.guildId, moduleId: params.moduleId } }),
      getGuildChannels({ data: { guildId: params.guildId } }),
      getGuildRoles({ data: { guildId: params.guildId } }),
    ]);

    const found = modules.modules.find((m) => m.id === params.moduleId);
    if (!found) throw new Error(`unknown module '${params.moduleId}'`);

    const module = { ...found, descriptors: found.descriptors as unknown as FieldDescriptor[] };

    const commands = [...new Set(modules.modules.flatMap((m) => m.commands))].sort();

    return { module, commands, view, channels, roles };
  },
  component: ModuleSettings,
});

function ModuleSettings(): ReactElement {
  const { guildId, moduleId } = Route.useParams();
  const { module, commands, view, channels, roles } = Route.useLoaderData();
  const router = useRouter();

  const [enabled, setEnabled] = useState(view.enabled);
  const [status, setStatus] = useState<string | null>(null);

  const descriptors = useMemo(() => {
    if (moduleId !== 'permissions') return module.descriptors;

    return [
      ...module.descriptors,
      ...zodToDescriptors(z.object({ overrides: commandOverridesFormSchema(commands) })),
    ];
  }, [moduleId, module.descriptors, commands]);

  const [values, setValues] = useState(() => toFormValues(descriptors, view.config));

  const [ladder, setLadder] = useState<EscalationRung[]>(
    () => (view.config.escalationLadder ?? []) as unknown as EscalationRung[],
  );
  const [rewards, setRewards] = useState<RoleReward[]>(
    () => (view.config.roleRewards ?? []) as unknown as RoleReward[],
  );
  const [menus, setMenus] = useState<RolemenuMenu[]>(
    () => (view.config.menus ?? []) as unknown as RolemenuMenu[],
  );

  async function save(): Promise<void> {
    setStatus('Saving…');
    try {
      const config = toConfig(descriptors, values, view.config);
      if (moduleId === 'cases') config.escalationLadder = ladder;
      if (moduleId === 'leveling') config.roleRewards = rewards;
      if (moduleId === 'rolemenu') config.menus = menus;
      if (moduleId === 'permissions') config.overrides = pruneOverrides(config.overrides);

      await updateModuleConfig({ data: { guildId, moduleId, enabled, config } });
      setStatus('Saved.');
      await router.invalidate();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="panel">
      <h1>{module.name}</h1>
      <p>
        <Link to="/guilds/$guildId/modules" params={{ guildId }}>
          All modules
        </Link>
        {' · '}
        <Link to="/guilds/$guildId/cases" params={{ guildId }} search={{}}>
          Cases
        </Link>
      </p>

      <label className="field field-boolean" data-path="__enabled">
        <span className="field-label">
          <span className="field-label-text">Module enabled</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-checked={enabled}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </label>

      <GeneratedForm
        descriptors={descriptors}
        values={values}
        channels={channels}
        roles={roles}
        onChange={(path, value) => setValues((prev) => ({ ...prev, [path]: value }))}
      />

      {moduleId === 'cases' ? (
        <section className="subsection">
          <h2>Warn escalation</h2>
          <EscalationLadderEditor rungs={ladder} onChange={setLadder} />
        </section>
      ) : null}

      {moduleId === 'leveling' ? (
        <section className="subsection">
          <h2>Role rewards</h2>
          <RoleRewardsEditor rewards={rewards} roles={roles} onChange={setRewards} />
        </section>
      ) : null}

      {moduleId === 'rolemenu' ? (
        <section className="subsection">
          <h2>Role menus</h2>
          <RolemenuEditor menus={menus} roles={roles} channels={channels} onChange={setMenus} />
        </section>
      ) : null}

      <button type="button" className="button" onClick={() => void save()}>
        Save
      </button>
      {status ? <p className="status">{status}</p> : null}
    </section>
  );
}

function pruneOverrides(overrides: unknown): Record<string, unknown> {
  if (typeof overrides !== 'object' || overrides === null) return {};

  return Object.fromEntries(
    Object.entries(overrides as Record<string, unknown>).filter(
      ([, roles]) => !Array.isArray(roles) || roles.length > 0,
    ),
  );
}
