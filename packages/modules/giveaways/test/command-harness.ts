import {
  type ActionRequest,
  type ActionResult,
  type CommandContext,
  createCommandOptions,
  type EntitlementTier,
  newId,
  OptionType,
  ProviderRegistry,
  type RawOption,
} from '@proton/core';
import { giveawayCommands } from '../src/commands.ts';
import { type GiveawaysConfig, giveawaysConfigSchema } from '../src/config.ts';
import type { GiveawaysDeps } from '../src/deps.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

export const GUILD = '100000000000000000';
export const CHANNEL = '500000000000000000';
export const HOST = '400000000000000001';
export const STRANGER = '400000000000000099';
export const MEMBER = '400000000000000042';
export const INTERACTION = '600000000000000001';

export interface ReplyPayload {
  content?: string;
  embeds?: { description?: string; color?: number }[];
  files?: { filename: string }[];
}

export interface RunOverrides {
  config: Partial<GiveawaysConfig>;
  tier: EntitlementTier;
  userId: string;
  actorRoleIds: string[];
  deps: GiveawaysDeps;
}

export interface CommandHarness {
  store: MemoryGiveawayStore;
  requests: ActionRequest[];

  reply(): ReplyPayload | null;
  replyText(): string | null;
  replyColour(): number | undefined;

  run(raw: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
}

export function commandHarness(over: Partial<GiveawaysDeps> = {}): CommandHarness {
  const store = new MemoryGiveawayStore();
  const requests: ActionRequest[] = [];

  const deps: GiveawaysDeps = {
    store,
    providers: new ProviderRegistry(),
    applicationId: '800000000000000001',
    ...over,
  };

  const executor = {
    async execute(request: ActionRequest): Promise<ActionResult> {
      requests.push(request);
      return { status: 'executed' } as ActionResult;
    },
  };

  function replyRequest(): ActionRequest | undefined {
    return requests.find((request) => request.kind === 'interaction_reply');
  }

  return {
    store,
    requests,

    reply: () => (replyRequest()?.payload as ReplyPayload | undefined) ?? null,

    // Content when the reply is plain text, the embed description once it is a status embed.
    replyText: () => {
      const payload = replyRequest()?.payload as ReplyPayload | undefined;
      return payload?.content || payload?.embeds?.[0]?.description || null;
    },

    replyColour: () => (replyRequest()?.payload as ReplyPayload | undefined)?.embeds?.[0]?.color,

    async run(raw, overrides = {}) {
      const definition = giveawayCommands(overrides.deps ?? deps)[0];
      if (!definition) throw new Error('the giveaways module declares no commands');

      const ctx = {
        guildId: GUILD,
        channelId: CHANNEL,
        userId: overrides.userId ?? HOST,
        ...(overrides.actorRoleIds ? { actorRoleIds: overrides.actorRoleIds } : {}),
        config: {
          ...giveawaysConfigSchema.parse({}),
          enabled: true,
          ...overrides.config,
        },
        tier: overrides.tier ?? 'free',
        executor,
        logger: { info() {}, warn() {}, error() {} },
        options: createCommandOptions(raw),
        interaction: { id: INTERACTION, token: 'interaction-token' },
        idempotencyKey: newId(),
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
