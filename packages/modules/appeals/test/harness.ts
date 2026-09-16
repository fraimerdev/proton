import type {
  ActionRequest,
  ActionResult,
  EventType,
  ModuleContext,
  ProtonEvent,
} from '@proton/core';
import { encodeCustomId, Permissions } from '@proton/core';
import { InteractionType } from 'discord-api-types/v10';
import {
  type AppealPanel,
  type AppealsConfig,
  appealsConfigSchema,
  MODULE_ID,
} from '../src/config.ts';
import type { AppealsDeps } from '../src/deps.ts';
import { handleReviewPress, type ReviewOutcome } from '../src/interactions.ts';
import { APPROVE_ACTION, DENY_ACTION } from '../src/review.ts';
import type { AppealRecord, AppealStore, DecideInput, FileAppealInput } from '../src/store.ts';

export const GUILD = '900000000000000001';
export const MEMBER = '400000000000000001';
export const MOD = '100000000000000001';
export const OTHER_MOD = '100000000000000002';

export const REVIEW_CHANNEL = '500000000000000001';
export const CARD = '1400000000000000001';
export const DM_CHANNEL = '800000000000000001';

export const INTERACTION = '600000000000000001';
export const APPLICATION = '300000000000000009';

export const REVIEWER_ROLE = '410000000000000001';
export const OTHER_ROLE = '410000000000000002';

export const NOW = 1_700_000_000_000;

export function panel(overrides: Partial<AppealPanel> = {}): AppealPanel {
  return {
    id: 'ban',
    name: 'Ban appeal',
    enabled: true,
    blurb: '',
    questions: [{ key: 'why', label: 'Why?', required: true, maxLength: 1024 }],
    windowDays: 30,
    cooldownDays: 30,
    allowResubmit: false,
    onApprove: 'unban',
    liftBlocklistOnApprove: true,
    approvedMessage: 'Accepted.',
    deniedMessage: 'Turned down.',
    ...overrides,
  };
}

export class MemoryAppealStore implements AppealStore {
  readonly rows: AppealRecord[] = [];

  private next = 1;

  private row(guildId: string, appealId: string): AppealRecord | undefined {
    return this.rows.find((row) => row.guildId === guildId && row.id === appealId);
  }

  async file(input: FileAppealInput): Promise<{ appeal: AppealRecord; filed: boolean }> {
    const existing = this.rows.find(
      (row) =>
        row.guildId === input.guildId && row.origin === input.origin && row.jti === input.jti,
    );
    if (existing) return { appeal: { ...existing }, filed: false };

    const number = this.next++;

    const appeal: AppealRecord = {
      id: `appeal-${number}`,
      number,
      status: 'open',
      filedAt: NOW,
      decidedAt: null,
      guildId: input.guildId,
      userId: input.userId,
      panelId: input.panelId,
      origin: input.origin,
      jti: input.jti,
      decidedBy: null,
      decisionNote: null,
      outcomeApplied: false,
      cardChannelId: null,
      cardMessageId: null,
      dmChannelId: null,
      dmAttempts: 0,
      answers: input.answers,
    };

    this.rows.push(appeal);

    return { appeal: { ...appeal }, filed: true };
  }

  async find(guildId: string, appealId: string): Promise<AppealRecord | null> {
    const row = this.row(guildId, appealId);

    return row ? { ...row } : null;
  }

  async findByLink(guildId: string, origin: string, jti: string): Promise<AppealRecord | null> {
    const row = this.rows.find(
      (candidate) =>
        candidate.guildId === guildId && candidate.origin === origin && candidate.jti === jti,
    );

    return row ? { ...row } : null;
  }

  async lastDecidedAt(guildId: string, userId: string): Promise<number | null> {
    const decided = this.rows
      .filter((row) => row.guildId === guildId && row.userId === userId && row.decidedAt !== null)
      .map((row) => row.decidedAt ?? 0);

    return decided.length > 0 ? Math.max(...decided) : null;
  }

  async decide(input: DecideInput): Promise<AppealRecord | null> {
    const row = this.row(input.guildId, input.appealId);
    if (row?.status !== 'open') return null;

    row.status = input.decision;
    row.decidedBy = input.decidedBy;
    row.decidedAt = NOW;
    row.decisionNote = input.note ?? null;

    return { ...row };
  }

  async markApplied(guildId: string, appealId: string): Promise<void> {
    const row = this.row(guildId, appealId);
    if (row) row.outcomeApplied = true;
  }

  async rememberCard(
    guildId: string,
    appealId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const row = this.row(guildId, appealId);
    if (!row) return;

    row.cardChannelId = channelId;
    row.cardMessageId = messageId;
  }

  async rememberDm(guildId: string, appealId: string, channelId: string): Promise<void> {
    const row = this.row(guildId, appealId);
    if (row) row.dmChannelId = channelId;
  }

  async noteDmAttempt(guildId: string, appealId: string): Promise<number> {
    const row = this.row(guildId, appealId);
    if (!row) return 0;

    row.dmAttempts += 1;

    return row.dmAttempts;
  }
}

export interface Call {
  kind: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface Press {
  decision?: 'approved' | 'denied';
  appealId?: string;
  customId?: string;
  userId?: string;
  permissions?: bigint;
  roleIds?: string[];
}

export interface Fake {
  ctx: ModuleContext<AppealsConfig>;
  store: MemoryAppealStore;
  deps: AppealsDeps;

  calls: Call[];
  logs: Array<{ level: string; message: string }>;
  published: Array<{ type: EventType; naturalKey: string }>;

  file(overrides?: Partial<FileAppealInput>): Promise<AppealRecord>;

  press(options?: Press): Promise<ReviewOutcome>;

  refuse(kind: string, code: string, humanReason: string): void;
}

export interface HarnessOptions {
  config?: Partial<AppealsConfig>;
  panels?: AppealPanel[];
  store?: boolean;
  applicationId?: boolean;
}

export function harness(options: HarnessOptions = {}): Fake {
  const calls: Call[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const published: Array<{ type: EventType; naturalKey: string }> = [];
  const refusals = new Map<string, { code: string; humanReason: string }>();

  const store = new MemoryAppealStore();

  const config: AppealsConfig = {
    ...appealsConfigSchema.parse({}),
    enabled: true,
    reviewChannelId: REVIEW_CHANNEL,
    ...options.config,
    panels: options.panels ?? [panel()],
  };

  const executor = {
    async execute(request: ActionRequest): Promise<ActionResult> {
      calls.push({
        kind: request.kind,
        payload: (request.payload ?? {}) as Record<string, unknown>,
        idempotencyKey: request.idempotencyKey,
      });

      const refusal = refusals.get(request.kind);
      if (refusal) {
        refusals.delete(request.kind);
        return { status: 'failed_precheck', failure: refusal } as ActionResult;
      }

      if (request.kind === 'create_dm') return { status: 'executed', body: { id: DM_CHANNEL } };

      return { status: 'executed' };
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
    publish: async (type: EventType, naturalKey: string) => {
      published.push({ type, naturalKey });
    },
  } as unknown as ModuleContext<AppealsConfig>;

  const deps: AppealsDeps = {
    ...(options.store === false ? {} : { store }),
    ...(options.applicationId === false ? {} : { applicationId: APPLICATION }),
    now: () => NOW,
  };

  let events = 0;

  return {
    ctx,
    store,
    deps,
    calls,
    logs,
    published,

    file: async (overrides = {}) => {
      const { appeal } = await store.file({
        guildId: GUILD,
        userId: MEMBER,
        panelId: 'ban',
        origin: 'honeypot',
        jti: `link-${store.rows.length + 1}`,
        answers: [{ key: 'why', label: 'Why?', value: 'I was hacked' }],
        ...overrides,
      });

      return appeal;
    },

    press: async (press = {}) => {
      const action = press.decision === 'denied' ? DENY_ACTION : APPROVE_ACTION;
      const encoded = encodeCustomId(MODULE_ID, action, press.appealId ?? 'appeal-1');
      if (!encoded.ok) throw new Error(encoded.humanReason);

      const event: ProtonEvent = {
        id: `event-${++events}`,
        type: 'interaction.component',
        guildId: GUILD,
        occurredAt: NOW,
        payload: {
          id: INTERACTION,
          token: 'interaction-token',
          type: InteractionType.MessageComponent,
          application_id: APPLICATION,
          guild_id: GUILD,
          channel_id: REVIEW_CHANNEL,
          data: { custom_id: press.customId ?? encoded.customId, component_type: 2 },
          member: {
            user: { id: press.userId ?? MOD },
            roles: press.roleIds ?? [],
            permissions: String(press.permissions ?? Permissions.ManageGuild),
          },
        },
      };

      return handleReviewPress(event, ctx, deps);
    },

    refuse: (kind, code, humanReason) => refusals.set(kind, { code, humanReason }),
  };
}

export const callsOf = (fake: Fake, kind: string): Call[] =>
  fake.calls.filter((call) => call.kind === kind);

interface AnswerPayload {
  content?: string;
  embeds?: Array<{ description?: string; color?: number }>;
}

function answers(fake: Fake): AnswerPayload[] {
  return callsOf(fake, 'interaction_reply')
    .map((call) => call.payload as AnswerPayload)
    .filter((payload) => payload.content !== undefined || payload.embeds !== undefined);
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
