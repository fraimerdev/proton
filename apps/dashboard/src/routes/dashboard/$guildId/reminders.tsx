import { tryParseDuration } from '@proton/core';
import { createFileRoute } from '@tanstack/react-router';
import { type ReactElement, useEffect } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import { Duration } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

export const Route = createFileRoute('/dashboard/$guildId/reminders')({
  ...moduleRoute('reminders'),
  component: RemindersPage,
});

function RemindersPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'reminders');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="reminders:bounds" title="How far ahead">
          <Bounds form={form} />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}

// The rule rejecting an inverted range sits on the config schema, not the form schema, so without
// this the only thing that reports it is the API refusing the save. Reported under a key of its own
// because the Duration input owns 'minDuration' for its unreadable-value report and would clear it.
function Bounds({ form }: { form: ModuleForm }): ReactElement {
  const min = form.value('minDuration', '30s');
  const max = form.value('maxDuration', '365d');

  const soonest = typeof min === 'string' ? tryParseDuration(min) : null;
  const furthest = typeof max === 'string' ? tryParseDuration(max) : null;
  const inverted = soonest !== null && furthest !== null && soonest > furthest;

  const { report } = form;

  useEffect(() => {
    if (!inverted) {
      report('minDuration:range', null);
      return;
    }

    report(
      'minDuration:range',
      '“Soonest” must not be further ahead than the furthest a reminder may be set ' +
        `(${String(max)}), or every reminder in this server would be refused.`,
    );

    return () => report('minDuration:range', null);
  }, [report, inverted, max]);

  return (
    <>
      <Duration path="minDuration" label="Soonest" defaultValue="30s" />
      <Duration path="maxDuration" label="Furthest ahead" defaultValue="365d" />
    </>
  );
}
