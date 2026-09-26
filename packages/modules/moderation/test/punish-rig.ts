import {
  type EventListener,
  type GuildState,
  type GuildStateStore,
  type ProtonEvent,
  parseCustomId,
  readComponentInteraction,
  readModalInteraction,
} from '@proton/core';
import type { z } from 'zod';
import { memberCommands } from '../src/commands/member.ts';
import type { ModerationConfig, moderationConfigSchema } from '../src/config.ts';
import type {
  MemberLookup,
  ModerationDeps,
  ReportAcceptRequest,
  ReportAcceptResult,
} from '../src/deps.ts';
import { createReasonAutocompleteListener } from '../src/interactions/autocomplete.ts';
import { PUNISH_ACTIONS, type PunishAction } from '../src/punish/interactions.ts';
import { punishAuthorMenu } from '../src/punish/menu.ts';
import {
  APPLICATION_ID,
  BOT,
  baseGuildState,
  type Harness,
  harness,
  LEFT_MEMBER,
  type RunOverrides,
  rolesHeldBy,
  type SentMessage,
} from './harness.ts';
import { FULL_BOT } from './punish-kit.ts';
import { MemoryCaseLedger } from './punish-stores.ts';
import { MemoryDraftStore } from './reports-memory-store.ts';

// The executor checks timeout ends against the wall clock, so the harness clock starts there.
export const NOW = Date.now();

export function punishRouter(deps: ModerationDeps): EventListener<ModerationConfig> {
  return {
    types: ['interaction.component', 'interaction.modal'],
    async handler(event, ctx) {
      const read =
        event.type === 'interaction.modal'
          ? readModalInteraction(event)
          : readComponentInteraction(event);
      const parsed = parseCustomId(read?.customId);
      if (parsed?.moduleId !== 'moderation' || !Object.hasOwn(PUNISH_ACTIONS, parsed.action)) {
        return;
      }

      await PUNISH_ACTIONS[parsed.action as PunishAction](event, ctx, deps);
    },
  };
}

export interface PunishRigOptions {
  config?: z.input<typeof moderationConfigSchema>;
  deps?: { [K in keyof ModerationDeps]?: ModerationDeps[K] | undefined };
}

export interface PunishRig {
  h: Harness;
  deps: ModerationDeps;
  drafts: MemoryDraftStore;
  ledger: MemoryCaseLedger;
  state: GuildState;
  lookups: Map<string, MemberLookup>;
  denied: Map<string, string>;
  accepts: ReportAcceptRequest[];
  acceptResults: ReportAcceptResult[];

  overrides(extra?: Partial<RunOverrides>): Partial<RunOverrides>;
  command(event: ProtonEvent, extra?: Partial<RunOverrides>): Promise<boolean>;
  interact(event: ProtonEvent, extra?: Partial<RunOverrides>): Promise<number>;
  autocomplete(event: ProtonEvent, extra?: Partial<RunOverrides>): Promise<number>;
}

function stateStore(state: GuildState): GuildStateStore {
  return {
    get: async () => state,
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };
}

export function punishRig(options: PunishRigOptions = {}): PunishRig {
  let h: Harness | null = null;
  const now = () => h?.now() ?? NOW;

  const drafts = new MemoryDraftStore(now);
  const ledger = new MemoryCaseLedger(now);
  const state = baseGuildState(FULL_BOT);
  const lookups = new Map<string, MemberLookup>();
  const denied = new Map<string, string>();
  const accepts: ReportAcceptRequest[] = [];
  const acceptResults: ReportAcceptResult[] = [];

  const deps: ModerationDeps = {
    guildState: stateStore(state),
    lookupMember: async (_guildId, userId) =>
      lookups.get(userId) ??
      (userId === LEFT_MEMBER
        ? { state: 'absent' }
        : { state: 'member', roleIds: rolesHeldBy(userId), timeoutUntil: null, joinedAt: null }),
    commandGate: async (_guildId, command) => {
      const message = denied.get(command);
      return message ? { allowed: false, message } : { allowed: true };
    },
    drafts,
    ledger,
    reportAccept: async (_ctx, request) => {
      accepts.push(request);
      return (
        acceptResults.shift() ?? {
          ok: true,
          message: `Accepted report \`${request.reportId}\`.`,
          caseId: 'Kcase01',
        }
      );
    },
    users: {
      resolve: async (userId) => ({
        id: userId,
        username: `user${userId.slice(-4)}`,
        globalName: null,
        avatarUrl: null,
        avatarHash: null,
      }),
    },
    applicationId: APPLICATION_ID,
    botUserId: BOT,
    now,
  };

  const patchable = deps as Record<string, unknown>;
  for (const [key, value] of Object.entries(options.deps ?? {})) {
    if (value === undefined) delete patchable[key];
    else patchable[key] = value;
  }

  const built = harness({ now: NOW, deps });
  h = built;
  ledger.follow(built.recorder);

  const overrides = (extra: Partial<RunOverrides> = {}): Partial<RunOverrides> => ({
    ...(options.config === undefined ? {} : { configInput: options.config }),
    botPermissions: FULL_BOT,
    guildState: state,
    commands: memberCommands(deps),
    contextMenus: [punishAuthorMenu(deps)],
    ...extra,
  });

  return {
    h: built,
    deps,
    drafts,
    ledger,
    state,
    lookups,
    denied,
    accepts,
    acceptResults,
    overrides,
    command: (event, extra) => built.command(event, overrides(extra)),
    interact: (event, extra) => built.listen(event, [punishRouter(deps)], overrides(extra)),
    autocomplete: (event, extra) =>
      built.listen(event, [createReasonAutocompleteListener(deps)], overrides(extra)),
  };
}

export interface Callback {
  type: number;
  data: SentMessage;
}

export function callbacks(h: Harness): Callback[] {
  return h.rest.calls
    .filter((call) => call.path.startsWith('/interactions/'))
    .map((call) => {
      const body = (call.body ?? {}) as { type?: number; data?: SentMessage };
      return { type: body.type ?? 0, data: body.data ?? {} };
    });
}

export function lastFollowUp(h: Harness): SentMessage {
  const message = h.followUps().at(-1);
  if (!message) throw new Error('no follow-up was sent');
  return message;
}

export function lastCallback(h: Harness): Callback {
  const callback = callbacks(h).at(-1);
  if (!callback) throw new Error('no interaction callback was sent');
  return callback;
}

export function textOf(message: SentMessage | undefined): string {
  return [
    message?.content ?? '',
    ...(message?.embeds ?? []).map((embed) => embed.description ?? ''),
  ].join('\n');
}

export function customIds(message: SentMessage | undefined): string[] {
  return (message?.components ?? []).flatMap((row) =>
    ((row.components ?? []) as Array<{ custom_id?: string }>).map((item) => item.custom_id ?? ''),
  );
}

export function selectOptions(message: SentMessage | undefined): string[] {
  return (message?.components ?? []).flatMap((row) =>
    ((row.components ?? []) as Array<{ options?: Array<{ value: string }> }>).flatMap(
      (item) => item.options?.map((option) => option.value) ?? [],
    ),
  );
}

export interface ModalField {
  type: number;
  customId: string | null;
  value: string | null;
  required: boolean | null;
  content: string | null;
  options: string[];
}

export function modalFields(modal: SentMessage | undefined): ModalField[] {
  const components = (modal?.components ?? []) as Array<Record<string, unknown>>;

  return components.map((node) => {
    const inner = (node.component ?? node) as Record<string, unknown>;
    const options = (inner.options ?? []) as Array<{ value: string }>;
    return {
      type: typeof node.type === 'number' ? node.type : 0,
      customId: typeof inner.custom_id === 'string' ? inner.custom_id : null,
      value: typeof inner.value === 'string' ? inner.value : null,
      required: typeof inner.required === 'boolean' ? inner.required : null,
      content: typeof node.content === 'string' ? node.content : null,
      options: options.map((option) => option.value),
    };
  });
}

export function lastModal(h: Harness): SentMessage & { custom_id?: string } {
  const modal = h.modalsOpened().at(-1);
  if (!modal) throw new Error('no modal was opened');
  return modal as SentMessage & { custom_id?: string };
}
