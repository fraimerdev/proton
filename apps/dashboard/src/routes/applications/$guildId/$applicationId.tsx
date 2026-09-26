import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { documentTitle } from '../../../lib/document-title.ts';
import {
  ApplyGate,
  applicationStatusQuery,
  applyEntry,
  isApplicationId,
  isGuildId,
} from '../../../pages/apply/shared.tsx';
import { ApplicationStatusPage } from '../../../pages/apply/status-page.tsx';

export const Route = createFileRoute('/applications/$guildId/$applicationId')({
  head: () => ({ meta: [{ title: documentTitle('Your application') }] }),
  loader: ({ context, params, location }) =>
    applyEntry(
      context.queryClient,
      location.href,
      isGuildId(params.guildId) && isApplicationId(params.applicationId),
      () =>
        context.queryClient.prefetchQuery(
          applicationStatusQuery(params.guildId, params.applicationId),
        ),
    ),
  component: ApplicationStatusRoute,
});

function ApplicationStatusRoute(): ReactElement {
  const entry = Route.useLoaderData();
  const { guildId, applicationId } = Route.useParams();

  if (entry.state !== 'ready') return <ApplyGate entry={entry} title="Check your application" />;
  return <ApplicationStatusPage guildId={guildId} applicationId={applicationId} />;
}
