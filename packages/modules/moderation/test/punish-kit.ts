import {
  type GuildState,
  type GuildStateStore,
  type ModuleContext,
  Permissions,
} from '@proton/core';
import type { z } from 'zod';
import type { ModerationConfig, moderationConfigSchema } from '../src/config.ts';
import type { MemberLookup, ModerationDeps } from '../src/deps.ts';
import type { PunishKind } from '../src/punish/config.ts';
import { punish } from '../src/punish/pipeline.ts';
import type {
  CommandGateResult,
  PunishActor,
  PunishOutcome,
  PunishRequest,
} from '../src/punish/types.ts';
import {
  BOT,
  BOT_PERMISSIONS,
  baseGuildState,
  GUILD,
  type Harness,
  harness,
  LEFT_MEMBER,
  MEMBER,
  MOD_ROLE,
  MODERATOR,
  rolesHeldBy,
} from './harness.ts';
import {
  MemoryCaseLedger,
  MemoryCaseMessageStore,
  MemoryDmChannelStore,
  MemoryHistoryBuffer,
  MemoryTimeoutStore,
} from './punish-stores.ts';

export const FULL_BOT =
  BOT_PERMISSIONS | Permissions.EmbedLinks | Permissions.ManageMessages | Permissions.MoveMembers;

export const MOD_PERMISSIONS =
  Permissions.BanMembers | Permissions.KickMembers | Permissions.ModerateMembers;

export function moderator(overrides: Partial<PunishActor> = {}): PunishActor {
  return {
    id: MODERATOR,
    roleIds: [MOD_ROLE],
    permissions: MOD_PERMISSIONS,
    kind: 'member',
    ...overrides,
  };
}

export function automation(overrides: Partial<PunishActor> = {}): PunishActor {
  return {
    id: 'proton:reports',
    roleIds: null,
    permissions: null,
    kind: 'automation',
    label: 'User reports',
    ...overrides,
  };
}

export function request(kind: PunishKind, overrides: Partial<PunishRequest> = {}): PunishRequest {
  return {
    guildId: GUILD,
    kind,
    targetId: MEMBER,
    actor: moderator(),
    origin: { type: 'command' },
    idempotencyRoot: 'evt-1',
    ...overrides,
  };
}

export interface KitOptions {
  config?: z.input<typeof moderationConfigSchema>;
  botPermissions?: bigint;
  state?: GuildState;
  deps?: Partial<ModerationDeps>;
}

export interface PunishKit {
  h: Harness;
  timeouts: MemoryTimeoutStore;
  ledger: MemoryCaseLedger;
  caseMessages: MemoryCaseMessageStore;
  history: MemoryHistoryBuffer;
  dmChannels: MemoryDmChannelStore;
  lookups: Map<string, MemberLookup>;
  gate: {
    result: CommandGateResult;
    asked: Array<{ command: string; roleIds: readonly string[] }>;
  };
  deps: ModerationDeps;
  state: GuildState;
  ctx(): ModuleContext<ModerationConfig>;
  run(request: PunishRequest): Promise<PunishOutcome>;
}

function stateStore(state: GuildState): GuildStateStore {
  return {
    get: async () => state,
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };
}

export function kit(options: KitOptions = {}): PunishKit {
  const h = harness();
  const state = options.state ?? baseGuildState(options.botPermissions ?? FULL_BOT);

  const timeouts = new MemoryTimeoutStore();
  const ledger = new MemoryCaseLedger(h.now);
  ledger.follow(h.recorder);
  const caseMessages = new MemoryCaseMessageStore(h.now);
  const history = new MemoryHistoryBuffer();
  const dmChannels = new MemoryDmChannelStore();
  const lookups = new Map<string, MemberLookup>();
  const gate: PunishKit['gate'] = { result: { allowed: true }, asked: [] };

  const deps: ModerationDeps = {
    guildState: stateStore(state),
    lookupMember: async (_guildId, userId) =>
      lookups.get(userId) ??
      (userId === LEFT_MEMBER
        ? { state: 'absent' }
        : { state: 'member', roleIds: rolesHeldBy(userId), timeoutUntil: null, joinedAt: null }),
    commandGate: async (_guildId, command, roleIds) => {
      gate.asked.push({ command, roleIds });
      return gate.result;
    },
    timeouts,
    ledger,
    caseMessages,
    history,
    dmChannels,
    now: h.now,
    botUserId: BOT,
    ...options.deps,
  };

  const ctx = () =>
    h.context({
      ...(options.config === undefined ? {} : { configInput: options.config }),
      botPermissions: options.botPermissions ?? FULL_BOT,
      guildState: state,
    });

  return {
    h,
    timeouts,
    ledger,
    caseMessages,
    history,
    dmChannels,
    lookups,
    gate,
    deps,
    state,
    ctx,
    run: (punishment) => punish(ctx(), deps, punishment),
  };
}

export function executed(outcome: PunishOutcome): Extract<PunishOutcome, { status: 'executed' }> {
  if (outcome.status !== 'executed') {
    throw new Error(`expected an executed punishment, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

export function callsTo(h: Harness, pattern: RegExp): string[] {
  return h.rest.calls
    .map((call) => `${call.method} ${call.path}`)
    .filter((line) => pattern.test(line));
}
