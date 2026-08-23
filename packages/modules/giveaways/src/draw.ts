import type { Rng } from './rng.ts';

export interface WeightedEntrant {
  userId: string;
  weight: number;
}

interface Held {
  userId: string;
  logKey: number;
}

// Keys are held as ln(u)/w rather than u^(1/w). The two orderings are identical because ln is
// monotonic, but u^(1/w) collapses to 1 for any large weight in float64 — every heavy entrant
// would tie, and the tie would be broken by arrival order instead of by weight.
class MinKeyHeap {
  readonly #items: Held[] = [];

  get size(): number {
    return this.#items.length;
  }

  peek(): Held | undefined {
    return this.#items[0];
  }

  push(item: Held): void {
    this.#items.push(item);

    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if ((this.#items[parent] as Held).logKey <= (this.#items[index] as Held).logKey) break;

      this.#swap(parent, index);
      index = parent;
    }
  }

  replaceMin(item: Held): void {
    if (this.#items.length === 0) {
      this.push(item);
      return;
    }

    this.#items[0] = item;

    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;

      if (
        left < this.#items.length &&
        (this.#items[left] as Held).logKey < (this.#items[smallest] as Held).logKey
      ) {
        smallest = left;
      }
      if (
        right < this.#items.length &&
        (this.#items[right] as Held).logKey < (this.#items[smallest] as Held).logKey
      ) {
        smallest = right;
      }

      if (smallest === index) break;
      this.#swap(smallest, index);
      index = smallest;
    }
  }

  drain(): Held[] {
    return [...this.#items];
  }

  #swap(a: number, b: number): void {
    const temp = this.#items[a] as Held;
    this.#items[a] = this.#items[b] as Held;
    this.#items[b] = temp;
  }
}

const MIN_UNIFORM = Number.MIN_VALUE;

function uniform(rng: Rng): number {
  const value = rng();
  // ln(0) is -Infinity, which would park an entrant at a key nothing can ever beat and quietly
  // remove them from the draw. An injected rng that can return 0 is the realistic source.
  if (!(value > 0)) return MIN_UNIFORM;
  return value < 1 ? value : 1 - Number.EPSILON / 2;
}

function usable(entrant: WeightedEntrant): boolean {
  return Number.isFinite(entrant.weight) && entrant.weight > 0;
}

/**
 * A-ExpJ weighted reservoir sampling without replacement (Efraimidis & Spirakis).
 *
 * Holds O(k) memory and never expands a weight into repeated entries — a member worth nine
 * entries is one record with weight 9, not nine strings. Entrants must arrive in canonical
 * (ascending user id) order: the random stream is consumed once per entrant, so the order is
 * part of what the stored seed reproduces.
 */
export class Reservoir {
  readonly #heap = new MinKeyHeap();
  readonly #k: number;
  readonly #rng: Rng;

  #jump = 0;
  #thresholdLog = 0;
  #filled = false;

  constructor(k: number, rng: Rng) {
    this.#k = k;
    this.#rng = rng;
  }

  offer(entrant: WeightedEntrant): void {
    if (this.#k <= 0 || !usable(entrant)) return;

    if (!this.#filled) {
      this.#heap.push({
        userId: entrant.userId,
        logKey: Math.log(uniform(this.#rng)) / entrant.weight,
      });

      if (this.#heap.size === this.#k) {
        this.#filled = true;
        this.#reseat();
      }
      return;
    }

    this.#jump -= entrant.weight;
    if (this.#jump > 0) return;

    // r is uniform on (T^w, 1), not log-uniform: expm1/log1p keep that exact at both ends,
    // where T^w is either indistinguishable from 0 or indistinguishable from 1 in float64.
    const lowerLog = entrant.weight * this.#thresholdLog;
    const r = 1 + Math.expm1(lowerLog) * (1 - uniform(this.#rng));

    this.#heap.replaceMin({
      userId: entrant.userId,
      logKey: Math.log1p(r - 1) / entrant.weight,
    });

    this.#reseat();
  }

  winners(): string[] {
    return this.#heap
      .drain()
      .sort((a, b) => b.logKey - a.logKey || (a.userId < b.userId ? -1 : 1))
      .map((held) => held.userId);
  }

  #reseat(): void {
    this.#thresholdLog = (this.#heap.peek() as Held).logKey;
    this.#jump = Math.log(uniform(this.#rng)) / this.#thresholdLog;
  }
}

export function sampleWeighted(entrants: Iterable<WeightedEntrant>, k: number, rng: Rng): string[] {
  const reservoir = new Reservoir(k, rng);
  for (const entrant of entrants) reservoir.offer(entrant);

  return reservoir.winners();
}

export async function sampleWeightedAsync(
  chunks: AsyncIterable<readonly WeightedEntrant[]>,
  k: number,
  rng: Rng,
  onEntrant?: (entrant: WeightedEntrant) => void,
): Promise<string[]> {
  const reservoir = new Reservoir(k, rng);

  for await (const chunk of chunks) {
    for (const entrant of chunk) {
      onEntrant?.(entrant);
      reservoir.offer(entrant);
    }
  }

  return reservoir.winners();
}

export interface DrawOptions {
  exclude?: readonly string[];
}

export function drawWinners(
  entrants: Iterable<WeightedEntrant>,
  count: number,
  rng: Rng,
  options: DrawOptions = {},
): string[] {
  const excluded = new Set(options.exclude ?? []);
  if (excluded.size === 0) return sampleWeighted(entrants, count, rng);

  function* remaining(): Generator<WeightedEntrant> {
    for (const entrant of entrants) {
      if (!excluded.has(entrant.userId)) yield entrant;
    }
  }

  return sampleWeighted(remaining(), count, rng);
}
