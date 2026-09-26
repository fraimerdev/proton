import {
  type ActionRequest,
  type ActionResult,
  type CommandContext,
  type CommandDefinition,
  type CommandLabeler,
  createCommandOptions,
  type EntitlementTier,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  ModuleRegistry,
  newId,
  OptionType,
  ProviderRegistry,
  type RawOption,
  resolvePrivateReply,
  subcommandPath,
} from '@proton/core';
import { giveawayCommands } from '../src/commands.ts';
import { type GiveawaysConfig, giveawaysConfigSchema, MODULE_ID } from '../src/config.ts';
import type { GiveawaysDeps } from '../src/deps.ts';
import { createGiveawaysModule } from '../src/index.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const registry = new ModuleRegistry();
registry.register(createGiveawaysModule());

export const GUILD = '100000000000000000';
export const CHANNEL = '500000000000000000';
export const HOST = '400000000000000001';
export const STRANGER = '400000000000000099';
export const MEMBER = '400000000000000042';
export const INTERACTION = '600000000000000001';
export const APPLICATION = '800000000000000001';

export interface ReplyPayload {
  content?: string;
  embeds?: { description?: string; color?: number }[];
  files?: { filename: string }[];
  ephemeral?: boolean;
  callbackType?: number;
}

export interface RunOverrides {
  config: Partial<GiveawaysConfig>;
  tier: EntitlementTier;
  userId: string;
  actorRoleIds: string[];
  deps: GiveawaysDeps;
  idempotencyKey: string;
  commandLabel: CommandLabeler;

  replyPreference: boolean | null;
  // Present, it replaces what the worker would resolve — undefined is a worker that set none.
  privateReply: boolean | undefined;

  applicationId: string | null;
}

function privateReplyOf(
  command: CommandDefinition<GiveawaysConfig>,
  config: GiveawaysConfig,
  raw: readonly RawOption[],
  overrides: Partial<RunOverrides>,
): { privateReply?: boolean } {
  if ('privateReply' in overrides) {
    return overrides.privateReply === undefined ? {} : { privateReply: overrides.privateReply };
  }
  if (!command.reply) return {};

  const preference = overrides.replyPreference ?? null;
  return {
    privateReply: resolvePrivateReply(command.reply, config, subcommandPath(raw), preference),
  };
}

export function isDefer(request: ActionRequest): boolean {
  return (
    request.kind === 'interaction_reply' &&
    (request.payload as ReplyPayload | undefined)?.callbackType ===
      INTERACTION_CALLBACK_DEFERRED_MESSAGE
  );
}

function isAnswer(request: ActionRequest): boolean {
  return (
    (request.kind === 'interaction_reply' && !isDefer(request)) ||
    request.kind === 'interaction_followup'
  );
}

export interface CommandHarness {
  store: MemoryGiveawayStore;
  requests: ActionRequest[];
  timeline: string[];
  refuse: Set<string>;
  refuseFirst: Set<string>;
  warnings: string[];

  answers(): ActionRequest[];
  reply(): ReplyPayload | null;
  replyText(): string | null;
  replyColour(): number | undefined;

  run(raw: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
}

function traced(store: MemoryGiveawayStore, timeline: string[]): MemoryGiveawayStore {
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;

      return (...args: unknown[]) => {
        timeline.push(`store:${String(property)}`);
        return value.apply(target, args);
      };
    },
  });
}

export function commandHarness(over: Partial<GiveawaysDeps> = {}): CommandHarness {
  const store = new MemoryGiveawayStore();
  const requests: ActionRequest[] = [];
  const timeline: string[] = [];
  const refuse = new Set<string>();
  const refuseFirst = new Set<string>();
  const warnings: string[] = [];

  const deps: GiveawaysDeps = {
    store: traced(store, timeline),
    providers: new ProviderRegistry(),
    applicationId: APPLICATION,
    ...over,
  };

  const executor = {
    async execute(request: ActionRequest): Promise<ActionResult> {
      if (!registry.mayExecute(MODULE_ID, request.kind)) {
        throw new Error(
          `giveaways executed '${request.kind}', which its actionKinds do not declare`,
        );
      }

      requests.push(request);
      timeline.push(`execute:${request.kind}`);

      if (refuse.has(request.kind) || refuseFirst.delete(request.kind)) {
        return {
          status: 'failed_api',
          failure: { code: 'discord_403', humanReason: 'Missing Permissions (Send Messages).' },
        } as ActionResult;
      }

      return { status: 'executed' } as ActionResult;
    },
  };

  function answer(): ReplyPayload | undefined {
    return requests.filter(isAnswer).at(-1)?.payload as ReplyPayload | undefined;
  }

  function depsFor(overrides: Partial<RunOverrides>): GiveawaysDeps {
    if (overrides.deps) return overrides.deps;
    if (overrides.applicationId !== null) return deps;

    const { applicationId: _none, ...unwired } = deps;
    return unwired;
  }

  return {
    store,
    requests,
    timeline,
    refuse,
    refuseFirst,
    warnings,

    answers: () => requests.filter(isAnswer),

    // The last answer, not the first: after a public defer the first followup is only the notice.
    reply: () => answer() ?? null,

    // Content when the reply is plain text, the embed description once it is a status embed.
    replyText: () => {
      const payload = answer();
      return payload?.content || payload?.embeds?.[0]?.description || null;
    },

    replyColour: () => answer()?.embeds?.[0]?.color,

    async run(raw, overrides = {}) {
      timeline.length = 0;

      const definition = giveawayCommands(depsFor(overrides))[0];
      if (!definition) throw new Error('the giveaways module declares no commands');

      const config: GiveawaysConfig = {
        ...giveawaysConfigSchema.parse({}),
        enabled: true,
        ...overrides.config,
      };

      const ctx = {
        guildId: GUILD,
        channelId: CHANNEL,
        userId: overrides.userId ?? HOST,
        ...(overrides.actorRoleIds ? { actorRoleIds: overrides.actorRoleIds } : {}),
        config,
        tier: overrides.tier ?? 'free',
        executor,
        logger: { info() {}, warn: (message: string) => warnings.push(message), error() {} },
        options: createCommandOptions(raw),
        interaction: { id: INTERACTION, token: 'interaction-token' },
        ...(typeof overrides.applicationId === 'string'
          ? { applicationId: overrides.applicationId }
          : {}),
        idempotencyKey: overrides.idempotencyKey ?? newId(),
        ...(overrides.commandLabel ? { commandLabel: overrides.commandLabel } : {}),
        ...privateReplyOf(definition, config, raw, overrides),
        async schedule() {
          return { scheduled: true, replaced: false };
        },
        async cancel() {},
      } as unknown as CommandContext<GiveawaysConfig>;

      await definition.handler(ctx);
    },
  };
}

export function subcommand(name: string, options: RawOption[] = []): RawOption[] {
  return [{ name, type: OptionType.Subcommand, options }];
}

export function group(name: string, sub: string, options: RawOption[] = []): RawOption[] {
  return [
    {
      name,
      type: OptionType.SubcommandGroup,
      options: [{ name: sub, type: OptionType.Subcommand, options }],
    },
  ];
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

export function userOption(name: string, value: string): RawOption {
  return { name, type: OptionType.User, value };
}
