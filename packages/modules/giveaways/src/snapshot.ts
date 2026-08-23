import { createHash } from 'node:crypto';

export interface EntrantSnapshot {
  userId: string;
  totalEntries: number;
}

// A-ExpJ consumes the random stream once per entrant, so the winners depend on the order the
// entrants are read in. Every path that draws or replays a draw has to walk them in this order —
// the store does it with `order by user_id`, replays do it with canonicalOrder() — or a stored
// seed reproduces different winners and the audit row proves nothing.
export function canonicalOrder<T extends EntrantSnapshot>(entrants: readonly T[]): T[] {
  return [...entrants].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

export function canonicalise(entrants: readonly EntrantSnapshot[]): string {
  return canonicalOrder(entrants)
    .map((entrant) => `${entrant.userId}:${entrant.totalEntries}`)
    .join('\n');
}

export function isCanonicallyOrdered(entrants: readonly EntrantSnapshot[]): boolean {
  for (let index = 1; index < entrants.length; index += 1) {
    if (
      (entrants[index - 1] as EntrantSnapshot).userId >= (entrants[index] as EntrantSnapshot).userId
    ) {
      return false;
    }
  }
  return true;
}

export function snapshotHash(entrants: readonly EntrantSnapshot[]): string {
  return createHash('sha256').update(canonicalise(entrants), 'utf8').digest('hex');
}

/**
 * Hashes the snapshot as it streams past, so a draw over a hundred thousand entrants never holds
 * the whole snapshot in memory just to digest it. Entrants must be offered in canonical order —
 * the same order the draw consumes them in.
 */
export class StreamingSnapshotHash {
  readonly #hash = createHash('sha256');
  #count = 0;
  #totalEntries = 0;
  #first = true;

  offer(entrant: EntrantSnapshot): void {
    const line = `${entrant.userId}:${entrant.totalEntries}`;
    this.#hash.update(this.#first ? line : `\n${line}`, 'utf8');

    this.#first = false;
    this.#count += 1;
    this.#totalEntries += entrant.totalEntries;
  }

  get count(): number {
    return this.#count;
  }

  get totalEntries(): number {
    return this.#totalEntries;
  }

  digest(): string {
    return this.#hash.digest('hex');
  }
}

export function totalEntriesOf(entrants: readonly EntrantSnapshot[]): number {
  return entrants.reduce((sum, entrant) => sum + entrant.totalEntries, 0);
}
