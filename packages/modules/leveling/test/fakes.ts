import {
  type ActionRequest,
  type ActionResult,
  type CommandContext,
  createCommandOptions,
  type GuildState,
  type Logger,
  type ModuleContext,
  type RawOption,
} from '@proton/core';
import { type LevelingConfig, levelingDefaultConfig } from '../src/config.ts';
import type {
  AdjustInput,
  AwardInput,
  AwardResult,
  LeaderboardEntry,
  MemberXpRecord,
  MemberXpStore,
  VoiceCreditInput,
} from '../src/store.ts';
import type { VoiceSession, VoiceSessionStore } from '../src/voice-session.ts';
import type {
  CreateXpEventInput,
  CreateXpEventResult,
  EndXpEventResult,
  XpEvent,
  XpEventStore,
} from '../src/xp-events.ts';

export const GUILD = '100000000000000001';
export const USER = '200000000000000002';
export const APPLICATION = '900000000000000009';

export class FakeXpStore implements MemberXpStore {
  readonly awards: AwardInput[] = [];
  readonly credits: VoiceCreditInput[] = [];
  readonly records = new Map<string, MemberXpRecord>();
  readonly reads: string[] = [];

  seed(guildId: string, ...records: MemberXpRecord[]): this {
    for (const record of records) this.records.set(`${guildId}:${record.userId}`, record);
    return this;
  }

  async award(input: AwardInput): Promise<AwardResult> {
    this.awards.push(input);
    return { xp: input.amount, level: 0, previousLevel: 0, awarded: true };
  }

  async creditVoice(input: VoiceCreditInput): Promise<AwardResult> {
    this.credits.push(input);
    return { xp: input.amount, level: 0, previousLevel: 0, awarded: true };
  }

  async adjust(input: AdjustInput): Promise<AwardResult> {
    return { xp: input.amount, level: 0, previousLevel: 0, awarded: true };
  }

  async get(guildId: string, userId: string): Promise<MemberXpRecord | null> {
    this.reads.push(`get:${userId}`);
    return this.records.get(`${guildId}:${userId}`) ?? null;
  }

  async leaderboard(): Promise<LeaderboardEntry[]> {
    return [];
  }

  async countRanked(guildId: string): Promise<number> {
    this.reads.push('countRanked');
    return [...this.records].filter(
      ([key, record]) => key.startsWith(`${guildId}:`) && record.xp > 0,
    ).length;
  }
}

export class FakeSessions implements VoiceSessionStore {
  readonly sessions = new Map<string, VoiceSession>();

  async get(guildId: string, userId: string): Promise<VoiceSession | null> {
    return this.sessions.get(`${guildId}:${userId}`) ?? null;
  }

  async open(session: VoiceSession): Promise<void> {
    this.sessions.set(`${session.guildId}:${session.userId}`, session);
  }

  async close(guildId: string, userId: string): Promise<VoiceSession | null> {
    const key = `${guildId}:${userId}`;
    const session = this.sessions.get(key) ?? null;
    this.sessions.delete(key);
    return session;
  }
}

export class FakeXpEventStore implements XpEventStore {
  readonly rows = new Map<string, XpEvent>();
  readonly purges: { guildId: string; before: number }[] = [];
  readonly calls: string[] = [];

  constructor(private readonly timeline: string[] = []) {}

  seed(...events: XpEvent[]): this {
    for (const event of events) this.rows.set(`${event.guildId}:${event.id}`, event);
    return this;
  }

  of(guildId: string): XpEvent[] {
    return [...this.rows.values()]
      .filter((event) => event.guildId === guildId)
      .sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
  }

  #note(call: string): void {
    this.calls.push(call);
    this.timeline.push(`store:${call}`);
  }

  async overlapping(guildId: string, from: number, to: number): Promise<XpEvent[]> {
    this.#note('overlapping');
    return this.of(guildId).filter((event) => event.startsAt < to && event.endsAt > from);
  }

  async pending(guildId: string, now: number): Promise<XpEvent[]> {
    this.#note('pending');
    return this.of(guildId).filter((event) => event.endsAt > now);
  }

  async create(input: CreateXpEventInput): Promise<CreateXpEventResult> {
    this.#note('create');

    const existing = this.rows.get(`${input.guildId}:${input.id}`);
    if (existing) return { status: 'exists', event: existing };

    const pending = this.of(input.guildId).filter((event) => event.endsAt > input.now).length;
    if (pending >= input.maxPending) return { status: 'full', pending };

    const event: XpEvent = {
      guildId: input.guildId,
      id: input.id,
      multiplier: input.multiplier,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdBy: input.createdBy,
      createdAt: input.now,
    };
    this.rows.set(`${input.guildId}:${input.id}`, event);
    return { status: 'created', event };
  }

  async end(guildId: string, id: string, now: number): Promise<EndXpEventResult> {
    this.#note('end');

    const key = `${guildId}:${id}`;
    const event = this.rows.get(key);
    if (!event || event.endsAt <= now) return 'not_found';

    if (event.startsAt > now) {
      this.rows.delete(key);
      return 'cancelled';
    }

    this.rows.set(key, { ...event, endsAt: now });
    return 'ended';
  }

  async purgeEndedBefore(guildId: string, before: number): Promise<number> {
    this.#note('purge');
    this.purges.push({ guildId, before });

    let removed = 0;
    for (const event of this.of(guildId)) {
      if (event.endsAt >= before) continue;
      this.rows.delete(`${guildId}:${event.id}`);
      removed++;
    }
    return removed;
  }
}

export function xpEvent(
  overrides: Partial<XpEvent> & Pick<XpEvent, 'startsAt' | 'endsAt'>,
): XpEvent {
  return {
    guildId: GUILD,
    id: `event-${overrides.startsAt}-${overrides.endsAt}`,
    multiplier: 2,
    createdBy: USER,
    createdAt: overrides.startsAt,
    ...overrides,
  };
}

export function guildStateOf(parents: Record<string, string | null>): {
  get(guildId: string): Promise<GuildState | null>;
} {
  return {
    async get(guildId) {
      return {
        guildId,
        ownerId: USER,
        everyoneRoleId: guildId,
        roles: new Map(),
        botRoleIds: [],
        channels: new Map(
          Object.entries(parents).map(([id, parentId]) => [id, { id, parentId, overwrites: [] }]),
        ),
        updatedAt: 0,
      };
    },
  };
}

export interface Recorded {
  sent: ActionRequest[];
  logs: string[];
  timeline: string[];
}

function recorder(timeline: string[] = []): Recorded & {
  logger: Logger;
  executor: ModuleContext['executor'];
} {
  const sent: ActionRequest[] = [];
  const logs: string[] = [];
  const seen = new Set<string>();

  return {
    sent,
    logs,
    timeline,
    logger: {
      info: (message) => logs.push(`info: ${message}`),
      warn: (message) => logs.push(`warn: ${message}`),
      error: (message) => logs.push(`error: ${message}`),
    },
    executor: {
      async execute(request: ActionRequest): Promise<ActionResult> {
        sent.push(request);
        timeline.push(`exec:${request.kind}`);

        if (seen.has(request.idempotencyKey)) return { status: 'skipped_duplicate' };
        seen.add(request.idempotencyKey);
        return { status: 'executed' };
      },
    },
  };
}

export function listenerContext(
  config: Partial<LevelingConfig>,
): Recorded & { ctx: ModuleContext<LevelingConfig> } {
  const recorded = recorder();

  return {
    ...recorded,
    ctx: {
      guildId: GUILD,
      config: { ...levelingDefaultConfig, ...config },
      logger: recorded.logger,
      executor: recorded.executor,
      publish: async () => undefined,
    },
  };
}

export function commandContext(
  options: RawOption[],
  config: Partial<LevelingConfig> = {},
  timeline: string[] = [],
): Recorded & { ctx: CommandContext<LevelingConfig> } {
  const recorded = recorder(timeline);

  return {
    ...recorded,
    ctx: {
      guildId: GUILD,
      channelId: '300000000000000009',
      userId: USER,
      config: { ...levelingDefaultConfig, enabled: true, ...config },
      logger: recorded.logger,
      executor: recorded.executor,
      options: createCommandOptions(options),
      interaction: { id: '700000000000000007', token: 'token' },
      idempotencyKey: 'interaction-event-1',
    },
  };
}
