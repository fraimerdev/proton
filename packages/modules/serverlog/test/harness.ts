import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  AuditEntry,
  CorrelationStore,
  Logger,
  ModuleContext,
  PendingLog,
  ProtonEvent,
  UserProfile,
  UserResolver,
} from '@proton/core';
import { type DispatchName, dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { type ServerlogConfig, serverlogConfigSchema } from '../src/config.ts';
import { emojiSet } from '../src/emoji.ts';

export const GUILD = '900000000000000001';
export const LOG_CHANNEL = '500000000000000099';
export const ACTOR = '200000000000000009';
export const BOT_USER = '100000000000000098';

export const EMOJIS = emojiSet({ stemId: '1539999327580192858', replyId: '1539999328674783242' });

export class MemoryCorrelationStore implements CorrelationStore {
  readonly audits = new Map<string, AuditEntry>();
  readonly pendings = new Map<string, PendingLog>();

  #key(guildId: string, actionType: number, targetId: string): string {
    return `${guildId}:${actionType}:${targetId}`;
  }

  async putAudit(
    guildId: string,
    actionType: number,
    targetId: string,
    entry: AuditEntry,
  ): Promise<void> {
    this.audits.set(this.#key(guildId, actionType, targetId), entry);
  }

  async takeAudit(
    guildId: string,
    actionType: number,
    targetId: string,
  ): Promise<AuditEntry | null> {
    const key = this.#key(guildId, actionType, targetId);
    const value = this.audits.get(key) ?? null;
    this.audits.delete(key);
    return value;
  }

  async putPending(
    guildId: string,
    actionType: number,
    targetId: string,
    pending: PendingLog,
  ): Promise<void> {
    this.pendings.set(this.#key(guildId, actionType, targetId), pending);
  }

  async takePending(
    guildId: string,
    actionType: number,
    targetId: string,
  ): Promise<PendingLog | null> {
    const key = this.#key(guildId, actionType, targetId);
    const value = this.pendings.get(key) ?? null;
    this.pendings.delete(key);
    return value;
  }
}

export class RecordingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  result: ActionResult = { status: 'executed' };

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return this.result;
  }

  embeds(): Array<Record<string, unknown>> {
    return this.requests.flatMap((request) => {
      const payload = request.payload as { embeds?: Array<Record<string, unknown>> };
      return payload.embeds ?? [];
    });
  }

  titles(): string[] {
    return this.embeds().map((embed) => String(embed.title));
  }

  channels(): string[] {
    return this.requests.map((request) => (request.payload as { channelId: string }).channelId);
  }

  footers(): string[] {
    return this.embeds().map((embed) => {
      const footer = embed.footer as { text?: string } | undefined;
      return footer?.text ?? '';
    });
  }

  payloads(): Array<Record<string, unknown>> {
    return this.requests.map((request) => (request.payload ?? {}) as Record<string, unknown>);
  }
}

export const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
    },
  };
}

export const resolver: UserResolver = {
  async resolve(userId: string): Promise<UserProfile | null> {
    return { id: userId, username: 'admin', globalName: 'Admin', avatarUrl: 'https://cdn/a.png', avatarHash: null };
  },
};

export function config(overrides: Partial<ServerlogConfig> = {}): ServerlogConfig {
  return serverlogConfigSchema.parse({
    enabled: true,
    defaultChannelId: LOG_CHANNEL,
    ...overrides,
  });
}

export function context(
  executor: ActionExecutor,
  cfg: ServerlogConfig = config(),
  logger: Logger = silent,
): ModuleContext<ServerlogConfig> {
  return { guildId: GUILD, config: cfg, executor, logger };
}

export function events(name: DispatchName): ProtonEvent[] {
  return normalise(dispatch(name));
}

export function event(name: DispatchName): ProtonEvent {
  const [first] = events(name);
  if (!first) throw new Error(`fixture ${name} produced no event`);
  return first;
}

export function auditEvent(
  actionType: number,
  overrides: Record<string, unknown> = {},
): ProtonEvent {
  const raw = dispatch('auditLogChannelDelete');
  raw.d.action_type = actionType;
  raw.d.user_id = ACTOR;
  Object.assign(raw.d, overrides);

  const produced = normalise(raw);
  const generic = produced.find((candidate) => candidate.type === 'audit.entry');
  if (!generic) throw new Error(`action_type ${actionType} produced no audit.entry`);

  return generic;
}
