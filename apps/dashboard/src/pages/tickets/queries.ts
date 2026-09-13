import type { TicketPriority } from '@proton/core';
import { TICKET_STATUSES, type TicketStatusName } from '@proton/module-tickets/config';
import {
  TICKET_PAGE_SIZE_DEFAULT,
  TICKET_SORT_FIELDS,
  type TicketQueryInput,
  type TicketSortField,
} from '@proton/module-tickets/query';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { LIVE, queryKeys, STALE } from '../../lib/query-keys.ts';
import { searchTickets } from '../../server/modules.ts';
import type { TicketSearch } from './nav.ts';

export function ticketsQuery(guildId: string, search: TicketQueryInput) {
  return queryOptions({
    queryKey: queryKeys.view(guildId, 'tickets', search),
    queryFn: () => searchTickets({ data: { guildId, ...search } }),
    staleTime: STALE.browse,
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}

export function statusOf(value: string | undefined): TicketStatusName | undefined {
  return TICKET_STATUSES.find((candidate) => candidate === value);
}

export function sortOf(value: string | undefined): TicketSortField {
  return TICKET_SORT_FIELDS.find((candidate) => candidate === value) ?? 'number';
}

export interface QueueFilters {
  priority: TicketPriority | '';
  typeId: string;
  ownerId: string | undefined;
  pageSize: number;
}

export const QUEUE_FILTERS: QueueFilters = {
  priority: '',
  typeId: '',
  ownerId: undefined,
  pageSize: TICKET_PAGE_SIZE_DEFAULT,
};

export function queueQuery(guildId: string, search: TicketSearch, filters: QueueFilters) {
  const term = search.q ?? '';
  const status = statusOf(search.status);

  return ticketsQuery(guildId, {
    page: search.page ?? 1,
    pageSize: filters.pageSize,
    sort: sortOf(search.sort),
    direction: search.dir === 'asc' ? 'asc' : 'desc',
    ...(term === '' ? {} : { search: term }),
    ...(status === undefined ? {} : { status }),
    ...(filters.priority === '' ? {} : { priority: filters.priority }),
    ...(filters.typeId === '' ? {} : { typeId: filters.typeId }),
    ...(filters.ownerId === undefined ? {} : { ownerId: filters.ownerId }),
  });
}
