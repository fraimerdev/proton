import { describe, expect, test } from 'bun:test';
import type { ActionRequest, ModuleContext, ProtonEvent } from '@proton/core';
import { type RolemenuConfig, rolemenuDefaultConfig } from '../src/config.ts';
import { createPanelListener } from '../src/listeners.ts';

const GUILD = '900000000000000001';
const ACTOR = '100000000000000001';
const CHANNEL = '700000000000000001';

const listener = createPanelListener({} as never);

function config(): RolemenuConfig {
  return {
    ...rolemenuDefaultConfig,
    menus: [
      {
        id: 'colours',
        channelId: CHANNEL,
        kind: 'button',
        mode: 'toggle',
        bindings: [{ key: 'red', roleId: '800000000000000001', label: 'Red' }],
      },
    ],
  };
}

function harness() {
  const sent: ActionRequest[] = [];
  const warned: string[] = [];
  const failed: string[] = [];

  const ctx = {
    guildId: GUILD,
    config: config(),
    executor: {
      execute: async (request: ActionRequest) => {
        sent.push(request);
        return { status: 'succeeded' as const };
      },
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => warned.push(message),
      error: (message: string) => failed.push(message),
    },
  } as unknown as ModuleContext<RolemenuConfig>;

  return { ctx, sent, warned, failed };
}

function request(overrides: Record<string, unknown> = {}): ProtonEvent {
  return {
    id: 'proton.panel_requested:1',
    type: 'proton.panel_requested',
    guildId: GUILD,
    occurredAt: 0,
    payload: {
      auditId: 'aud_1',
      guildId: GUILD,
      moduleId: 'rolemenu',
      panelId: 'colours',
      actorId: ACTOR,
      ...overrides,
    },
  } as ProtonEvent;
}

describe('the dashboard asking rolemenu to post a menu', () => {
  test('posts the menu the request names, into the channel the config gives it', async () => {
    const { ctx, sent } = harness();

    await listener.handler(request(), ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('send');
    expect(sent[0]?.actorId).toBe(ACTOR);
    expect((sent[0]?.payload as { channelId: string } | undefined)?.channelId).toBe(CHANNEL);
  });

  // Every module's listener hears every request on the bus. Without the moduleId guard, asking
  // tickets to post its panel would have rolemenu post one of its own alongside it.
  test('ignores a request addressed to another module', async () => {
    const { ctx, sent, warned, failed } = harness();

    await listener.handler(request({ moduleId: 'tickets' }), ctx);

    expect(sent).toHaveLength(0);
    expect(warned).toEqual([]);
    expect(failed).toEqual([]);
  });

  test('ignores a payload that is not a panel request at all', async () => {
    const { ctx, sent, warned } = harness();

    await listener.handler({ ...request(), payload: { nonsense: true } } as ProtonEvent, ctx);

    expect(sent).toHaveLength(0);
    expect(warned).toEqual([]);
  });

  test('says which menu it could not find rather than posting the wrong one', async () => {
    const { ctx, sent, warned } = harness();

    await listener.handler(request({ panelId: 'renamed-since-the-page-loaded' }), ctx);

    expect(sent).toHaveLength(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('renamed-since-the-page-loaded');
  });

  // The audit id, not the event id: the same button pressed twice is two audit rows and two posts,
  // but one request redelivered by a RESUME must not put the menu in the channel a second time.
  test('keys the send on the audit row, so a redelivered request posts once', async () => {
    const { ctx, sent } = harness();

    await listener.handler(request(), ctx);
    await listener.handler(request(), ctx);

    expect(sent[0]?.idempotencyKey).toContain('aud_1');
    expect(sent[0]?.idempotencyKey).toBe(sent[1]?.idempotencyKey ?? '');
  });

  test('edits in place when the menu already knows its message', async () => {
    const { ctx, sent } = harness();
    ctx.config.menus = ctx.config.menus.map((menu) => ({
      ...menu,
      messageId: '600000000000000001',
    }));

    await listener.handler(request(), ctx);

    expect(sent[0]?.kind).toBe('edit_message');
  });
});
