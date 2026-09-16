import type { Redis } from 'ioredis';
import { type SimulationOutcome, simulationOutcomeSchema } from './io.ts';

export const SIMULATION_RESULT_PREFIX = 'proton:simulation';

export const SIMULATION_RESULT_TTL_MS = 120_000;

export const SIMULATION_WAIT_MS = 20_000;

export interface SimulationResults {
  /** The answer already given to this request id, for a second press of the same button. */
  recall(requestId: string): Promise<SimulationOutcome | null>;

  answer(requestId: string, outcome: SimulationOutcome): Promise<void>;

  /** Resolves null when the worker has not answered within `timeoutMs`. */
  wait(requestId: string, timeoutMs: number): Promise<SimulationOutcome | null>;
}

function parse(raw: string | null | undefined): SimulationOutcome | null {
  if (raw === null || raw === undefined) return null;

  try {
    const parsed = simulationOutcomeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * A one-shot mailbox per request: the worker pushes the answer onto a list and the api blocks on
 * it, so a preview comes back the moment it is rendered rather than after a poll interval. The
 * same answer is kept under a second key, because BLPOP consumes the list entry and a second press
 * of the same button has to be handed the first press's result rather than sent again.
 */
export class RedisSimulationResults implements SimulationResults {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix: string = SIMULATION_RESULT_PREFIX) {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  #mailbox(requestId: string): string {
    return `${this.#prefix}:mailbox:${requestId}`;
  }

  #kept(requestId: string): string {
    return `${this.#prefix}:done:${requestId}`;
  }

  async recall(requestId: string): Promise<SimulationOutcome | null> {
    return parse(await this.#redis.get(this.#kept(requestId)));
  }

  async answer(requestId: string, outcome: SimulationOutcome): Promise<void> {
    const body = JSON.stringify(outcome);

    // The kept copy first: a waiter woken by the list entry may ask for it immediately.
    await this.#redis.set(this.#kept(requestId), body, 'PX', SIMULATION_RESULT_TTL_MS);
    await this.#redis
      .multi()
      .rpush(this.#mailbox(requestId), body)
      .pexpire(this.#mailbox(requestId), SIMULATION_RESULT_TTL_MS)
      .exec();
  }

  async wait(requestId: string, timeoutMs: number): Promise<SimulationOutcome | null> {
    const kept = await this.recall(requestId);
    if (kept !== null) return kept;

    // A duplicate: BLPOP holds the connection for the whole timeout, and the shared client also
    // publishes events and reads config.
    const blocking = this.#redis.duplicate();

    try {
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      const popped = await blocking.blpop(this.#mailbox(requestId), seconds);

      return parse(popped?.[1]) ?? (await this.recall(requestId));
    } finally {
      await blocking.quit().catch(() => undefined);
    }
  }
}
