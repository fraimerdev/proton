import { REST } from '@discordjs/rest';
import { CloseCodes, WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import type { EventBus, ProtonEvent } from '@proton/core';
import type { GatewayPresenceUpdateData } from 'discord-api-types/v10';
import { normalise, type RawDispatch } from './normaliser.ts';
import type { RedisSessionStore, SessionInfo } from './session-store.ts';

export interface GatewayLog {
  warn(message: string): void;
  error(message: string): void;
}

export const PUBLISH_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 5_000, 15_000, 30_000];
export const PUBLISH_TIMEOUT_MS = 5_000;
export const SHUTDOWN_DRAIN_MS = 7_000;
export const UNPUBLISHED_EXIT_CODE = 1;

export interface GatewayManagerOptions {
  token: string;
  intents: number;
  presence: GatewayPresenceUpdateData;
  restProxyUrl: string;
  store: Pick<RedisSessionStore, 'retrieveSessionInfo' | 'updateSessionInfo'>;
  bus: EventBus;
  onEvent?: (type: string) => void;
  log?: GatewayLog;
  publishRetryDelaysMs?: readonly number[];
  publishTimeoutMs?: number;
  shutdownDrainMs?: number;
  exit?: (code: number) => void;
}

export interface GatewayManager {
  ws: WebSocketManager;
  shutdown(reason: string): Promise<void>;
}

class DeliveryWatermark {
  #value: number;
  readonly #sequences: number[] = [];
  readonly #tracked = new Set<number>();
  readonly #published = new Set<number>();

  constructor(value: number) {
    this.#value = value;
  }

  get value(): number {
    return this.#value;
  }

  observe(sequence: number): void {
    if (sequence <= this.#value || this.#tracked.has(sequence)) return;
    this.#tracked.add(sequence);

    const last = this.#sequences.at(-1);
    if (last === undefined || sequence > last) this.#sequences.push(sequence);
    else
      this.#sequences.splice(
        this.#sequences.findIndex((s) => s > sequence),
        0,
        sequence,
      );
  }

  publish(sequence: number): boolean {
    if (!this.#tracked.has(sequence)) return false;
    this.#published.add(sequence);

    const before = this.#value;
    let head = this.#sequences[0];
    while (head !== undefined && this.#published.has(head)) {
      this.#sequences.shift();
      this.#tracked.delete(head);
      this.#published.delete(head);
      this.#value = head;
      head = this.#sequences[0];
    }
    return this.#value !== before;
  }
}

interface ShardSession {
  info: SessionInfo;
  watermark: DeliveryWatermark;
}

interface PendingWrite {
  info: SessionInfo | null;
  written: PromiseWithResolvers<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function subject(event: ProtonEvent, shardId: number, sequence: number): string {
  return `${event.type} event ${event.id} (shard ${shardId}, sequence ${sequence})`;
}

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the bus did not answer within ${ms}ms`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

function finishedBy(work: Promise<unknown>, deadline: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()));
  });
  return Promise.race([work.then(() => true), expired]).finally(() => clearTimeout(timer));
}

export function createGatewayManager(options: GatewayManagerOptions): GatewayManager {
  const rest = new REST({ version: '10', api: `${options.restProxyUrl.replace(/\/$/, '')}/api` });
  rest.setToken(options.token);

  const log = options.log ?? console;
  const retryDelays = options.publishRetryDelaysMs ?? PUBLISH_RETRY_DELAYS_MS;
  const publishTimeoutMs = options.publishTimeoutMs ?? PUBLISH_TIMEOUT_MS;
  const shutdownDrainMs = options.shutdownDrainMs ?? SHUTDOWN_DRAIN_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const sessionIds = new Map<number, string>();
  const sessions = new Map<number, ShardSession | null>();
  const pendingWrites = new Map<number, PendingWrite>();
  const drainingShards = new Set<number>();
  const writers = new Map<number, Promise<void>>();
  const unpublished = new Set<{ what: string }>();
  const settling = new Set<Promise<void>>();

  let stopped = false;
  let exiting = false;
  let stopping: Promise<void> | undefined;

  function adopt(shardId: number, info: SessionInfo | null): void {
    sessions.set(
      shardId,
      info ? { info: { ...info }, watermark: new DeliveryWatermark(info.sequence) } : null,
    );
  }

  async function drainWrites(shardId: number): Promise<void> {
    drainingShards.add(shardId);
    for (let next = pendingWrites.get(shardId); next; next = pendingWrites.get(shardId)) {
      pendingWrites.delete(shardId);
      try {
        await options.store.updateSessionInfo(shardId, next.info);
      } catch (error) {
        const action = next.info
          ? `store resume sequence ${next.info.sequence}`
          : 'delete the stored session';
        log.error(`gateway: could not ${action} for shard ${shardId}: ${describe(error)}`);
      }
      next.written.resolve();
    }
    drainingShards.delete(shardId);
  }

  function persist(shardId: number, info: SessionInfo | null): Promise<void> {
    const pending = pendingWrites.get(shardId);
    if (pending) {
      pending.info = info;
      return pending.written.promise;
    }

    const written = Promise.withResolvers<void>();
    pendingWrites.set(shardId, { info, written });
    if (!drainingShards.has(shardId)) writers.set(shardId, drainWrites(shardId));
    return written.promise;
  }

  async function writesLanded(): Promise<void> {
    while (drainingShards.size > 0) await Promise.all(writers.values());
  }

  function settle(shardId: number, session: ShardSession | null, sequence: number): void {
    if (!session || sessions.get(shardId) !== session) return;
    if (!session.watermark.publish(sequence)) return;
    void persist(shardId, { ...session.info, sequence: session.watermark.value });
  }

  function count(event: ProtonEvent, shardId: number, sequence: number): void {
    try {
      options.onEvent?.(event.type);
    } catch (error) {
      log.warn(
        `gateway: the onEvent hook threw for ${subject(event, shardId, sequence)}; publishing it anyway: ${describe(error)}`,
      );
    }
  }

  function abandon(): void {
    stopped = true;
    if (exiting) return;
    exiting = true;
    exit(UNPUBLISHED_EXIT_CODE);
  }

  async function publish(event: ProtonEvent, shardId: number, sequence: number): Promise<boolean> {
    const attempts = retryDelays.length + 1;
    const delivery = { what: subject(event, shardId, sequence) };
    unpublished.add(delivery);

    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await withTimeout(options.bus.publish(event), publishTimeoutMs);
          return true;
        } catch (error) {
          const delay = retryDelays[attempt - 1];
          if (delay === undefined) {
            log.error(
              `gateway: gave up publishing ${delivery.what} after ${attempts} attempts: ${describe(error)}. Exiting with code ${UNPUBLISHED_EXIT_CODE} and keeping the stored session, so the restarted gateway resumes from below sequence ${sequence} and Discord replays it.`,
            );
            abandon();
            return false;
          }
          log.warn(
            `gateway: could not publish ${delivery.what}, attempt ${attempt} of ${attempts}; retrying in ${delay}ms: ${describe(error)}`,
          );
          await Bun.sleep(delay);
        }
      }
    } finally {
      unpublished.delete(delivery);
    }
  }

  const manager = new WebSocketManager({
    token: options.token,
    intents: options.intents,
    initialPresence: options.presence,
    rest,
    retrieveSessionInfo: async (shardId) => {
      if (!sessions.has(shardId)) {
        const stored = await options.store.retrieveSessionInfo(shardId);
        if (!sessions.has(shardId)) adopt(shardId, stored);
      }

      const current = sessions.get(shardId)?.info;
      if (!current) return null;
      sessionIds.set(shardId, current.sessionId);
      return { ...current };
    },
    updateSessionInfo: async (shardId, info) => {
      // A shard destroy that does not resume in-process deletes the session; shutdown keeps it.
      if (!info && stopped) return;
      if (info) sessionIds.set(shardId, info.sessionId);

      const current = sessions.get(shardId);
      if (info && current?.info.sessionId === info.sessionId) {
        current.info = { ...info, sequence: Math.max(info.sequence, current.info.sequence) };
        return;
      }

      adopt(shardId, info);
      await persist(shardId, info);
    },
  });

  manager.on(WebSocketShardEvents.Dispatch, (payload, shardId) => {
    if (stopped) return;

    const raw = payload as unknown as RawDispatch;
    const session = sessions.get(shardId) ?? null;
    const events = normalise(raw, { sessionId: sessionIds.get(shardId) });
    session?.watermark.observe(raw.s);

    if (events.length === 0) {
      settle(shardId, session, raw.s);
      return;
    }

    const deliveries = events.map((event) => {
      count(event, shardId, raw.s);
      return publish(event, shardId, raw.s);
    });
    const settled = Promise.all(deliveries).then((published) => {
      if (published.every(Boolean)) settle(shardId, session, raw.s);
    });
    settling.add(settled);
    void settled.finally(() => settling.delete(settled));
  });

  async function closeShards(reason: string): Promise<void> {
    try {
      await manager.destroy({ code: CloseCodes.Resuming, reason });
    } catch (error) {
      log.error(
        `gateway: closing the shards failed while shutting down; exiting anyway, which leaves the session resumable: ${describe(error)}`,
      );
    }
  }

  async function close(reason: string, deadline: number): Promise<void> {
    if (await finishedBy(closeShards(reason), deadline)) return;
    log.warn(
      `gateway: the shards had not closed within ${shutdownDrainMs}ms of shutting down; exiting anyway, which leaves the session resumable.`,
    );
  }

  async function drain(deadline: number): Promise<void> {
    if (!(await finishedBy(Promise.all(settling), deadline))) {
      const left = [...unpublished].map((delivery) => delivery.what);
      log.error(
        `gateway: shutting down with ${left.length} event(s) still unpublished after ${shutdownDrainMs}ms: ${left.join('; ')}. The stored session stays below them, so the next gateway resumes from before them and Discord replays them.`,
      );
    }

    if (!(await finishedBy(writesLanded(), deadline))) {
      log.error(
        `gateway: shutting down before the resume sequence for shard(s) ${[...drainingShards].join(', ')} reached the store; the next gateway resumes from the last one that did.`,
      );
    }
  }

  function shutdown(reason: string): Promise<void> {
    stopping ??= (async () => {
      stopped = true;
      const deadline = performance.now() + shutdownDrainMs;
      await Promise.all([close(reason, deadline), drain(deadline)]);
    })();
    return stopping;
  }

  return { ws: manager, shutdown };
}
