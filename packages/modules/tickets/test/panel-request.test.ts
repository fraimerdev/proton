import { describe, expect, test } from 'bun:test';
import type { ActionRequest, ModuleContext, ProtonEvent } from '@proton/core';
import {
  type TicketsConfig,
  ticketPanelSchema,
  ticketsDefaultConfig,
  ticketTypeSchema,
} from '../src/config.ts';
import { createTicketPanelListener } from '../src/post.ts';

const GUILD = '900000000000000001';
const ACTOR = '100000000000000001';
const CHANNEL = '700000000000000001';

const listener = createTicketPanelListener();

function config(): TicketsConfig {
  return {
    ...ticketsDefaultConfig,
    types: [ticketTypeSchema.parse({ id: 'general', name: 'General' })],
    panels: [
      ticketPanelSchema.parse({
        id: 'support',
        name: 'Get help',
        channelId: CHANNEL,
        typeIds: ['general'],
      }),
    ],
  };
}

function harness(tier?: 'free' | 'plus') {
  const sent: ActionRequest[] = [];
  const warned: string[] = [];
  const failed: string[] = [];

  const ctx = {
    guildId: GUILD,
    config: config(),
    ...(tier ? { tier } : {}),
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
  } as unknown as ModuleContext<TicketsConfig>;

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
      moduleId: 'tickets',
      panelId: 'support',
      actorId: ACTOR,
      ...overrides,
    },
  } as ProtonEvent;
}

describe('the dashboard asking tickets to post a panel', () => {
  test('sends the panel the request names, into the channel the config gives it', async () => {
    const { ctx, sent } = harness();

    await listener.handler(request(), ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('send');
    expect(sent[0]?.actorId).toBe(ACTOR);
    expect((sent[0]?.payload as { channelId: string } | undefined)?.channelId).toBe(CHANNEL);
  });

  // Every module's listener hears every request on the bus. Without the moduleId guard, asking
  // rolemenu to post a menu would have tickets post one of its panels alongside it.
  test('ignores a request addressed to another module', async () => {
    const { ctx, sent, warned, failed } = harness();

    await listener.handler(request({ moduleId: 'rolemenu' }), ctx);

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

  test('says which panel it could not find rather than posting the wrong one', async () => {
    const { ctx, sent, warned } = harness();

    await listener.handler(request({ panelId: 'renamed-since-the-page-loaded' }), ctx);

    expect(sent).toHaveLength(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('renamed-since-the-page-loaded');
  });

  test('keys the send on the audit row, so a redelivered request posts once', async () => {
    const { ctx, sent } = harness();

    await listener.handler(request(), ctx);
    await listener.handler(request(), ctx);

    expect(sent[0]?.idempotencyKey).toContain('aud_1');
    expect(sent[0]?.idempotencyKey).toBe(sent[1]?.idempotencyKey ?? '');
  });

  // The tier is re-checked at post time as well as at save time: an admin who added panels while
  // on plus and then let the tier lapse must not keep posting the ones over the limit.
  test('reports the ceiling instead of posting a panel the tier no longer allows', async () => {
    const { ctx, sent, failed } = harness('free');
    ctx.config.panels = [
      ...ctx.config.panels,
      ticketPanelSchema.parse({ id: 'billing', name: 'Billing', channelId: CHANNEL }),
      ticketPanelSchema.parse({ id: 'appeals', name: 'Appeals', channelId: CHANNEL }),
      ticketPanelSchema.parse({ id: 'other', name: 'Other', channelId: CHANNEL }),
    ];

    await listener.handler(request(), ctx);

    expect(sent).toHaveLength(0);
    expect(failed).toHaveLength(1);
  });
});
