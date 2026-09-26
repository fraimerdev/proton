import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { documentTitle } from '../../lib/document-title.ts';
import { MyApplicationsPage } from '../../pages/apply/list.tsx';
import { ApplyGate, applyEntry, myApplicationsQuery } from '../../pages/apply/shared.tsx';

export const Route = createFileRoute('/apply/')({
  head: () => ({ meta: [{ title: documentTitle('Your applications') }] }),
  loader: ({ context, location }) =>
    applyEntry(context.queryClient, location.href, true, () =>
      context.queryClient.prefetchQuery(myApplicationsQuery()),
    ),
  component: MyApplicationsRoute,
});

function MyApplicationsRoute(): ReactElement {
  const entry = Route.useLoaderData();

  if (entry.state !== 'ready') return <ApplyGate entry={entry} title="Your applications" />;
  return <MyApplicationsPage />;
}
