import type {
  ActionRequest,
  ActionResult,
  CommandContext,
  ModuleContext,
  RawOption,
} from '@proton/core';
import { createCommandOptions, OptionType } from '@proton/core';
import {
  type TempVcConfig,
  type TempVcHub,
  tempVcConfigSchema,
  tempVcHubSchema,
} from '../src/config.ts';
import type { TempVcDeps } from '../src/deps.ts';
import { TemporaryVoiceService } from '../src/service.ts';
import type { PresenceStore } from '../src/store.ts';
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

  voice: Map<string, string>;
  presence: PresenceStore;

  /** Force the next action of this kind to fail, the way a missing permission would. */
  refuse(
    kind: string,
    code: string,
    humanReason: string,
    status?: 'failed_precheck' | 'failed_api',
  ): void;
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
  const refusals = new Map<
    string,
    { status: 'failed_precheck' | 'failed_api'; failure: { code: string; humanReason: string } }
  >();
  const voice = new Map<string, string>();

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
        return refusal as ActionResult;
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

  const presence = memoryPresence(voice);
  const service = new TemporaryVoiceService({
    repository,
    botUserId: BOT,
    presence,
    refusals: presence,
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
    voice,
    presence,
    refuse: (kind, code, humanReason, status = 'failed_precheck') =>
      refusals.set(kind, { status, failure: { code, humanReason } }),
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

interface AnswerPayload {
  content?: string;
  embeds?: Array<{ description?: string; color?: number }>;
}

/** Only the replies that carry something to read — a defer carries neither content nor embeds. */
function answers(fake: Fake): AnswerPayload[] {
  return fake.calls
    .filter((call) => call.kind === 'interaction_reply' || call.kind === 'interaction_followup')
    .map((call) => call.payload as AnswerPayload)
    .filter((payload) => payload.content !== undefined || payload.embeds !== undefined);
}

const INITIAL_CALLBACKS = new Set([4, 5, 6, 7, 9]);

export function initialCallbacks(fake: Fake): Call[] {
  return callsOf(fake, 'interaction_reply').filter((call) =>
    INITIAL_CALLBACKS.has(Number(call.payload.callbackType ?? 4)),
  );
}

export function replyText(fake: Fake): string | null {
  const payload = answers(fake).at(-1);
  return payload?.content || payload?.embeds?.[0]?.description || null;
}

export function replyColour(fake: Fake): number | null {
  return answers(fake).at(-1)?.embeds?.[0]?.color ?? null;
}

export function replyCount(fake: Fake): number {
  return answers(fake).length;
}

export function memoryPresence(voice: Map<string, string> = new Map()): PresenceStore {
  const stamps = new Map<string, number>();
  const occupancy = new Map<string, Set<string>>();
  const refusals = new Map<string, number>();

  return {
    locate: async (_guildId, userId) => voice.get(userId) ?? null,
    where: async (_guildId, userId) =>
      voice.has(userId) || stamps.has(userId)
        ? { channelId: voice.get(userId) ?? null, at: stamps.get(userId) ?? 0 }
        : null,
    place: async (_guildId, userId, channelId, at) => {
      if (channelId === null) voice.delete(userId);
      else voice.set(userId, channelId);
      stamps.set(userId, at);
    },
    enter: async (_guildId, channelId, userId) => {
      const inside = occupancy.get(channelId) ?? new Set<string>();
      inside.add(userId);
      occupancy.set(channelId, inside);
      return inside.size;
    },
    leave: async (_guildId, channelId, userId) => {
      occupancy.get(channelId)?.delete(userId);
      return occupancy.get(channelId)?.size ?? 0;
    },
    occupants: async (_guildId, channelId) => [...(occupancy.get(channelId) ?? [])],
    reset: async (_guildId, channelId, userIds) => {
      occupancy.set(channelId, new Set(userIds));
    },
    refusedDelete: async (_guildId, rowId) => {
      const count = (refusals.get(rowId) ?? 0) + 1;
      refusals.set(rowId, count);
      return count;
    },
    deleteRefusals: async (_guildId, rowId) => refusals.get(rowId) ?? 0,
  };
}

export function depsOf(fake: Fake): TempVcDeps {
  return { repository: fake.repository, presence: fake.presence, botUserId: BOT };
}

export const APPLICATION = '400000000000000000';

export interface CommandCall {
  sub: string;
  userId?: string;
  channelId?: string;
  options?: RawOption[];
  applicationId?: string | null;
}

export const stringOption = (name: string, value: string): RawOption => ({
  name,
  type: OptionType.String,
  value,
});

export const integerOption = (name: string, value: number): RawOption => ({
  name,
  type: OptionType.Integer,
  value,
});

export const userOption = (name: string, value: string): RawOption => ({
  name,
  type: OptionType.User,
  value,
});

export function commandContext(fake: Fake, call: CommandCall): CommandContext<TempVcConfig> {
  const applicationId = call.applicationId === undefined ? APPLICATION : call.applicationId;

  return {
    ...fake.ctx,
    channelId: call.channelId ?? CREATED,
    userId: call.userId ?? ADA,
    options: createCommandOptions([
      { name: call.sub, type: OptionType.Subcommand, options: call.options ?? [] },
    ]),
    interaction: { id: '111111111111111111', token: 'tok' },
    ...(applicationId === null ? {} : { applicationId }),
    idempotencyKey: `tempvc:${call.sub}`,
  } as CommandContext<TempVcConfig>;
}
