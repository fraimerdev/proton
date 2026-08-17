import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  GuildRole,
  GuildState,
  Logger,
  ProtonEvent,
} from '@proton/core';
import { type DispatchName, dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { type JoinrolesConfig, joinrolesConfigSchema } from '../src/config.ts';
import type { PendingGrantStore } from '../src/pending.ts';
import type { StickyRoleStore } from '../src/store.ts';

export const GUILD = '900000000000000001';
export const MEMBER = '100000000000000002';
export const BOT_MEMBER = '100000000000000003';
export const SCREENEE = '100000000000000004';
export const PROTON = '100000000000000099';

export const ROLE_LOW = '700000000000000001';
export const ROLE_MID = '700000000000000002';
export const BOT_ROLE = '800000000000000001';
export const ROLE_ABOVE_BOT = '700000000000000003';
export const ROLE_MANAGED = '700000000000000004';
export const ROLE_GONE = '700000000000000005';

export class FakeStore implements StickyRoleStore {
  readonly snapshots: Array<{ userId: string; roleIds: string[] }> = [];
  #recorded = new Map<string, string[]>();

  seed(userId: string, roleIds: string[]): void {
    this.#recorded.set(userId, roleIds);
  }

  async snapshot(_guildId: string, userId: string, roleIds: readonly string[]): Promise<void> {
    this.snapshots.push({ userId, roleIds: [...roleIds] });
    this.#recorded.set(userId, [...roleIds]);
  }

  async read(_guildId: string, userId: string): Promise<string[] | null> {
    return this.#recorded.get(userId) ?? null;
  }
}

export class FakePendingStore implements PendingGrantStore {
  readonly marked: string[] = [];
  #held = new Set<string>();

  async mark(guildId: string, userId: string): Promise<void> {
    this.marked.push(userId);
    this.#held.add(`${guildId}:${userId}`);
  }

  async take(guildId: string, userId: string): Promise<boolean> {
    return this.#held.delete(`${guildId}:${userId}`);
  }
}

export class RecordingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  result: ActionResult = { status: 'executed', caseId: 'case-1' };

  readonly #claimed = new Set<string>();

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);

    if (this.#claimed.has(request.idempotencyKey)) return { status: 'skipped_duplicate' };
    this.#claimed.add(request.idempotencyKey);

    return this.result;
  }

  roleIds(): string[] {
    return this.requests.map((r) => (r.payload as { roleId: string }).roleId);
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

function role(id: string, position: number, managed?: boolean): GuildRole {
  return { id, permissions: 0n, position, ...(managed === undefined ? {} : { managed }) };
}

export const STATE: GuildState = {
  guildId: GUILD,
  ownerId: '100000000000000009',
  everyoneRoleId: GUILD,
  roles: new Map([
    [GUILD, role(GUILD, 0)],
    [ROLE_LOW, role(ROLE_LOW, 10)],
    [ROLE_MID, role(ROLE_MID, 20)],
    [ROLE_ABOVE_BOT, role(ROLE_ABOVE_BOT, 90)],
    [ROLE_MANAGED, role(ROLE_MANAGED, 5, true)],
    [BOT_ROLE, role(BOT_ROLE, 50)],
  ]),
  botRoleIds: [BOT_ROLE],
  channels: new Map(),
  updatedAt: 0,
};

export const guildState = { get: async (): Promise<GuildState | null> => STATE };

export function config(overrides: Partial<JoinrolesConfig> = {}): JoinrolesConfig {
  return joinrolesConfigSchema.parse({ enabled: true, ...overrides });
}

export function event(name: DispatchName): ProtonEvent {
  const normalised = normalise(dispatch(name))[0];
  if (!normalised) throw new Error(`fixture ${name} did not normalise`);
  return normalised;
}
