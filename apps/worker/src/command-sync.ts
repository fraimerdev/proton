import {
  type CatalogueEntry,
  type CommandKind,
  type CommandWorkerView,
  commandSetHash,
  commandWorkerViewSchema,
  contextMenuKey,
  type EffectiveCommand,
  effectiveCommandSet,
  type Logger,
  type RestProxyClient,
  type RestResponse,
  RestTimeoutError,
} from '@proton/core';
import type {
  CommandPermissionsCheck,
  CommandRegistrationFailure,
  CommandRegistrationRecord,
  CommandRegistrationScope,
  DrizzleCommandRegistrationStore,
  RegisteredCommand,
} from '@proton/db';
import { z } from 'zod';

type LostCommand = CommandPermissionsCheck['lost'][number];

export const PUT_TIMEOUT_MS = 60_000;
export const DISCORD_READ_TIMEOUT_MS = 15_000;
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 600_000;
export const DAILY_LIMIT_MS = 86_400_000;
export const ACCESS_RETRY_MS = 3_600_000;
export const ACCESS_RETRY_CAP_MS = DAILY_LIMIT_MS;
export const RETRY_MARGIN_MS = 1_000;
export const CHECK_MARGIN_MS = 5_000;
export const PERMISSIONS_REREAD_WAITS_MS: readonly number[] = [1_000, 2_000];

const DETAIL_MAX = 2_000;
const RECORD_CACHE_MAX = 10_000;

export type RegistrationStore = Pick<
  DrizzleCommandRegistrationStore,
  | 'get'
  | 'now'
  | 'recordSuccess'
  | 'recordChecked'
  | 'recordFailure'
  | 'recordHeld'
  | 'recordPermissions'
  | 'forget'
  | 'staleGuilds'
>;

export type RegistrationHeld = Parameters<RegistrationStore['recordHeld']>[1];
export type StaleGuildsOptions = NonNullable<Parameters<RegistrationStore['staleGuilds']>[1]>;

export interface CommandRegistrationRail {
  applicationId: string;
  scope: CommandRegistrationScope;
  testGuildId?: string | undefined;
}

export class RegistrationScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationScopeError';
  }
}

export function inRegistrationScope(rail: CommandRegistrationRail, guildId: string): boolean {
  if (rail.scope === 'every-guild') return !rail.testGuildId;
  return rail.testGuildId !== undefined && rail.testGuildId !== '' && guildId === rail.testGuildId;
}

export function commandsPath(rail: CommandRegistrationRail, guildId: string | null): string {
  if (rail.scope === 'every-guild' && rail.testGuildId) {
    throw new RegistrationScopeError(
      'Refusing to touch Discord commands: every-guild scope with DISCORD_TEST_GUILD_ID set is a ' +
        'development environment pointed at every server.',
    );
  }

  if (guildId === null) {
    if (rail.scope !== 'every-guild') {
      throw new RegistrationScopeError(
        "Refusing to touch Proton's global commands: COMMAND_REGISTRATION_SCOPE is guild, which " +
          'only ever registers in DISCORD_TEST_GUILD_ID.',
      );
    }
    return `/applications/${rail.applicationId}/commands`;
  }

  if (!inRegistrationScope(rail, guildId)) {
    throw new RegistrationScopeError(
      `Refusing to register commands in server ${guildId}: COMMAND_REGISTRATION_SCOPE is guild, ` +
        'which only ever registers in DISCORD_TEST_GUILD_ID.',
    );
  }

  return `/applications/${rail.applicationId}/guilds/${guildId}/commands`;
}

export function putCommands(
  rest: RestProxyClient,
  rail: CommandRegistrationRail,
  guildId: string | null,
  body: readonly unknown[],
): Promise<RestResponse> {
  const path = commandsPath(rail, guildId);
  return rest.request({ method: 'PUT', path, body, timeoutMs: PUT_TIMEOUT_MS });
}

export interface CommandWorkerViewSource {
  get(guildId: string): Promise<CommandWorkerView>;
}

export class HttpCommandWorkerViews implements CommandWorkerViewSource {
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(
    baseUrl: string,
    secret: string,
    options: { timeoutMs?: number; fetch?: typeof globalThis.fetch } = {},
  ) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#secret = secret;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async get(guildId: string): Promise<CommandWorkerView> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/guilds/${guildId}/commands/worker-view`, {
          headers: { 'x-proton-secret': this.#secret },
          signal: controller.signal,
        });
      } catch (error) {
        throw new Error(
          `could not reach the API for the command settings of ${guildId}: ${
            controller.signal.aborted
              ? `no answer within ${this.#timeoutMs} ms`
              : error instanceof Error
                ? error.message
                : String(error)
          }`,
        );
      }

      if (!response.ok) {
        throw new Error(`api returned ${response.status} for the command settings of ${guildId}`);
      }

      const parsed = commandWorkerViewSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        throw new Error(`api answered the command settings of ${guildId} in an unknown shape`);
      }

      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface ViewEntry {
  value: CommandWorkerView;
  expiresAt: number;
}

export class CommandSettingsProvider implements CommandWorkerViewSource {
  readonly #inner: CommandWorkerViewSource;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, ViewEntry>();
  readonly #inflight = new Map<string, Promise<CommandWorkerView>>();

  constructor(inner: CommandWorkerViewSource, options: { ttlMs: number; now?: () => number }) {
    this.#inner = inner;
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  async get(guildId: string): Promise<CommandWorkerView> {
    const cached = this.#entries.get(guildId);
    if (cached) {
      if (cached.expiresAt > this.#now()) return cached.value;
      this.#entries.delete(guildId);
    }

    const pending = this.#inflight.get(guildId);
    if (pending) return pending;

    const promise: Promise<CommandWorkerView> = this.#inner
      .get(guildId)
      .then((value) => {
        // Invalidated while in flight, this read may predate the change, so it is never cached.
        if (this.#ttlMs > 0 && this.#inflight.get(guildId) === promise) {
          this.#entries.set(guildId, { value, expiresAt: this.#now() + this.#ttlMs });
        }
        return value;
      })
      .finally(() => {
        if (this.#inflight.get(guildId) === promise) this.#inflight.delete(guildId);
      });

    this.#inflight.set(guildId, promise);
    return promise;
  }

  invalidate(guildId?: string): void {
    if (guildId === undefined) {
      this.#entries.clear();
      this.#inflight.clear();
      return;
    }
    this.#entries.delete(guildId);
    this.#inflight.delete(guildId);
  }
}

export interface PinnedIds {
  scope: CommandRegistrationScope;
  commands: RegisteredCommand[];
  idHistory: Record<string, string>;
}

interface CachedRecord {
  stored: CommandRegistrationRecord | null;
  record: CommandRegistrationRecord | null;
}

export class CommandRecordCache {
  readonly #store: Pick<RegistrationStore, 'get'>;
  readonly #max: number;
  readonly #records = new Map<string, CachedRecord>();
  readonly #pins = new Map<string, PinnedIds>();
  readonly #inflight = new Map<string, Promise<CachedRecord>>();
  readonly #generation = new Map<string, number>();

  constructor(store: Pick<RegistrationStore, 'get'>, options: { max?: number } = {}) {
    this.#store = store;
    this.#max = options.max ?? RECORD_CACHE_MAX;
  }

  async get(guildId: string): Promise<CommandRegistrationRecord | null> {
    return (this.#records.get(guildId) ?? (await this.#read(guildId))).record;
  }

  async stored(guildId: string): Promise<CommandRegistrationRecord | null> {
    return (this.#records.get(guildId) ?? (await this.#read(guildId))).stored;
  }

  async refresh(guildId: string): Promise<CommandRegistrationRecord | null> {
    return (await this.#read(guildId)).record;
  }

  set(guildId: string, record: CommandRegistrationRecord | null): void {
    this.#bump(guildId);
    this.#remember(guildId, record);
  }

  delete(guildId: string): void {
    this.#bump(guildId);
    this.#records.delete(guildId);
    this.#pins.delete(guildId);
  }

  pin(guildId: string, pinned: PinnedIds): void {
    this.#pins.set(guildId, pinned);
    this.#rememberAgain(guildId);
  }

  unpin(guildId: string): void {
    if (this.#pins.delete(guildId)) this.#rememberAgain(guildId);
  }

  pinned(guildId: string): boolean {
    return this.#pins.has(guildId);
  }

  withPinned(
    guildId: string,
    record: CommandRegistrationRecord | null,
  ): CommandRegistrationRecord | null {
    const pinned = this.#pins.get(guildId);
    if (!pinned) return record;

    const base = record ?? blankRecord(guildId, pinned.scope);
    return {
      ...base,
      commands: pinned.commands,
      idHistory: { ...base.idHistory, ...pinned.idHistory },
    };
  }

  #read(guildId: string): Promise<CachedRecord> {
    const pending = this.#inflight.get(guildId);
    if (pending) return pending;

    const generation = this.#generation.get(guildId) ?? 0;
    const promise = this.#store
      .get(guildId)
      .then((stored) => {
        if ((this.#generation.get(guildId) ?? 0) !== generation) {
          return { stored, record: this.withPinned(guildId, stored) };
        }
        return this.#remember(guildId, stored);
      })
      .finally(() => {
        if (this.#inflight.get(guildId) === promise) this.#inflight.delete(guildId);
      });

    this.#inflight.set(guildId, promise);
    return promise;
  }

  #bump(guildId: string): void {
    this.#generation.set(guildId, (this.#generation.get(guildId) ?? 0) + 1);
    this.#inflight.delete(guildId);
  }

  #rememberAgain(guildId: string): void {
    const cached = this.#records.get(guildId);
    if (cached) this.#remember(guildId, cached.stored);
  }

  #remember(guildId: string, stored: CommandRegistrationRecord | null): CachedRecord {
    const entry = { stored, record: this.withPinned(guildId, stored) };
    this.#records.delete(guildId);
    this.#records.set(guildId, entry);

    while (this.#records.size > this.#max) {
      const oldest = this.#records.keys().next().value;
      if (oldest === undefined) break;
      this.#records.delete(oldest);
      this.#generation.delete(oldest);
    }
    return entry;
  }
}

export type FailureClass = 'access' | 'daily-limit' | 'refused' | 'rate-limited' | 'unavailable';

export type PutResult =
  | { status: number; body: unknown }
  | { status: null; error: 'timeout' | 'network'; message: string };

const discordErrorSchema = z.object({
  code: z.number().int().optional(),
  message: z.string().optional(),
  errors: z.unknown().optional(),
  retry_after: z.number().nonnegative().optional(),
});

function discordError(body: unknown): z.infer<typeof discordErrorSchema> {
  const parsed = discordErrorSchema.safeParse(body);
  return parsed.success ? parsed.data : {};
}

export function classifyFailure(status: number | null, code: number | null): FailureClass {
  if (status === null || status === 401) return 'unavailable';
  if (code === 50001 || status === 403) return 'access';
  if (code === 30034) return 'daily-limit';
  if (status === 429) return 'rate-limited';
  if (status >= 400 && status < 500) return 'refused';
  return 'unavailable';
}

export function failureClass(failure: Pick<CommandRegistrationFailure, 'status' | 'code'>) {
  const code = failure.code === null ? null : Number(failure.code);
  return classifyFailure(failure.status, Number.isInteger(code) ? code : null);
}

function clip(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;
}

function detailOf(result: PutResult): string {
  if (result.status === null) return clip(result.message);
  if (typeof result.body === 'string') return clip(result.body);

  const error = discordError(result.body);
  const parts = [
    error.message ?? `HTTP ${result.status}`,
    ...(error.code === undefined ? [] : [`(code ${error.code})`]),
    ...(error.errors === undefined ? [] : [JSON.stringify(error.errors)]),
  ];
  return clip(parts.join(' '));
}

function messageOf(result: PutResult, klass: FailureClass, code: number | null): string {
  if (result.status === null) {
    return result.error === 'timeout'
      ? `Discord took longer than ${PUT_TIMEOUT_MS / 1000} seconds to answer, so Proton can't ` +
          "tell whether this server's commands were updated."
      : "Proton couldn't reach Discord to update this server's commands, so the server keeps its " +
          'previous ones.';
  }

  switch (klass) {
    case 'access':
      return (
        "Proton can't manage commands in this server because it's missing the " +
        'applications.commands scope. Add Proton to the server again to grant it.'
      );
    case 'daily-limit':
      return 'Discord allows 200 new commands per server per day, and this server has used them all.';
    case 'rate-limited':
      return 'Discord is rate limiting command updates.';
    case 'refused':
      if (code === 30032) {
        return (
          "Proton has reached Discord's limit on commands in this server, so its commands " +
          "couldn't be updated. Turn some commands off on this page to make room."
        );
      }
      if (code === 50035) {
        return (
          'Discord refused the command definitions as invalid, so this server keeps its previous ' +
          'commands. The detail below names the field. Edit or reset that command to fix it.'
        );
      }
      return (
        `Discord refused to update this server's commands (HTTP ${result.status}), so the server ` +
        'keeps its previous ones.'
      );
    case 'unavailable':
      if (result.status === 401) {
        return (
          "Discord rejected Proton's own credentials, so this server's commands couldn't be " +
          "updated. The problem is on Proton's side, not in this server's settings."
        );
      }
      return result.status < 300
        ? "Proton couldn't read Discord's answer to the update, so it registers the commands " +
            'again to be sure.'
        : "Proton couldn't reach Discord to update this server's commands, so the server keeps " +
            'its previous ones.';
  }
}

export function accessWait(previous: CommandRegistrationFailure | null): number {
  if (!previous || previous.retryAt === null || failureClass(previous) !== 'access') {
    return ACCESS_RETRY_MS;
  }
  const last = Date.parse(previous.retryAt) - Date.parse(previous.at);
  if (!Number.isFinite(last) || last < ACCESS_RETRY_MS) return ACCESS_RETRY_MS;
  return Math.min(ACCESS_RETRY_CAP_MS, last * 2);
}

export function describeFailure(
  result: PutResult,
  context: { at: number; hash: string; backoffMs: number; accessWaitMs?: number },
): CommandRegistrationFailure {
  const error = result.status === null ? {} : discordError(result.body);
  const code = error.code ?? null;
  const klass = classifyFailure(result.status, code);

  const retryInMs: Record<FailureClass, number | null> = {
    access: context.accessWaitMs ?? ACCESS_RETRY_MS,
    refused: null,
    'daily-limit': DAILY_LIMIT_MS,
    'rate-limited': Math.max(1_000, Math.ceil((error.retry_after ?? 1) * 1_000)),
    unavailable: context.backoffMs,
  };
  const wait = retryInMs[klass];

  return {
    code: code === null ? null : String(code),
    status: result.status,
    message: messageOf(result, klass, code),
    detail: detailOf(result),
    at: new Date(context.at).toISOString(),
    retryAt: wait === null ? null : new Date(context.at + wait).toISOString(),
    hash: context.hash,
  };
}

const discordCommandSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.number().int().default(1),
});

type DiscordCommand = z.infer<typeof discordCommandSchema>;

const permissionEntrySchema = z.object({
  id: z.string(),
  permissions: z.array(z.unknown()).default([]),
});

function kindOfType(type: number): CommandKind {
  if (type === 2) return 'user';
  if (type === 3) return 'message';
  return 'chat';
}

function keyOfGlobal(command: DiscordCommand): string {
  const kind = kindOfType(command.type);
  return kind === 'chat' ? command.name : contextMenuKey(kind, command.name);
}

function slot(kind: CommandKind, name: string): string {
  return `${kind}:${kind === 'chat' ? name : name.toLowerCase()}`;
}

export function registeredFrom(
  commands: readonly EffectiveCommand[],
  body: unknown,
): RegisteredCommand[] | null {
  const parsed = z.array(discordCommandSchema).safeParse(body);
  if (!parsed.success) return null;

  const returned = new Map(
    parsed.data.map((command) => [slot(kindOfType(command.type), command.name), command]),
  );

  return commands.flatMap((command) => {
    const hit = returned.get(slot(command.kind, command.body.name));
    return hit ? [{ key: command.key, id: hit.id, name: hit.name, kind: command.kind }] : [];
  });
}

function withoutIds(commands: readonly EffectiveCommand[]): EffectiveCommand[] {
  return commands.map(({ key, kind, body }) => {
    const { id: _id, ...rest } = body;
    return { key, kind, body: rest as EffectiveCommand['body'] };
  });
}

export function namesTakenFromOtherKeys(
  commands: readonly EffectiveCommand[],
  recorded: readonly RegisteredCommand[],
): Array<{ key: string; from: string; name: string }> {
  const holders = new Map(recorded.map((command) => [slot(command.kind, command.name), command]));

  return commands.flatMap((command) => {
    const holder = holders.get(slot(command.kind, command.body.name));
    return holder && holder.key !== command.key
      ? [{ key: command.key, from: holder.key, name: command.body.name }]
      : [];
  });
}

export interface ReconcileOptions {
  skipHash?: boolean;
  ignoreHolds?: boolean;
  liftAccess?: boolean;
}

export interface RetirementBlocker {
  guildId: string;
  reason: string;
}

export interface Retirement {
  status: 'retired' | 'kept' | 'none';
  blockers: RetirementBlocker[];
}

export type ReconcileOutcome =
  | { status: 'out-of-scope' }
  | { status: 'unchanged' }
  | { status: 'registered'; count: number }
  | {
      status: 'held';
      reason: 'no-access' | 'refused' | 'retry-later';
      retryInMs: number | null;
    }
  | { status: 'failed'; failure: CommandRegistrationFailure; retryInMs: number | null }
  | { status: 'error'; retryInMs: number };

export interface CommandSyncerDeps {
  rest: RestProxyClient;
  rail: CommandRegistrationRail;
  catalogue: readonly CatalogueEntry[];
  views: CommandWorkerViewSource;
  store: RegistrationStore;
  records: CommandRecordCache;
  logger: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function blankRecord(guildId: string, scope: CommandRegistrationScope): CommandRegistrationRecord {
  return {
    guildId,
    scope,
    definitionHash: null,
    commands: [],
    idHistory: {},
    checkedAt: null,
    syncedAt: null,
    failure: null,
    permissionsCheckedAt: null,
    lostPermissions: null,
  };
}

function listed(guildIds: readonly string[]): string {
  const shown = guildIds.slice(0, 25).join(', ');
  return guildIds.length > 25 ? `${shown} and ${guildIds.length - 25} more` : shown;
}

export class CommandSyncer {
  readonly #deps: CommandSyncerDeps;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #attempts = new Map<string, number>();
  #globals: DiscordCommand[] | null = null;
  #retired = false;
  #retiring: Promise<Retirement> | null = null;

  constructor(deps: CommandSyncerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get globalRetired(): boolean {
    return this.#deps.rail.scope !== 'every-guild' || this.#retired;
  }

  async reconcile(guildId: string, options: ReconcileOptions = {}): Promise<ReconcileOutcome> {
    const { rail, logger } = this.#deps;
    if (!inRegistrationScope(rail, guildId)) return { status: 'out-of-scope' };

    let view: CommandWorkerView;
    let record: CommandRegistrationRecord | null;
    let checkedAt: string;
    try {
      // DB time before the view read, less a margin: a write-time stamp would hide missed saves.
      const read = Date.parse(await this.#deps.store.now());
      checkedAt = new Date(read - CHECK_MARGIN_MS).toISOString();
      [view, record] = await Promise.all([
        this.#deps.views.get(guildId),
        this.#deps.store.get(guildId),
      ]);
    } catch (error) {
      const retryInMs = this.#backoff(guildId);
      logger.warn(
        `could not read what server ${guildId}'s commands should be, so they were not checked; ` +
          `retrying in ${Math.round(retryInMs / 1000)} s: ${
            error instanceof Error ? error.message : String(error)
          }`,
        { guildId },
      );
      return { status: 'error', retryInMs };
    }

    this.#deps.records.set(guildId, record);
    const pinned = this.#deps.records.pinned(guildId);

    const set = effectiveCommandSet({
      catalogue: this.#deps.catalogue,
      modulesOn: view.modulesOn,
      settings: view.settings,
      recorded: this.#deps.records.withPinned(guildId, record)?.commands,
    });
    const hash = await commandSetHash(set.commands);

    record = await this.#checkPermissions(guildId, record);

    // A pin means Discord holds a set the stored hash does not describe, so the hash proves nothing.
    if (
      !options.skipHash &&
      !pinned &&
      record?.definitionHash === hash &&
      record.scope === rail.scope
    ) {
      try {
        await this.#deps.store.recordChecked(guildId, { scope: rail.scope, hash, checkedAt });
      } catch (error) {
        logger.warn(`could not record that server ${guildId}'s commands are up to date`, {
          guildId,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      this.#deps.records.set(guildId, { ...record, checkedAt });
      this.#attempts.delete(guildId);
      return { status: 'unchanged' };
    }

    const held = options.ignoreHolds ? null : this.#held(record, hash, options.liftAccess === true);
    if (held) {
      await this.#recordHeld(guildId, record, hash, checkedAt);
      return held;
    }

    return this.#register(guildId, set.commands, hash, record, checkedAt);
  }

  #held(
    record: CommandRegistrationRecord | null,
    hash: string,
    liftAccess: boolean,
  ): ReconcileOutcome | null {
    const failure = record?.failure;
    if (!failure) return null;

    const klass = failureClass(failure);
    if (klass === 'access' && liftAccess) return null;
    const due = failure.retryAt === null ? null : Date.parse(failure.retryAt) - this.#now();
    if (due !== null && due > 0) {
      return {
        status: 'held',
        reason: klass === 'access' ? 'no-access' : 'retry-later',
        retryInMs: due <= BACKOFF_CAP_MS ? due : null,
      };
    }

    if (klass === 'refused' && failure.hash === hash) {
      return { status: 'held', reason: 'refused', retryInMs: null };
    }

    return null;
  }

  async #recordHeld(
    guildId: string,
    record: CommandRegistrationRecord | null,
    hash: string,
    checkedAt: string,
  ): Promise<void> {
    const { rail, logger, store } = this.#deps;
    const input: RegistrationHeld = { scope: rail.scope, hash, checkedAt };

    try {
      await store.recordHeld(guildId, input);
    } catch (error) {
      logger.warn(`could not record why server ${guildId}'s commands are still waiting`, {
        guildId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    if (record?.failure) {
      this.#deps.records.set(guildId, {
        ...record,
        scope: rail.scope,
        failure: { ...record.failure, hash },
        checkedAt,
      });
    }
  }

  async #register(
    guildId: string,
    commands: EffectiveCommand[],
    hash: string,
    record: CommandRegistrationRecord | null,
    checkedAt: string,
  ): Promise<ReconcileOutcome> {
    const { rail, logger, store } = this.#deps;
    const known = this.#deps.records.withPinned(guildId, record);

    let sent = commands;
    let result = await this.#put(guildId, sent);

    const refused =
      result.status !== null &&
      result.status >= 400 &&
      classifyFailure(result.status, discordError(result.body).code ?? null) === 'refused';
    if (refused && sent.some((command) => command.body.id !== undefined)) {
      const moving = namesTakenFromOtherKeys(commands, known?.commands ?? []);
      if (moving.length > 0) {
        logger.warn(
          `Discord refused server ${guildId}'s commands with their ids, and they were not sent ` +
            'again without them, because Discord would then match by name and hand ' +
            moving.map((move) => `/${move.from}'s id to /${move.key}`).join(', ') +
            ` along with its Integrations permissions: ${detailOf(result)}`,
          { guildId },
        );
      } else {
        logger.warn(
          `Discord refused server ${guildId}'s commands with their ids, so they were sent again ` +
            `without them: ${detailOf(result)}`,
          { guildId },
        );
        sent = withoutIds(commands);
        result = await this.#put(guildId, sent);
      }
    }

    const at = this.#now();
    const registered =
      result.status !== null && result.status < 300 ? registeredFrom(sent, result.body) : null;

    if (registered) {
      this.#attempts.delete(guildId);
      if (registered.length < sent.length) {
        logger.warn(
          `Discord's answer for server ${guildId} left out ${sent.length - registered.length} ` +
            'command(s), so their ids are not recorded',
          { guildId },
        );
      }

      let recorded = false;
      try {
        recorded = await store.recordSuccess(guildId, {
          scope: rail.scope,
          hash,
          commands: registered,
          checkedAt,
        });
      } catch (error) {
        logger.error(
          `registered server ${guildId}'s commands but could not record it, so the next check ` +
            `registers them again: ${error instanceof Error ? error.message : String(error)}`,
          { guildId },
        );
      }

      const base = known ?? blankRecord(guildId, rail.scope);
      const idHistory = {
        ...base.idHistory,
        ...Object.fromEntries(registered.map((command) => [command.id, command.key])),
      };
      if (recorded) {
        this.#deps.records.unpin(guildId);
        this.#deps.records.set(guildId, {
          ...base,
          scope: rail.scope,
          definitionHash: hash,
          commands: registered,
          idHistory,
          checkedAt,
          syncedAt: new Date(at).toISOString(),
          failure: null,
        });
      } else {
        // Discord now holds these ids, so dispatch routes by them here until a sync records them.
        this.#deps.records.pin(guildId, { scope: rail.scope, commands: registered, idHistory });
      }

      logger.info(`registered ${registered.length} command(s) in server ${guildId}`, {
        guildId,
        recorded,
      });
      return { status: 'registered', count: registered.length };
    }

    const klass =
      result.status === null
        ? 'unavailable'
        : classifyFailure(result.status, discordError(result.body).code ?? null);
    const backoffMs = klass === 'unavailable' ? this.#backoff(guildId) : 0;
    const failure = describeFailure(result, {
      at,
      hash,
      backoffMs,
      accessWaitMs: accessWait(record?.failure ?? null),
    });

    try {
      await store.recordFailure(guildId, { scope: rail.scope, failure, checkedAt });
    } catch (error) {
      logger.error(`could not record why server ${guildId}'s commands failed to register`, {
        guildId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    this.#deps.records.set(guildId, {
      ...(record ?? blankRecord(guildId, rail.scope)),
      scope: rail.scope,
      definitionHash: null,
      failure,
      checkedAt,
    });

    const retryInMs =
      klass === 'rate-limited' || (klass === 'unavailable' && backoffMs < BACKOFF_CAP_MS)
        ? Date.parse(failure.retryAt ?? '') - at
        : null;

    logger.warn(
      `could not register commands in server ${guildId}: ${failure.message} Discord said: ` +
        failure.detail,
      { guildId, status: failure.status, code: failure.code, retryAt: failure.retryAt },
    );

    return {
      status: 'failed',
      failure,
      retryInMs: retryInMs === null || Number.isNaN(retryInMs) ? null : retryInMs,
    };
  }

  async #put(guildId: string, commands: readonly EffectiveCommand[]): Promise<PutResult> {
    try {
      return await putCommands(
        this.#deps.rest,
        this.#deps.rail,
        guildId,
        commands.map((command) => command.body),
      );
    } catch (error) {
      if (error instanceof RegistrationScopeError) throw error;
      if (error instanceof RestTimeoutError) {
        return { status: null, error: 'timeout', message: error.message };
      }
      return {
        status: null,
        error: 'network',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  #backoff(guildId: string): number {
    const attempt = (this.#attempts.get(guildId) ?? 0) + 1;
    this.#attempts.set(guildId, attempt);
    return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  }

  async #globalCommands(fresh: boolean): Promise<DiscordCommand[] | null> {
    if (this.globalRetired) return [];
    if (this.#globals && !fresh) return this.#globals;

    const { rest, rail, logger } = this.#deps;
    try {
      const response = await rest.request({
        method: 'GET',
        path: commandsPath(rail, null),
        timeoutMs: DISCORD_READ_TIMEOUT_MS,
      });
      const parsed = z.array(discordCommandSchema).safeParse(response.body);
      if (response.status >= 400 || !parsed.success) {
        logger.warn(
          `could not read Proton's global commands: Discord answered ${response.status}, so ` +
            'the global set is kept for now',
        );
        return null;
      }

      this.#globals = parsed.data;
      if (parsed.data.length === 0) this.#retired = true;
      return parsed.data;
    } catch (error) {
      if (error instanceof RegistrationScopeError) throw error;
      logger.warn(
        `could not read Proton's global commands, so the global set is kept for now: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async #readLost(
    guildId: string,
    globals: readonly DiscordCommand[],
  ): Promise<LostCommand[] | null> {
    const { rest, rail, logger } = this.#deps;

    try {
      const response = await rest.request({
        method: 'GET',
        path: `${commandsPath(rail, guildId)}/permissions`,
        timeoutMs: DISCORD_READ_TIMEOUT_MS,
      });
      const parsed = z.array(permissionEntrySchema).safeParse(response.body);
      if (response.status >= 400 || !parsed.success) {
        logger.warn(
          `could not read which commands have Integrations permissions in server ${guildId}: ` +
            `Discord answered ${response.status}. It is checked again next time.`,
          { guildId },
        );
        return null;
      }

      const byId = new Map(globals.map((command) => [command.id, command]));
      return parsed.data.flatMap((entry) => {
        const global = entry.permissions.length > 0 ? byId.get(entry.id) : undefined;
        return global ? [{ key: keyOfGlobal(global), name: global.name }] : [];
      });
    } catch (error) {
      if (error instanceof RegistrationScopeError) throw error;
      logger.warn(
        `could not check the Integrations permissions of server ${guildId}; it is checked again ` +
          `next time: ${error instanceof Error ? error.message : String(error)}`,
        { guildId },
      );
      return null;
    }
  }

  async #checkPermissions(
    guildId: string,
    record: CommandRegistrationRecord | null,
  ): Promise<CommandRegistrationRecord | null> {
    const { rail, logger, store } = this.#deps;
    if (rail.scope !== 'every-guild' || record?.permissionsCheckedAt) return record;
    if (record?.failure && failureClass(record.failure) === 'access') return record;

    const globals = await this.#globalCommands(false);
    if (globals === null || globals.length === 0) return record;

    const lost = await this.#readLost(guildId, globals);
    if (lost === null) return record;

    const at = new Date(this.#now()).toISOString();
    try {
      await store.recordPermissions(guildId, { scope: rail.scope, lost, at });
    } catch (error) {
      logger.warn(
        `could not record the Integrations permissions of server ${guildId}; they are checked ` +
          `again next time: ${error instanceof Error ? error.message : String(error)}`,
        { guildId },
      );
      return record;
    }

    if (lost.length > 0) {
      logger.warn(
        `server ${guildId} set Integrations permissions on ${lost.length} global command(s); ` +
          'the dashboard asks its admins to set them again once the global set is retired',
        { guildId, commands: lost.map((command) => command.name).join(', ') },
      );
    }

    const next = record ?? blankRecord(guildId, rail.scope);
    const updated: CommandRegistrationRecord = {
      ...next,
      permissionsCheckedAt: at,
      lostPermissions: lost.length > 0 ? { commands: lost, at } : next.lostPermissions,
    };
    this.#deps.records.set(guildId, updated);
    return updated;
  }

  async #recheckPermissions(
    candidates: readonly CommandRegistrationRecord[],
    globals: readonly DiscordCommand[],
    blockers: RetirementBlocker[],
  ): Promise<void> {
    const { rail, logger, store } = this.#deps;

    for (const record of candidates) {
      const { guildId } = record;
      let lost = await this.#readLost(guildId, globals);
      for (const wait of PERMISSIONS_REREAD_WAITS_MS) {
        if (lost !== null) break;
        await this.#sleep(wait);
        lost = await this.#readLost(guildId, globals);
      }
      if (lost === null) {
        blockers.push({ guildId, reason: 'permissions-unreadable' });
        continue;
      }

      const known = record.lostPermissions?.commands ?? [];
      const found = lost.filter((command) => !known.some((seen) => seen.key === command.key));
      if (found.length === 0) continue;

      try {
        await store.recordPermissions(guildId, {
          scope: rail.scope,
          lost: [...known, ...found],
          at: new Date(this.#now()).toISOString(),
        });
      } catch {
        blockers.push({ guildId, reason: 'permissions-unrecorded' });
        continue;
      }

      logger.warn(
        `server ${guildId} set Integrations permissions on ${found.length} more global ` +
          'command(s) since they were first read; the dashboard asks its admins to set them ' +
          'again once the global set is retired',
        { guildId, commands: found.map((command) => command.name).join(', ') },
      );
    }
  }

  retireGlobal(guildIds: readonly string[]): Promise<Retirement> {
    this.#retiring ??= this.#retire(guildIds).finally(() => {
      this.#retiring = null;
    });
    return this.#retiring;
  }

  async #retire(guildIds: readonly string[]): Promise<Retirement> {
    if (this.globalRetired) return { status: 'none', blockers: [] };

    const { rest, rail, logger, store } = this.#deps;
    const globals = await this.#globalCommands(true);
    if (globals === null) return { status: 'kept', blockers: [] };
    if (globals.length === 0) return { status: 'none', blockers: [] };

    const blockers: RetirementBlocker[] = [];
    const excepted: string[] = [];
    const candidates: CommandRegistrationRecord[] = [];

    for (const guildId of guildIds) {
      let record: CommandRegistrationRecord | null;
      try {
        record = await store.get(guildId);
      } catch {
        blockers.push({ guildId, reason: 'unreadable' });
        continue;
      }

      if (record?.failure && failureClass(record.failure) === 'access') {
        excepted.push(guildId);
      } else if (!record) {
        blockers.push({ guildId, reason: 'unsynced' });
      } else if (record.definitionHash === null) {
        blockers.push({
          guildId,
          reason: record.failure?.code ?? String(record.failure?.status ?? 'unsynced'),
        });
      } else if (record.permissionsCheckedAt === null) {
        blockers.push({ guildId, reason: 'permissions-unchecked' });
      } else {
        candidates.push(record);
      }
    }

    if (blockers.length === 0) {
      for (const record of candidates) {
        try {
          const view = await this.#deps.views.get(record.guildId);
          const set = effectiveCommandSet({
            catalogue: this.#deps.catalogue,
            modulesOn: view.modulesOn,
            settings: view.settings,
            recorded: record.commands,
          });
          if ((await commandSetHash(set.commands)) !== record.definitionHash) {
            blockers.push({ guildId: record.guildId, reason: 'pending' });
          }
        } catch {
          blockers.push({ guildId: record.guildId, reason: 'unreadable' });
        }
      }
    }

    if (blockers.length === 0) await this.#recheckPermissions(candidates, globals, blockers);

    if (excepted.length > 0) {
      logger.warn(
        `Proton can't manage commands in ${excepted.length} server(s), which do not hold up ` +
          `retiring the global commands: ${listed(excepted)}`,
      );
    }

    if (blockers.length > 0) {
      logger.info(
        `kept Proton's ${globals.length} global command(s), because ${blockers.length} server(s) ` +
          `are not synced yet: ${listed(blockers.map((b) => `${b.guildId} (${b.reason})`))}. ` +
          'The next sweep checks again.',
        { blockers: blockers.length },
      );
      return { status: 'kept', blockers };
    }

    try {
      const response = await putCommands(rest, rail, null, []);
      if (response.status >= 400) {
        logger.error(
          `could not retire Proton's global commands: Discord answered ${response.status}. ` +
            'The next sweep tries again.',
        );
        return { status: 'kept', blockers: [] };
      }
    } catch (error) {
      if (error instanceof RegistrationScopeError) throw error;
      logger.error(
        `could not retire Proton's global commands; the next sweep tries again: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { status: 'kept', blockers: [] };
    }

    this.#retired = true;
    this.#globals = [];
    logger.info(
      `retired Proton's ${globals.length} global command(s): every server now has its own commands`,
    );
    return { status: 'retired', blockers: [] };
  }
}

export type SyncLane = 'interactive' | 'bulk';

export const DRIFT_RECONCILE: { lane: SyncLane } & ReconcileOptions = {
  lane: 'interactive',
  skipHash: true,
  liftAccess: true,
};

interface SyncJob {
  lane: SyncLane;
  skipHash: boolean;
  ignoreHolds: boolean;
  liftAccess: boolean;
}

export interface SyncTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: SyncTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CommandSyncQueue {
  readonly #syncer: Pick<CommandSyncer, 'reconcile'>;
  readonly #logger: Logger;
  readonly #timers: SyncTimers;
  readonly #lanes: Record<SyncLane, Map<string, SyncJob>> = {
    interactive: new Map(),
    bulk: new Map(),
  };
  readonly #retries = new Map<string, unknown>();
  #pumping: Promise<void> | null = null;
  #idle: Array<() => void> = [];
  #closed = false;

  constructor(deps: {
    syncer: Pick<CommandSyncer, 'reconcile'>;
    logger: Logger;
    timers?: SyncTimers;
  }) {
    this.#syncer = deps.syncer;
    this.#logger = deps.logger;
    this.#timers = deps.timers ?? realTimers;
  }

  enqueue(guildId: string, options: { lane?: SyncLane } & ReconcileOptions = {}): void {
    if (this.#closed) return;

    const lane = options.lane ?? 'interactive';
    const waiting = this.#lanes.interactive.get(guildId) ?? this.#lanes.bulk.get(guildId);
    const merged: SyncJob = {
      lane: lane === 'interactive' || waiting?.lane === 'interactive' ? 'interactive' : 'bulk',
      skipHash: options.skipHash === true || waiting?.skipHash === true,
      ignoreHolds: options.ignoreHolds === true || waiting?.ignoreHolds === true,
      liftAccess: options.liftAccess === true || waiting?.liftAccess === true,
    };

    if (waiting && waiting.lane !== merged.lane) this.#lanes[waiting.lane].delete(guildId);
    this.#lanes[merged.lane].set(guildId, merged);

    this.#pump();
  }

  cancel(guildId: string): void {
    this.#lanes.interactive.delete(guildId);
    this.#lanes.bulk.delete(guildId);
    this.#clearRetry(guildId);
  }

  pending(): number {
    return this.#lanes.interactive.size + this.#lanes.bulk.size;
  }

  idle(): Promise<void> {
    if (!this.#pumping && this.pending() === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#lanes.interactive.clear();
    this.#lanes.bulk.clear();
    for (const guildId of [...this.#retries.keys()]) this.#clearRetry(guildId);
    await this.#pumping;
    this.#settle();
  }

  #take(): [string, SyncJob] | null {
    for (const lane of ['interactive', 'bulk'] as const) {
      const first = this.#lanes[lane].entries().next();
      if (!first.done) {
        this.#lanes[lane].delete(first.value[0]);
        return first.value;
      }
    }
    return null;
  }

  #pump(): void {
    if (this.#pumping) return;

    this.#pumping = (async () => {
      for (let next = this.#take(); next; next = this.#take()) {
        const [guildId, job] = next;
        this.#clearRetry(guildId);

        try {
          const outcome = await this.#syncer.reconcile(guildId, {
            skipHash: job.skipHash,
            ignoreHolds: job.ignoreHolds,
            liftAccess: job.liftAccess,
          });
          this.#after(guildId, job, outcome);
        } catch (error) {
          this.#logger.error(
            `checking server ${guildId}'s commands failed unexpectedly: ${
              error instanceof Error ? (error.stack ?? error.message) : String(error)
            }`,
            { guildId },
          );
        }
      }
    })().finally(() => {
      this.#pumping = null;
      if (this.pending() > 0 && !this.#closed) this.#pump();
      else this.#settle();
    });
  }

  #settle(): void {
    const waiting = this.#idle;
    this.#idle = [];
    for (const resolve of waiting) resolve();
  }

  #after(guildId: string, job: SyncJob, outcome: ReconcileOutcome): void {
    const retryInMs =
      outcome.status === 'failed' || outcome.status === 'held' || outcome.status === 'error'
        ? outcome.retryInMs
        : null;
    if (retryInMs === null || this.#closed) return;

    this.#clearRetry(guildId);
    const handle = this.#timers.set(() => {
      this.#retries.delete(guildId);
      this.enqueue(guildId, { lane: job.lane });
    }, retryInMs + RETRY_MARGIN_MS);
    this.#retries.set(guildId, handle);
  }

  #clearRetry(guildId: string): void {
    const handle = this.#retries.get(guildId);
    if (handle === undefined) return;
    this.#timers.clear(handle);
    this.#retries.delete(guildId);
  }
}

export interface RollbackReport {
  removed: string[];
  failed: Array<{ guildId: string; detail: string }>;
}

export async function rollbackGuildCommands(deps: {
  rest: RestProxyClient;
  rail: CommandRegistrationRail;
  guildIds: readonly string[];
  store: Pick<RegistrationStore, 'forget'>;
  print(line: string): void;
}): Promise<RollbackReport> {
  const report: RollbackReport = { removed: [], failed: [] };

  for (const guildId of deps.guildIds) {
    if (!inRegistrationScope(deps.rail, guildId)) continue;

    let result: PutResult;
    try {
      result = await putCommands(deps.rest, deps.rail, guildId, []);
    } catch (error) {
      if (error instanceof RegistrationScopeError) throw error;
      result = {
        status: null,
        error: error instanceof RestTimeoutError ? 'timeout' : 'network',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.status !== null && result.status < 300) {
      await deps.store.forget(guildId);
      report.removed.push(guildId);
      deps.print(`removed Proton's commands from server ${guildId}`);
    } else {
      const detail = detailOf(result);
      report.failed.push({ guildId, detail });
      deps.print(`FAILED: server ${guildId} keeps its commands and its record: ${detail}`);
    }
  }

  return report;
}
