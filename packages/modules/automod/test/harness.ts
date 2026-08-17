import type {
  ActionRequest,
  ActionResult,
  EventType,
  Logger,
  ModuleContext,
  ProtonEvent,
} from '@proton/core';
import { type AutomodConfig, automodConfigSchema } from '../src/config.ts';

export const GUILD = '900000000000000001';
export const BOT = '200000000000000001';
export const MEMBER = '100000000000000002';

export function config(overrides: Record<string, unknown> = {}): AutomodConfig {
  return automodConfigSchema.parse({ enabled: true, ...overrides });
}

export interface Published {
  type: EventType;
  naturalKey: string;
  payload: unknown;
}

export class RecordingExecutor {
  readonly requests: ActionRequest[] = [];
  results: Partial<Record<string, ActionResult>> = {};

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return this.results[request.kind] ?? { status: 'executed' };
  }

  kinds(): string[] {
    return this.requests.map((request) => request.kind);
  }
}

export interface Harness {
  ctx: ModuleContext<AutomodConfig>;
  executor: RecordingExecutor;
  published: Published[];
  logs: string[];
}

export function harness(cfg: AutomodConfig = config()): Harness {
  const executor = new RecordingExecutor();
  const published: Published[] = [];
  const logs: string[] = [];

  const logger: Logger = {
    info(message: string) {
      logs.push(message);
    },
    warn(message: string) {
      logs.push(message);
    },
    error(message: string) {
      logs.push(message);
    },
  };

  return {
    executor,
    published,
    logs,
    ctx: {
      guildId: GUILD,
      config: cfg,
      executor,
      logger,
      async publish(type, naturalKey, payload) {
        published.push({ type, naturalKey, payload });
      },
    },
  };
}

export function protonEvent(type: EventType, payload: unknown, id = 'evt-1'): ProtonEvent {
  return { id, type, guildId: GUILD, occurredAt: 1_700_000_000_000, payload };
}
