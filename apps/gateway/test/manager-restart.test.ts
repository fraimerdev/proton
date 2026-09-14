import { describe, expect, test } from 'bun:test';
import { CloseCodes } from '@discordjs/ws';
import type { EventBus, ProtonEvent } from '@proton/core';
import type { ServerWebSocket } from 'bun';
import { DEFAULT_PRESENCE } from '../src/env.ts';
import { createGatewayManager } from '../src/manager.ts';
import type { SessionInfo } from '../src/session-store.ts';

const GUILD = '900000000000000001';
const CHANNEL = '800000000000000001';
const SESSION = 'fake-gateway-session';
const TOKEN = 'not-a-real-token';

interface Frame {
  op: number;
  d: unknown;
}

function messageId(sequence: number): string {
  return `message.created:m0:${sequence}`;
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate() && performance.now() < deadline) await Bun.sleep(2);
  if (!predicate()) throw new Error(`timed out waiting for ${what}`);
}

function startFakeGateway() {
  const frames: Frame[] = [];
  const closes: number[] = [];
  let socket: ServerWebSocket<undefined> | undefined;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, srv) {
      if (new URL(request.url).pathname === '/api/v10/gateway/bot') {
        return Response.json({
          url: `ws://127.0.0.1:${srv.port}`,
          shards: 1,
          session_start_limit: {
            total: 1000,
            remaining: 1000,
            reset_after: 86_400_000,
            max_concurrency: 1,
          },
        });
      }
      if (srv.upgrade(request)) return;
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        socket = ws;
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
      },
      message(ws, message) {
        const frame = JSON.parse(String(message)) as Frame;
        frames.push(frame);
        if (frame.op === 1) ws.send(JSON.stringify({ op: 11 }));
      },
      close(_ws, code) {
        closes.push(code);
      },
    },
  });

  const wsUrl = `ws://127.0.0.1:${server.port}`;
  const dispatch = (t: string, s: number, d: Record<string, unknown>) => {
    socket?.send(JSON.stringify({ op: 0, t, s, d }));
  };

  return {
    url: `http://127.0.0.1:${server.port}`,
    wsUrl,
    frames,
    closes,
    sent: (op: number) => frames.filter((frame) => frame.op === op),
    dispatch,
    ready: (s: number) =>
      dispatch('READY', s, {
        v: 10,
        session_id: SESSION,
        resume_gateway_url: wsUrl,
        user: { id: '100000000000000001', username: 'proton', bot: true },
        guilds: [],
        shard: [0, 1],
        application: { id: '100000000000000001', flags: 0 },
      }),
    message: (s: number) =>
      dispatch('MESSAGE_CREATE', s, {
        id: `m0:${s}`,
        channel_id: CHANNEL,
        guild_id: GUILD,
        timestamp: '2026-09-13T00:00:00.000Z',
      }),
    stop: () => server.stop(true),
  };
}

function gatewayProcess(
  restUrl: string,
  stored: Map<number, SessionInfo>,
  hold: (event: ProtonEvent) => boolean = () => false,
) {
  const writes: (SessionInfo | null)[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const published: string[] = [];
  const held: (() => void)[] = [];
  const exits: number[] = [];

  const bus: EventBus = {
    publish: (event) => {
      if (hold(event)) return new Promise<void>((resolve) => held.push(resolve));
      published.push(event.id);
      return Promise.resolve();
    },
    subscribe: () => {
      throw new Error('the gateway only publishes');
    },
  };

  const gateway = createGatewayManager({
    token: TOKEN,
    intents: 0,
    presence: DEFAULT_PRESENCE,
    restProxyUrl: restUrl,
    store: {
      retrieveSessionInfo: async (shardId) => stored.get(shardId) ?? null,
      updateSessionInfo: async (shardId, info) => {
        writes.push(info);
        if (info) stored.set(shardId, info);
        else stored.delete(shardId);
      },
    },
    bus,
    log: { warn: (line) => warnings.push(line), error: (line) => errors.push(line) },
    exit: (code) => exits.push(code),
    publishRetryDelaysMs: [0],
    publishTimeoutMs: 30_000,
    shutdownDrainMs: 100,
  });

  return {
    gateway,
    writes,
    errors,
    published,
    exits,
    release() {
      for (const resolve of held.splice(0)) resolve();
    },
  };
}

describe('a gateway restart against a Discord gateway', () => {
  test('shutdown closes with a resumable code and leaves the stored session in place', async () => {
    const fake = startFakeGateway();
    const stored = new Map<number, SessionInfo>();
    const first = gatewayProcess(fake.url, stored);

    try {
      const connected = first.gateway.ws.connect();
      await until(() => fake.sent(2).length === 1, 'the identify');
      fake.ready(1);
      await connected;
      fake.message(2);
      await until(() => stored.get(0)?.sequence === 2, 'sequence 2 to be stored');

      await first.gateway.shutdown('received SIGTERM');
      await until(() => fake.closes.length === 1, 'the close frame');

      expect(fake.closes).toEqual([CloseCodes.Resuming]);
      expect(fake.closes[0]).not.toBe(1000);
      expect(fake.closes[0]).not.toBe(1001);
      expect(stored.get(0)).toEqual({
        sessionId: SESSION,
        sequence: 2,
        shardId: 0,
        shardCount: 1,
        resumeURL: fake.wsUrl,
      });
      expect(first.writes).not.toContain(null);
      expect(first.exits).toEqual([]);
    } finally {
      first.release();
      await fake.stop();
    }
  });

  test('the next gateway resumes from the published watermark and Discord replays the rest', async () => {
    const fake = startFakeGateway();
    const stored = new Map<number, SessionInfo>();
    const first = gatewayProcess(fake.url, stored, (event) => event.id === messageId(3));
    const second = gatewayProcess(fake.url, stored);

    try {
      const connected = first.gateway.ws.connect();
      await until(() => fake.sent(2).length === 1, 'the identify');
      fake.ready(1);
      await connected;
      fake.message(2);
      fake.message(3);
      fake.message(4);
      await until(
        () => first.published.includes(messageId(4)) && stored.get(0)?.sequence === 2,
        'sequence 4 to be received while 3 is still publishing',
      );
      expect((await first.gateway.ws.options.retrieveSessionInfo(0))?.sequence).toBe(4);

      await first.gateway.shutdown('received SIGTERM');

      expect(first.errors).toHaveLength(1);
      expect(first.errors[0]).toContain(messageId(3));
      expect(stored.get(0)?.sequence).toBe(2);

      const resumed = second.gateway.ws.connect();
      await until(() => fake.sent(6).length === 1, 'the resume');

      expect(fake.sent(6)[0]?.d).toEqual({ token: TOKEN, session_id: SESSION, seq: 2 });
      expect(fake.sent(2)).toHaveLength(1);

      fake.message(3);
      fake.message(4);
      fake.dispatch('RESUMED', 5, {});
      await resumed;
      await until(() => stored.get(0)?.sequence === 5, 'the replay to be stored');

      expect(second.published).toEqual([messageId(3), messageId(4)]);

      await second.gateway.shutdown('received SIGTERM');
      await until(() => fake.closes.length === 2, 'the second close frame');

      expect(fake.closes).toEqual([CloseCodes.Resuming, CloseCodes.Resuming]);
      expect(stored.get(0)?.sequence).toBe(5);
      expect([...first.writes, ...second.writes]).not.toContain(null);
    } finally {
      first.release();
      second.release();
      await fake.stop();
    }
  });
});
