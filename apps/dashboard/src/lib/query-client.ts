import { QueryClient } from '@tanstack/react-query';
import { isRedirect } from '@tanstack/react-router';
import { isPermanentFailure } from './errors.ts';

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,

        // Neither branch is transient. A redirect is control flow, and a refusal costs a Discord
        // round trip in the middleware only to be refused in exactly the same way.
        retry: (failures, error) =>
          !isRedirect(error) && !isPermanentFailure(error) && failures < 1,
      },
      mutations: { retry: false },
    },
  });
}
