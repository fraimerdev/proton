import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { Toggle, Tokens } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

export const Route = createFileRoute('/dashboard/$guildId/joinroles')({
  ...moduleRoute('joinroles'),
  component: JoinrolesPage,
});

function JoinrolesPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'joinroles');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="joinroles:grant" title="Roles on join">
          <Tokens path="memberRoleIds" kind="role-id" label="Roles for people" maxItems={10} />
          <Tokens path="botRoleIds" kind="role-id" label="Roles for bots" maxItems={10} />
          <Toggle
            path="grantWhenScreeningPasses"
            label="Wait for Membership Screening"
            defaultValue={true}
          />
        </SectionCard>

        <SectionCard id="joinroles:sticky" title="Sticky roles">
          <Toggle path="stickyEnabled" label="Restore roles on rejoin" defaultValue={false} />
          <Tokens
            path="stickyRoleIds"
            kind="role-id"
            label="Roles eligible for restoring"
            help="Empty restores every role the member had"
            maxItems={25}
          />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
