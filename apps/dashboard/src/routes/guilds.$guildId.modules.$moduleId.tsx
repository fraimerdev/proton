import type { FieldDescriptor } from '@proton/core';
import { zodToDescriptors } from '@proton/core';
import type { EscalationRung } from '@proton/module-cases';
import type { RoleReward } from '@proton/module-leveling';
import { commandOverridesFormSchema } from '@proton/module-permissions';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { type ReactElement, useMemo, useState } from 'react';
import { z } from 'zod';
import { EscalationLadderEditor } from '../components/cases/escalation-ladder.tsx';
import { GeneratedForm } from '../components/form/generated-form.tsx';
import { RoleRewardsEditor } from '../components/leveling/role-rewards.tsx';
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

    // Descriptors cross the wire as JSON; cast back at the render boundary.
    const module = { ...found, descriptors: found.descriptors as unknown as FieldDescriptor[] };

    // Every command Proton has loaded, in name order. The permissions module's
    // override map is keyed by these and cannot learn them itself (I3).
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

  /**
   * The override map's keys are the loaded commands, so its fields cannot come
   * from a static schema — the permissions module ships a builder for exactly
   * this, and the result is ordinary `role-id` array descriptors the generator
   * already knows how to render (see that module's `config.ts`).
   */
  const descriptors = useMemo(() => {
    if (moduleId !== 'permissions') return module.descriptors;

    return [
      ...module.descriptors,
      ...zodToDescriptors(z.object({ overrides: commandOverridesFormSchema(commands) })),
    ];
  }, [moduleId, module.descriptors, commands]);

  const [values, setValues] = useState(() => toFormValues(descriptors, view.config));

  // Outside the generator's vocabulary by design (§9) — see the editors.
  const [ladder, setLadder] = useState<EscalationRung[]>(
    () => (view.config.escalationLadder ?? []) as unknown as EscalationRung[],
  );
  const [rewards, setRewards] = useState<RoleReward[]>(
    () => (view.config.roleRewards ?? []) as unknown as RoleReward[],
  );

  async function save(): Promise<void> {
    setStatus('Saving…');
    try {
      // Merged over the config this page loaded, so fields no generated
      // descriptor covers survive the save instead of resetting to their
      // schema defaults.
      const config = toConfig(descriptors, values, view.config);
      if (moduleId === 'cases') config.escalationLadder = ladder;
      if (moduleId === 'leveling') config.roleRewards = rewards;
      if (moduleId === 'permissions') config.overrides = pruneOverrides(config.overrides);

      await updateModuleConfig({ data: { guildId, moduleId, enabled, config } });
      setStatus('Saved.');
      await router.invalidate();
    } catch (error) {
      // Surface the real reason — never "something went wrong".
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

      {/* Rendered entirely from the module's Zod schema — no per-module UI. */}
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

      <button type="button" className="button" onClick={() => void save()}>
        Save
      </button>
      {status ? <p className="status">{status}</p> : null}
    </section>
  );
}

/**
 * Drop commands with no roles selected.
 *
 * An empty list already means "Discord's own rules apply", so storing one per
 * loaded command would bury the guild's two real overrides in a wall of empty
 * entries and make every `audit_trail` diff (I7) unreadable. Commands that are
 * not loaded right now keep whatever they had — a module being temporarily
 * unregistered must not silently discard its overrides.
 */
function pruneOverrides(overrides: unknown): Record<string, unknown> {
  if (typeof overrides !== 'object' || overrides === null) return {};

  return Object.fromEntries(
    Object.entries(overrides as Record<string, unknown>).filter(
      ([, roles]) => !Array.isArray(roles) || roles.length > 0,
    ),
  );
}
