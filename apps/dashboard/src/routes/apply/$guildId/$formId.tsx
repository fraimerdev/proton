import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { documentTitle } from '../../../lib/document-title.ts';
import { ApplyFormPage } from '../../../pages/apply/form-page.tsx';
import {
  ApplyGate,
  applyEntry,
  applyFormQuery,
  isFormId,
  isGuildId,
} from '../../../pages/apply/shared.tsx';

export const Route = createFileRoute('/apply/$guildId/$formId')({
  head: () => ({ meta: [{ title: documentTitle('Apply') }] }),
  loader: ({ context, params, location }) =>
    applyEntry(
      context.queryClient,
      location.href,
      isGuildId(params.guildId) && isFormId(params.formId),
      () => context.queryClient.prefetchQuery(applyFormQuery(params.guildId, params.formId)),
    ),
  component: ApplyFormRoute,
});

function ApplyFormRoute(): ReactElement {
  const entry = Route.useLoaderData();
  const { guildId, formId } = Route.useParams();

  if (entry.state !== 'ready') return <ApplyGate entry={entry} title="Apply" />;
  return <ApplyFormPage guildId={guildId} formId={formId} />;
}
