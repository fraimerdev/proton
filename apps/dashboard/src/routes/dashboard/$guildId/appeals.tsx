import { type AppealPanel, appealPanelsSchema } from '@proton/module-appeals/config';
import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import { ChannelField, Tokens, usePanelSchema } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

const AppealPanelsEditor = lazyRouteComponent(
  () => import('../../../components/appeals/panels.tsx'),
  'AppealPanelsEditor',
);

export const Route = createFileRoute('/dashboard/$guildId/appeals')({
  ...moduleRoute('appeals', { preload: [AppealPanelsEditor] }),
  component: AppealsPage,
});

function AppealsPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'appeals');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="appeals:review" title="Review">
          <ChannelField
            path="reviewChannelId"
            label="Default review channel"
            help="Where an appeal lands when its form names no channel of its own"
            channelTypes={[0, 5, 11, 12]}
            optional
          />
          <Tokens
            path="reviewerRoleIds"
            label="Default reviewers"
            help="Who may accept or turn down an appeal, unless the form names its own"
            kind="role-id"
            maxItems={25}
          />
        </SectionCard>

        <SectionCard id="appeals:panel:panels" title="Appeal forms">
          <Panels form={form} />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}

function Panels({ form }: { form: ModuleForm }): ReactElement {
  const panels = form.value('panels', []) as AppealPanel[];
  usePanelSchema('panels', 'Appeal forms', appealPanelsSchema, panels);

  return (
    <AppealPanelsEditor
      panels={panels}
      channels={form.channels}
      tier={form.tier}
      onChange={(next) => form.set('panels', next)}
    />
  );
}
