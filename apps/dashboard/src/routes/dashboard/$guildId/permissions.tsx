import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type ReactElement, useMemo } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { Tokens } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';
import { modulesQuery } from '../../../lib/queries.ts';

// An override the reader emptied is dropped, not stored as an empty list: the config would
// otherwise grow a key for every command anybody ever opened, all of them meaning "no override".
function pruneOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const overrides = config.overrides;
  if (typeof overrides !== 'object' || overrides === null) return config;

  return {
    ...config,
    overrides: Object.fromEntries(
      Object.entries(overrides as Record<string, unknown>).filter(
        ([, roles]) => !Array.isArray(roles) || roles.length > 0,
      ),
    ),
  };
}

export const Route = createFileRoute('/dashboard/$guildId/permissions')({
  ...moduleRoute('permissions'),
  component: PermissionsPage,
});

function PermissionsPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'permissions', false, pruneOverrides);

  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;

  // Every installed module's commands, not this module's: an override names a command Proton gates,
  // and Permissions itself registers none.
  const commands = useMemo(
    () => [...new Set(modules.flatMap((candidate) => candidate.commands))].sort(),
    [modules],
  );

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="permissions:overrides" title="Command overrides">
          {commands.map((name) => (
            <Tokens
              key={name}
              path={`overrides.${name}`}
              kind="role-id"
              label={`/${name}`}
              help="Empty falls back to Discord’s own command permissions"
            />
          ))}
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
