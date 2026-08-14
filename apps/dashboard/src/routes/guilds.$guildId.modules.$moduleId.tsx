import type { FieldDescriptor } from '@proton/core';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { GeneratedForm } from '../components/form/generated-form.tsx';
import { toConfig, toFormValues } from '../lib/config-paths.ts';
import {
  getGuildChannels,
  getModuleConfig,
  listModules,
  updateModuleConfig,
} from '../server/modules.ts';

export const Route = createFileRoute('/guilds/$guildId/modules/$moduleId')({
  loader: async ({ params }) => {
    const [modules, view, channels] = await Promise.all([
      listModules({ data: { guildId: params.guildId } }),
      getModuleConfig({ data: { guildId: params.guildId, moduleId: params.moduleId } }),
      getGuildChannels({ data: { guildId: params.guildId } }),
    ]);

    const found = modules.modules.find((m) => m.id === params.moduleId);
    if (!found) throw new Error(`unknown module '${params.moduleId}'`);

    // Descriptors cross the wire as JSON; cast back at the render boundary.
    const module = { ...found, descriptors: found.descriptors as unknown as FieldDescriptor[] };

    return { module, view, channels };
  },
  component: ModuleSettings,
});

function ModuleSettings(): ReactElement {
  const { guildId, moduleId } = Route.useParams();
  const { module, view, channels } = Route.useLoaderData();
  const router = useRouter();

  const [enabled, setEnabled] = useState(view.enabled);
  const [values, setValues] = useState(() => toFormValues(module.descriptors, view.config));
  const [status, setStatus] = useState<string | null>(null);

  async function save(): Promise<void> {
    setStatus('Saving…');
    try {
      await updateModuleConfig({
        data: { guildId, moduleId, enabled, config: toConfig(module.descriptors, values) },
      });
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
        descriptors={module.descriptors}
        values={values}
        channels={channels}
        onChange={(path, value) => setValues((prev) => ({ ...prev, [path]: value }))}
      />

      <button type="button" className="button" onClick={() => void save()}>
        Save
      </button>
      {status ? <p className="status">{status}</p> : null}
    </section>
  );
}
