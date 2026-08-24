import { type EventBus, newId, verificationWebPassedSchema } from '@proton/core';

export class VerificationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'VerificationError';
  }
}

export interface VerificationServiceOptions {
  bus?: EventBus;
  now?(): number;
}

export interface WebPass {
  guildId: string;
  userId: string;
  jti: string;
}

const NO_BUS =
  'Proton cannot reach its event bus, and the worker is the only process allowed to talk to ' +
  'Discord, so nothing was done. Set REDIS_URL for the api and restart it.';

export class VerificationService {
  readonly #options: VerificationServiceOptions;

  constructor(options: VerificationServiceOptions = {}) {
    this.#options = options;
  }

  async recordWebPass(input: WebPass): Promise<{ requestId: string }> {
    const now = this.#options.now?.() ?? Date.now();
    const payload = verificationWebPassedSchema.parse({ ...input, verifiedAt: now });

    return this.#publish('verification.web_passed', payload.guildId, payload);
  }

  async #publish(
    type: 'verification.web_passed',
    guildId: string,
    payload: unknown,
  ): Promise<{ requestId: string }> {
    const bus = this.#options.bus;

    // The api boots without Redis on purpose, but this route has no other way to reach the worker,
    // and the worker is the only process allowed to talk to Discord.
    if (!bus) throw new VerificationError('bus_unavailable', NO_BUS);

    const requestId = newId();

    await bus.publish({
      id: `${type}:${guildId}:${requestId}`,
      type,
      guildId,
      occurredAt: this.#options.now?.() ?? Date.now(),
      payload,
    });

    return { requestId };
  }
}
