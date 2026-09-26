import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { documentTitle } from '../../../lib/document-title.ts';
import { ServerApplyPage } from '../../../pages/apply/list.tsx';
import {
  ApplyGate,
  applyEntry,
  applyServerQuery,
  isGuildId,
} from '../../../pages/apply/shared.tsx';

export const Route = createFileRoute('/apply/$guildId/')({
  head: () => ({ meta: [{ title: documentTitle('Apply') }] }),
  loader: ({ context, params, location }) =>
    applyEntry(context.queryClient, location.href, isGuildId(params.guildId), () =>
      context.queryClient.prefetchQuery(applyServerQuery(params.guildId)),
    ),
  component: ServerApplyRoute,
});

function ServerApplyRoute(): ReactElement {
  const entry = Route.useLoaderData();
  const { guildId } = Route.useParams();

  if (entry.state !== 'ready') return <ApplyGate entry={entry} title="Apply" />;
  return <ServerApplyPage guildId={guildId} />;
}
