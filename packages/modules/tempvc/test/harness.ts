import type { ActionRequest, ActionResult, ModuleContext } from '@proton/core';
import {
  type TempVcConfig,
  type TempVcHub,
  tempVcConfigSchema,
  tempVcHubSchema,
} from '../src/config.ts';
import { TemporaryVoiceService } from '../src/service.ts';
import type { TempVoiceChannelRow } from '../src/table.ts';
import { MemoryTempVoiceRepository } from './memory-repository.ts';

export const GUILD = '900000000000000001';
export const BOT = '300000000000000000';
export const HUB = '500000000000000001';
export const CATEGORY = '500000000000000004';
export const CREATED = '600000000000000001';

export const ADA = '700000000000000001';
export const BEN = '700000000000000002';

export interface Call {
  kind: string;
  payload: Record<string, unknown>;
  targetId?: string | undefined;
  idempotencyKey: string;
}

export interface Fake {
  ctx: ModuleContext<TempVcConfig>;
  service: TemporaryVoiceService;
  repository: MemoryTempVoiceRepository;

  /** The one creator channel the harness configures, so a test never has to index the array. */
  hub: TempVcHub;

  /** The row as it stands now, which `destroy` and `claim` need rather than a stale copy. */
  row(id: string): TempVoiceChannelRow;

  calls: Call[];
  logs: Array<{ level: string; message: string }>;

  /** Force the next action of this kind to fail, the way a missing permission would. */
  refuse(kind: string, code: string, humanReason: string): void;
}

export interface HarnessOptions {
  hub?: Record<string, unknown>;
  config?: Partial<TempVcConfig>;
  now?: () => Date;
  createdChannelId?: string | null;
}

export function harness(options: HarnessOptions = {}): Fake {
  const calls: Call[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const refusals = new Map<string, { code: string; humanReason: string }>();

  const repository = new MemoryTempVoiceRepository(options.now);

  const config: TempVcConfig = {
    ...tempVcConfigSchema.parse({}),
    enabled: true,
    ...options.config,
    hubs: [
      tempVcHubSchema.parse({
        channelId: HUB,
        categoryId: CATEGORY,
        nameTemplate: '{user}’s room',
        ...options.hub,
      }),
    ],
  };

  const executor = {
    async execute(request: ActionRequest): Promise<ActionResult> {
      calls.push({
        kind: request.kind,
        payload: (request.payload ?? {}) as Record<string, unknown>,
        targetId: request.targetId,
        idempotencyKey: request.idempotencyKey,
      });

      const refusal = refusals.get(request.kind);
      if (refusal) {
        refusals.delete(request.kind);
        return { status: 'failed_precheck', failure: refusal } as ActionResult;
      }

      if (request.kind === 'create_channel') {
        const id = options.createdChannelId === undefined ? CREATED : options.createdChannelId;

        return { status: 'executed', ...(id === null ? {} : { body: { id } }) } as ActionResult;
      }

      return { status: 'executed' } as ActionResult;
    },
  };

  const ctx = {
    guildId: GUILD,
    config,
    tier: 'free',
    executor,
    logger: {
      info: (message: string) => logs.push({ level: 'info', message }),
      warn: (message: string) => logs.push({ level: 'warn', message }),
      error: (message: string) => logs.push({ level: 'error', message }),
    },
  } as unknown as ModuleContext<TempVcConfig>;

  let counter = 0;

  const service = new TemporaryVoiceService({
    repository,
    botUserId: BOT,
    ...(options.now ? { now: options.now } : {}),
    newId: () => `row-${++counter}`,
  });

  const hub = config.hubs[0];
  if (!hub) throw new Error('the harness always configures one creator channel');

  return {
    ctx,
    service,
    repository,
    hub,
    row: (id) => {
      const found = repository.rows.get(id);
      if (!found) throw new Error(`no temporary voice row '${id}'`);

      return found;
    },
    calls,
    logs,
    refuse: (kind, code, humanReason) => refusals.set(kind, { code, humanReason }),
  };
}

export function member(userId = ADA, channelId: string | null = HUB) {
  return {
    userId,
    channelId,
    displayName: userId === ADA ? 'Ada' : 'Ben',
    username: userId === ADA ? 'ada' : 'ben',
    isBot: false,
  };
}

export const callsOf = (fake: Fake, kind: string): Call[] =>
  fake.calls.filter((call) => call.kind === kind);
