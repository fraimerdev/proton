import {
  type EventListener,
  type GuildState,
  Permissions,
  type ProtonEvent,
  parseCustomId,
  readComponentInteraction,
  readModalInteraction,
  toResolvedMessage,
} from '@proton/core';
import type { z } from 'zod';
import { reportCommand } from '../src/commands/report.ts';
import type {
  ModerationConfig,
  moderationConfigSchema,
  reportsConfigSchema,
} from '../src/config.ts';
import type { MemberLookup, MessageRead, ModerationDeps } from '../src/deps.ts';
import {
  REPORT_INTAKE_ACTIONS,
  reportDirectInteractionGuild,
} from '../src/reports/interactions.ts';
import { reportMenus } from '../src/reports/menus.ts';
import { createReportReactionListener } from '../src/reports/reaction.ts';
import type { RawObject } from './drivers.ts';
import {
  APPLICATION_ID,
  BOT,
  BOT_PERMISSIONS,
  baseGuildState,
  CHANNEL,
  GUILD,
  type Harness,
  harness,
  LEFT_MEMBER,
  type RunOverrides,
  rolesHeldBy,
} from './harness.ts';
import {
  MemoryDraftStore,
  MemoryPromptStore,
  MemoryReactionGate,
  MemoryReportStore,
} from './reports-memory-store.ts';

export const REPORT_CHANNEL = '500000000000000009';
export const HIDDEN_CHANNEL = '500000000000000002';
export const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

export const REPORTS_BOT_PERMISSIONS =
  BOT_PERMISSIONS |
  Permissions.ManageMessages |
  Permissions.ReadMessageHistory |
  Permissions.EmbedLinks;

type ReportsInput = z.input<typeof reportsConfigSchema>;

export function reportsInput(reports: ReportsInput = {}): z.input<typeof moderationConfigSchema> {
  return { reports: { enabled: true, channelId: REPORT_CHANNEL, ...reports } };
}

export function reportsState(botPermissions: bigint = REPORTS_BOT_PERMISSIONS): GuildState {
  const state = baseGuildState(botPermissions);

  state.name = 'Proton test server';
  state.roles.set(GUILD, {
    id: GUILD,
    permissions:
      Permissions.ViewChannel | Permissions.ReadMessageHistory | Permissions.SendMessages,
    position: 0,
  });
  state.channels.set(REPORT_CHANNEL, { id: REPORT_CHANNEL, parentId: null, overwrites: [] });
  state.channels.set(HIDDEN_CHANNEL, {
    id: HIDDEN_CHANNEL,
    parentId: null,
    overwrites: [{ id: GUILD, type: 0, allow: 0n, deny: Permissions.ViewChannel }],
  });

  return state;
}

export function intakeRouter(deps: ModerationDeps): EventListener<ModerationConfig> {
  return {
    types: ['interaction.component', 'interaction.modal'],
    async handler(event, ctx) {
      const read =
        event.type === 'interaction.modal'
          ? readModalInteraction(event)
          : readComponentInteraction(event);
      const parsed = parseCustomId(read?.customId);
      if (parsed?.moduleId !== 'moderation') return;

      const handler = REPORT_INTAKE_ACTIONS[parsed.action];
      if (handler) await handler(event, ctx, deps);
    },
  };
}

export interface RigOptions {
  reports?: ReportsInput;
  botPermissions?: bigint;
  deps?: { [K in keyof ModerationDeps]?: ModerationDeps[K] | undefined };
  enabled?: boolean;
}

export interface ReportsRig {
  h: Harness;
  deps: ModerationDeps;
  store: MemoryReportStore;
  drafts: MemoryDraftStore;
  gate: MemoryReactionGate;
  prompts: MemoryPromptStore;
  state: GuildState;
  members: Map<string, MemberLookup>;
  messages: Map<string, MessageRead>;
  reads: string[];

  overrides(extra?: Partial<RunOverrides>): Partial<RunOverrides>;
  command(event: ProtonEvent, extra?: Partial<RunOverrides>): Promise<boolean>;
  interact(event: ProtonEvent, extra?: Partial<RunOverrides>): Promise<number>;
  react(event: ProtonEvent, extra?: Partial<RunOverrides>): Promise<number>;
  putMessage(raw: RawObject): void;
}

export function reportsRig(options: RigOptions = {}): ReportsRig {
  let h: Harness | null = null;
  const now = () => h?.now() ?? NOW;

  const store = new MemoryReportStore(now);
  const drafts = new MemoryDraftStore(now);
  const gate = new MemoryReactionGate(now);
  const prompts = new MemoryPromptStore();
  const state = reportsState(options.botPermissions);
  const members = new Map<string, MemberLookup>();
  const messages = new Map<string, MessageRead>();
  const reads: string[] = [];
  const dmChannels = new Map<string, string>();

  const deps: ModerationDeps = {
    reports: store,
    drafts,
    reactionGate: gate,
    prompts,
    guildState: {
      get: async () => state,
      put: async () => undefined,
      patch: async () => undefined,
      delete: async () => undefined,
    },
    lookupMember: async (_guildId, userId) =>
      members.get(userId) ??
      (userId === LEFT_MEMBER
        ? { state: 'absent' }
        : { state: 'member', roleIds: rolesHeldBy(userId), timeoutUntil: null, joinedAt: null }),
    readMessage: async (_guildId, channelId, messageId) => {
      reads.push(`${channelId}:${messageId}`);
      return messages.get(`${channelId}:${messageId}`) ?? { ok: false, reason: 'not_found' };
    },
    dmChannels: {
      recall: async (guildId, userId) => dmChannels.get(`${guildId}:${userId}`) ?? null,
      remember: async (guildId, userId, channelId) => {
        dmChannels.set(`${guildId}:${userId}`, channelId);
      },
    },
    now,
    botUserId: BOT,
    applicationId: APPLICATION_ID,
  };

  const patchable = deps as Record<string, unknown>;
  for (const [key, value] of Object.entries(options.deps ?? {})) {
    if (value === undefined) delete patchable[key];
    else patchable[key] = value;
  }

  const built = harness({ now: NOW, deps });
  h = built;

  const overrides = (extra: Partial<RunOverrides> = {}): Partial<RunOverrides> => ({
    configInput: {
      ...reportsInput(options.reports),
      ...(options.enabled === false ? { enabled: false } : {}),
    },
    guildState: state,
    commands: [reportCommand(deps)],
    contextMenus: reportMenus(deps),
    directInteractionGuild: reportDirectInteractionGuild,
    ...extra,
  });

  return {
    h: built,
    deps,
    store,
    drafts,
    gate,
    prompts,
    state,
    members,
    messages,
    reads,
    overrides,
    command: (event, extra) => built.command(event, overrides(extra)),
    interact: (event, extra) => built.listen(event, [intakeRouter(deps)], overrides(extra)),
    react: (event, extra) =>
      built.listen(event, [createReportReactionListener(deps)], overrides(extra)),
    putMessage(raw) {
      const message = toResolvedMessage(raw);
      if (!message) throw new Error('the raw message did not read back');
      messages.set(`${message.channelId}:${message.id}`, { ok: true, message });
    },
  };
}

export function modalOf(rig: ReportsRig, index = -1): Record<string, unknown> {
  const modal = rig.h.modalsOpened().at(index);
  if (!modal) throw new Error('no modal was opened');
  return modal as Record<string, unknown>;
}

export function modalCustomId(rig: ReportsRig, index = -1): string {
  const customId = modalOf(rig, index).custom_id;
  if (typeof customId !== 'string') throw new Error('the modal carries no custom_id');
  return customId;
}

export function componentIds(modal: Record<string, unknown>): string[] {
  const components = (modal.components ?? []) as Array<{ component?: { custom_id?: string } }>;
  return components.map((label) => label.component?.custom_id ?? '?');
}

export function buttonIds(message: { components?: Array<Record<string, unknown>> }): string[] {
  return (message.components ?? []).flatMap((row) =>
    ((row.components ?? []) as Array<{ custom_id?: string }>).map(
      (button) => button.custom_id ?? '',
    ),
  );
}

export function textOf(message: unknown): string {
  const body = (message ?? {}) as { content?: string; embeds?: Array<{ description?: string }> };
  return [body.content ?? '', ...(body.embeds ?? []).map((embed) => embed.description ?? '')].join(
    '\n',
  );
}

export { CHANNEL, GUILD };
