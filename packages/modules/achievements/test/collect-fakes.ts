import type {
  ChannelState,
  EventListener,
  EventType,
  GuildState,
  ModuleContext,
  ProtonEvent,
  ScheduleOptions,
  ScheduleOutcome,
} from '@proton/core';
import { type DispatchName, dispatch } from '@proton/fixtures';
import type { ActivityRecord } from '../src/activity.ts';
import type { Ctx } from '../src/collect/common.ts';
import {
  type AchievementInput,
  type AchievementsConfig,
  type AchievementsConfigInput,
  achievementsConfigSchema,
} from '../src/config.ts';
import type { AchievementsDeps, ChannelKind } from '../src/deps.ts';
import type { EvaluateInput, ProcessInput } from '../src/engine.ts';
import type { ListenerEngine } from '../src/listeners.ts';
import type { TriggerId } from '../src/triggers.ts';
import { MemoryAchievementStore } from './memory-store.ts';
import {
  MemoryAchievementVoiceStore,
  MemoryFencedLocks,
  MemoryLimits,
} from './memory-voice-store.ts';

export const GUILD = '900000000000000001';
export const MEMBER = '100000000000000001';
export const OTHER = '100000000000000002';
export const THIRD = '100000000000000004';
export const BOT = '100000000000000003';
export const PROTON = '100000000000000099';

export const TEXT = '500000000000000001';
export const VOICE = '500000000000000009';
export const OTHER_VOICE = '500000000000000010';
export const THREAD = '500000000000000020';
export const CATEGORY = '500000000000000030';
export const AFK = '500000000000000040';
export const TICKET = '500000000000000050';

export const ROLE = '700000000000000001';
export const JOINED_AT = '2026-08-14T09:00:00.000000+00:00';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 8, 14, 12, 0, 0);

const DISCORD_EPOCH = 1_420_070_400_000n;

export function snowflakeAt(at: number, increment = 0): string {
  return String(((BigInt(at) - DISCORD_EPOCH) << 22n) + BigInt(increment));
}

function channel(id: string, parentId: string | null, type: number): ChannelState {
  return { id, parentId, type, overwrites: [] };
}

export const GUILD_STATE: GuildState = {
  guildId: GUILD,
  ownerId: '200000000000000001',
  everyoneRoleId: GUILD,
  roles: new Map(),
  botRoleIds: [],
  channels: new Map([
    [CATEGORY, channel(CATEGORY, null, 4)],
    [TEXT, channel(TEXT, CATEGORY, 0)],
    [THREAD, channel(THREAD, TEXT, 11)],
    [VOICE, channel(VOICE, CATEGORY, 2)],
    [OTHER_VOICE, channel(OTHER_VOICE, null, 2)],
    [AFK, channel(AFK, null, 2)],
    [TICKET, channel(TICKET, null, 0)],
  ]),
  afkChannelId: AFK,
  updatedAt: 0,
};

export class FakeEngine implements ListenerEngine {
  readonly processed: ProcessInput[] = [];
  readonly evaluated: EvaluateInput[] = [];
  readonly handled: Array<{ name: string; eventId: string }> = [];
  change = { turnedOff: false, turnedOn: false };
  failures = 0;

  async processRecords(_ctx: Ctx, _deps: AchievementsDeps, input: ProcessInput): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('the engine failed');
    }
    this.processed.push(input);
  }

  async evaluateMember(_ctx: Ctx, _deps: AchievementsDeps, input: EvaluateInput): Promise<void> {
    this.evaluated.push(input);
  }

  async handleConfigChanged(_ctx: Ctx, _deps: AchievementsDeps, event: ProtonEvent) {
    this.handled.push({ name: 'configChanged', eventId: event.id });
    return this.change;
  }

  async handleGuildAvailable(_ctx: Ctx, _deps: AchievementsDeps, event: ProtonEvent) {
    this.handled.push({ name: 'guildAvailable', eventId: event.id });
  }

  async handleXpGranted(_ctx: Ctx, _deps: AchievementsDeps, event: ProtonEvent) {
    this.handled.push({ name: 'xpGranted', eventId: event.id });
  }

  async handleRetryRequest(_ctx: Ctx, _deps: AchievementsDeps, event: ProtonEvent) {
    this.handled.push({ name: 'retryRequest', eventId: event.id });
  }

  async handleJobRequest(_ctx: Ctx, _deps: AchievementsDeps, event: ProtonEvent) {
    this.handled.push({ name: 'jobRequest', eventId: event.id });
  }

  records(metric?: ActivityRecord['metric']): ActivityRecord[] {
    const all = this.processed.flatMap((batch) => batch.records);
    return metric === undefined ? all : all.filter((record) => record.metric === metric);
  }

  keys(): string[][] {
    return this.processed.map((batch) =>
      batch.records.map((record) => `${record.metric}:${record.sourceKey}`),
    );
  }
}

export interface Scheduled {
  jobId: string;
  runAt: number;
  naturalKey: string;
  replace: boolean;
}

export interface HarnessOptions {
  guildState?: GuildState | null;
  kinds?: Record<string, ChannelKind>;
  omit?: ReadonlyArray<keyof AchievementsDeps>;
  withoutSchedule?: boolean;
}

export interface Harness {
  clock: { now: number };
  store: MemoryAchievementStore;
  voice: MemoryAchievementVoiceStore;
  locks: MemoryFencedLocks;
  limits: MemoryLimits;
  deps: AchievementsDeps;
  engine: FakeEngine;
  logs: string[];
  scheduled: Scheduled[];
  ctx(config?: AchievementsConfigInput): ModuleContext<AchievementsConfig>;
}

export function config(input: AchievementsConfigInput = {}): AchievementsConfig {
  return achievementsConfigSchema.parse({ enabled: true, ...input });
}

export function harness(options: HarnessOptions = {}): Harness {
  const clock = { now: T0 };
  const now = () => clock.now;

  const store = new MemoryAchievementStore({ now });
  const voice = new MemoryAchievementVoiceStore({ now });
  const locks = new MemoryFencedLocks({ now });
  const limits = new MemoryLimits({ now });
  const kinds = new Map(Object.entries(options.kinds ?? {}));
  const guildState = options.guildState === undefined ? GUILD_STATE : options.guildState;

  const deps: AchievementsDeps = {
    store,
    voice,
    locks,
    limits,
    guildState: { get: async () => guildState },
    channelKind: async (_guildId, channelId) => kinds.get(channelId) ?? null,
    botUserId: PROTON,
    applicationId: PROTON,
    now,
  };
  for (const port of options.omit ?? []) delete deps[port];

  const logs: string[] = [];
  const scheduled: Scheduled[] = [];

  return {
    clock,
    store,
    voice,
    locks,
    limits,
    deps,
    engine: new FakeEngine(),
    logs,
    scheduled,
    ctx(input = {}) {
      return {
        guildId: GUILD,
        config: achievementsConfigSchema.parse({ enabled: true, ...input }),
        executor: { execute: async () => ({ status: 'executed' }) },
        logger: {
          info: (message) => logs.push(message),
          warn: (message) => logs.push(message),
          error: (message) => logs.push(message),
        },
        ...(options.withoutSchedule
          ? {}
          : {
              async schedule(
                jobId: string,
                runAt: Date,
                naturalKey: string,
                _data?: unknown,
                opts?: ScheduleOptions,
              ): Promise<ScheduleOutcome> {
                scheduled.push({
                  jobId,
                  runAt: runAt.getTime(),
                  naturalKey,
                  replace: opts?.replace ?? false,
                });
                return { scheduled: true, replaced: false };
              },
            }),
      };
    },
  };
}

let sequence = 0;

export function event(
  type: EventType,
  payload: unknown,
  options: { id?: string; occurredAt?: number; guildId?: string | null } = {},
): ProtonEvent {
  sequence++;
  return {
    id: options.id ?? `${type}:${GUILD}:${sequence}`,
    type,
    guildId: options.guildId === undefined ? GUILD : options.guildId,
    occurredAt: options.occurredAt ?? T0,
    payload,
  };
}

export function fixture(name: DispatchName): Record<string, unknown> {
  return dispatch(name).d;
}

export function messagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...fixture('messageCreate'),
    member: { roles: [ROLE], joined_at: JOINED_AT, premium_since: null },
    ...overrides,
  };
}

export function achievement(
  id: string,
  trigger: TriggerId,
  extra: Record<string, unknown> = {},
  status: AchievementInput['status'] = 'active',
): AchievementInput {
  return {
    id,
    name: id,
    kind: 'single',
    status,
    requirements: [{ id: 'r1', trigger, ...extra }],
    tiers: [{ id: 'single', targets: { r1: 1 } }],
  };
}

export async function deliver(
  listeners: readonly EventListener<AchievementsConfig>[],
  delivered: ProtonEvent,
  ctx: ModuleContext<AchievementsConfig>,
): Promise<void> {
  for (const listener of listeners) {
    if (listener.types.includes(delivered.type)) await listener.handler(delivered, ctx);
  }
}
