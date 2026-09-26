import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { type ReactElement, useCallback } from 'react';
import { documentTitle } from '../../../lib/document-title.ts';
import {
  ReviewFrame,
  ReviewGate,
  reviewEntry,
  reviewSearchSchema,
  SubmissionsArea,
  type SubmissionsSearch,
} from '../../../pages/applications/submissions.tsx';

export const Route = createFileRoute('/review/$guildId/')({
  head: () => ({ meta: [{ title: documentTitle('Review applications') }] }),
  validateSearch: zodValidator(reviewSearchSchema),
  loader: ({ context, params, location }) =>
    reviewEntry(context.queryClient, params.guildId, location.href),
  component: ReviewQueueRoute,
});

function ReviewQueueRoute(): ReactElement {
  const entry = Route.useLoaderData();
  const { guildId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const onSearch = useCallback(
    (patch: Partial<SubmissionsSearch>, options?: { replace?: boolean }) =>
      void navigate({
        search: (previous) => ({ ...previous, ...patch }),
        replace: options?.replace ?? false,
        resetScroll: 'id' in patch,
      }),
    [navigate],
  );

  if (entry.state !== 'ready') return <ReviewGate entry={entry} />;

  return (
    <ReviewFrame>
      <SubmissionsArea guildId={guildId} surface="review" search={search} onSearch={onSearch} />
    </ReviewFrame>
  );
}
