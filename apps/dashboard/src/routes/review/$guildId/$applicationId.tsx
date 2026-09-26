import { createFileRoute, useNavigate } from '@tanstack/react-router';
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

export const Route = createFileRoute('/review/$guildId/$applicationId')({
  head: () => ({ meta: [{ title: documentTitle('Review application') }] }),
  validateSearch: zodValidator(reviewSearchSchema.omit({ id: true })),
  loader: ({ context, params, location }) =>
    reviewEntry(context.queryClient, params.guildId, location.href),
  component: ReviewApplicationRoute,
});

function ReviewApplicationRoute(): ReactElement {
  const entry = Route.useLoaderData();
  const { guildId, applicationId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();

  const onSearch = useCallback(
    (patch: Partial<SubmissionsSearch>, options?: { replace?: boolean }) => {
      const { id, ...rest } = { ...search, id: applicationId, ...patch };
      const replace = options?.replace ?? false;

      if (id === undefined) {
        void navigate({ to: '/review/$guildId', params: { guildId }, search: rest, replace });
        return;
      }

      void navigate({
        to: '/review/$guildId/$applicationId',
        params: { guildId, applicationId: id },
        search: rest,
        replace,
      });
    },
    [navigate, search, guildId, applicationId],
  );

  if (entry.state !== 'ready') return <ReviewGate entry={entry} />;

  return (
    <ReviewFrame>
      <SubmissionsArea
        guildId={guildId}
        surface="review"
        search={{ ...search, id: applicationId }}
        onSearch={onSearch}
      />
    </ReviewFrame>
  );
}
