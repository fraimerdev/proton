import type { Redis } from 'ioredis';
import { RedisMailbox } from '../mailbox.ts';
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

export class RedisSimulationResults implements SimulationResults {
  readonly #mailbox: RedisMailbox<SimulationOutcome>;

  constructor(redis: Redis, prefix: string = SIMULATION_RESULT_PREFIX) {
    this.#mailbox = new RedisMailbox(redis, {
      prefix,
      schema: simulationOutcomeSchema,
      ttlMs: SIMULATION_RESULT_TTL_MS,
    });
  }

  recall(requestId: string): Promise<SimulationOutcome | null> {
    return this.#mailbox.recall(requestId);
  }

  answer(requestId: string, outcome: SimulationOutcome): Promise<void> {
    return this.#mailbox.answer(requestId, outcome);
  }

  wait(requestId: string, timeoutMs: number): Promise<SimulationOutcome | null> {
    return this.#mailbox.wait(requestId, timeoutMs);
  }
}
