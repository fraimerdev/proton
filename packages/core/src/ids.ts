import { ulid } from 'ulid';

/**
 * Monotonic, lexicographically sortable ID.
 *
 * ULID rather than UUIDv4 because `ProtonEvent.id` doubles as the dedupe key and
 * as a `cases` primary key — sortable IDs keep those indexes from fragmenting.
 */
export function newId(): string {
  return ulid();
}
