import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { Num } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

// MAX_RETAINED_BACKUPS, from a package the dashboard does not depend on and whose config.ts has no
// subpath export.
const MAX_RETAINED_BACKUPS = 25;

export const Route = createFileRoute('/dashboard/$guildId/backup')({
  ...moduleRoute('backup'),
  component: BackupPage,
});

function BackupPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'backup');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="backup:retention" title="Retention">
          <Num
            path="retainBackups"
            label="Snapshots to keep"
            help="A new snapshot deletes the oldest beyond this count"
            min={1}
            max={MAX_RETAINED_BACKUPS}
            defaultValue={10}
          />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
