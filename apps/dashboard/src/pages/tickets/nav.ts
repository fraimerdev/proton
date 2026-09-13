import { useCallback } from 'react';
import { useModuleNavigate, useModuleSearch } from '../../components/module/route.tsx';

export interface TicketSearch {
  area?: string | undefined;
  id?: string | undefined;
  q?: string | undefined;
  page?: number | undefined;
  status?: string | undefined;
  sort?: string | undefined;
  dir?: 'asc' | 'desc' | undefined;
}

export function useTicketSearch(): TicketSearch {
  return useModuleSearch();
}

export function useTicketNav(guildId: string, moduleId: string): (patch: TicketSearch) => void {
  const go = useModuleNavigate(guildId, moduleId);

  return useCallback(
    (patch: TicketSearch) => {
      go(patch);
    },
    [go],
  );
}
