import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  GuildState,
  ModuleContext,
  ProtonEvent,
} from '@proton/core';
import {
  type AchievementsConfig,
  type AchievementsConfigInput,
  achievementsConfigSchema,
} from '../src/config.ts';
import type { AchievementsDeps } from '../src/deps.ts';
import { forgetRuntime, type SubjectFacts } from '../src/engine.ts';
import { activity, CHANNEL, GUILD, ROLE, T0, USER } from './contracts.ts';
import { MemoryAchievementStore } from './memory-store.ts';
import { MemoryLimits } from './memory-voice-store.ts';

export const DM_CHANNEL = '600000000000000001';
export const ROLE_2 = '300000000000000002';
export const BOT_ROLE = '300000000000000009';
export const OWNER = '100000000000000077';

export const MEMBER: SubjectFacts = { roleIds: [], isMember: true, isBot: false };

interface Rule {
  match: (request: ActionRequest) => boolean;
  answer: () => ActionResult;
  times: number;
}

export class FakeExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  readonly #claimed = new Set<string>();
  readonly #rules: Rule[] = [];
  #messages = 0;

  on(
    match: (request: ActionRequest) => boolean,
    answer: ActionResult | (() => ActionResult),
    times = Number.POSITIVE_INFINITY,
  ): this {
    this.#rules.push({
      match,
      answer: typeof answer === 'function' ? answer : () => answer,
      times,
    });
    return this;
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);

    const rule = this.#rules.find((candidate) => candidate.times > 0 && candidate.match(request));
    if (rule) {
      rule.times -= 1;
      return rule.answer();
    }

    if (this.#claimed.has(request.idempotencyKey)) return { status: 'skipped_duplicate' };
    this.#claimed.add(request.idempotencyKey);

    if (request.kind === 'create_dm') return { status: 'executed', body: { id: DM_CHANNEL } };
    if (request.kind === 'send') {
      this.#messages += 1;
      return { status: 'executed', body: { id: `8000000000000000${10 + this.#messages}` } };
    }
    return { status: 'executed' };
  }

  of(kind: ActionRequest['kind']): ActionRequest[] {
    return this.requests.filter((request) => request.kind === kind);
  }
}

export function failure(code: string, humanReason: string, discordCode?: number): ActionResult {
  return {
    status:
      code.startsWith('discord_') || code === 'transport_failure'
        ? 'failed_api'
        : 'failed_precheck',
    failure: { code, humanReason, ...(discordCode === undefined ? {} : { discordCode }) },
  };
}

export interface Published {
  type: string;
  key: string;
  payload: unknown;
}

export interface Scheduled {
  jobId: string;
  runAt: number;
  key: string;
  data: unknown;
  replace: boolean;
}

export interface Harness {
  clock: { now: number };
  store: MemoryAchievementStore;
  executor: FakeExecutor;
  published: Published[];
  scheduled: Scheduled[];
  logs: string[];
  ctx: ModuleContext<AchievementsConfig>;
  deps: AchievementsDeps;
  configure(config: AchievementsConfigInput): void;
  advance(ms: number): void;
  message(index: number, overrides?: Parameters<typeof activity>[0]): ReturnType<typeof activity>;
}

export function harness(
  config: AchievementsConfigInput,
  deps: Partial<AchievementsDeps> = {},
): Harness {
  const clock = { now: T0 };
  const store = new MemoryAchievementStore({ now: () => clock.now });
  const executor = new FakeExecutor();
  const published: Published[] = [];
  const scheduled: Scheduled[] = [];
  const logs: string[] = [];

  const ctx: ModuleContext<AchievementsConfig> = {
    guildId: GUILD,
    config: achievementsConfigSchema.parse({ enabled: true, ...config }),
    executor,
    logger: {
      info: (message) => logs.push(`info: ${message}`),
      warn: (message) => logs.push(`warn: ${message}`),
      error: (message) => logs.push(`error: ${message}`),
    },
    publish: async (type, key, payload) => {
      published.push({ type, key, payload });
    },
    schedule: async (jobId, runAt, key, data, options) => {
      scheduled.push({
        jobId,
        runAt: runAt.getTime(),
        key,
        data,
        replace: options?.replace === true,
      });
      return { scheduled: true, replaced: options?.replace === true };
    },
    cancel: async () => undefined,
  };

  const configure = (next: AchievementsConfigInput): void => {
    ctx.config = achievementsConfigSchema.parse({ enabled: true, ...next });
    store.setModule(GUILD, { enabled: true, config: ctx.config });
    forgetRuntime(store, GUILD);
  };
  configure(config);

  return {
    clock,
    store,
    executor,
    published,
    scheduled,
    logs,
    ctx,
    deps: {
      store,
      limits: new MemoryLimits({ now: () => clock.now }),
      now: () => clock.now,
      ...deps,
    },
    configure,
    advance: (ms) => {
      clock.now += ms;
    },
    message: (index, overrides = {}) =>
      activity({
        sourceKey: `message-${index}`,
        occurredAt: clock.now,
        causation: { kind: 'organic', rootId: `message.created:${index}`, depth: 0 },
        ...overrides,
      }),
  };
}

export function subjects(facts: SubjectFacts = MEMBER, userId = USER): Map<string, SubjectFacts> {
  return new Map([[userId, facts]]);
}

export function guildState(overrides: Partial<GuildState> = {}): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map([
      [ROLE, { id: ROLE, permissions: 0n, position: 2 }],
      [ROLE_2, { id: ROLE_2, permissions: 0n, position: 3 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: 0n, position: 10 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map([
      [CHANNEL, { id: CHANNEL, parentId: null, type: 0, name: 'general', overwrites: [] }],
    ]),
    updatedAt: T0,
    ...overrides,
  };
}

export function event(
  type: ProtonEvent['type'],
  payload: unknown,
  at = T0,
  id = `${type}:1`,
): ProtonEvent {
  return { id, type, guildId: GUILD, occurredAt: at, payload };
}
