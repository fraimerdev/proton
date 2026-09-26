import { describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  type ActionRequest,
  type ActionResult,
  type CommandContext,
  defer,
  deferEphemeral,
  deferUpdate,
  type EventBus,
  followUp,
  type ModuleManifest,
  ModuleRegistry,
  openModal,
  type ProtonEvent,
  type RespondTo,
  replyEphemeral,
  respondAutocomplete,
} from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { z } from 'zod';
import { acknowledges, defersPublicly, watchAcknowledgement } from '../src/interaction-ack.ts';
import { ModuleRuntime } from '../src/runtime.ts';
import { collectingLogger } from './command-fakes.ts';

const APPLICATION = '1200000000000000001';
const INTERACTION = '1300000000000000001';
const TOKEN = 'aW50ZXJhY3Rpb24tdG9rZW4tZml4dHVyZQ';
const APOLOGY = 'Something went wrong with `/ping`, so it may not have finished.';

class DedupingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  readonly claimed = new Set<string>();
  refuse: ((request: ActionRequest) => ActionResult | undefined) | null = null;

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    const refused = this.refuse?.(request);
    if (refused) return refused;
    if (this.claimed.has(request.idempotencyKey)) return { status: 'skipped_duplicate' };
    this.claimed.add(request.idempotencyKey);
    return { status: 'executed' };
  }

  scoped(): ActionExecutor {
    return this;
  }

  initialCallbacks(): ActionRequest[] {
    return this.requests.filter((request) => request.kind === 'interaction_reply');
  }

  followups(): ActionRequest[] {
    return this.requests.filter((request) => request.kind === 'interaction_followup');
  }
}

const bus: EventBus = {
  publish: async () => undefined,
  subscribe: () => ({ group: 'x', close: async () => undefined }),
};

type Step = (ctx: CommandContext) => Promise<void>;

function crashing(step: Step): ModuleManifest {
  return {
    id: 'ping',
    name: 'Ping',
    category: 'utility',
    configSchema: z.object({ enabled: z.boolean().default(true) }),
    defaultConfig: { enabled: true },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [],
    actionKinds: ['interaction_reply', 'interaction_followup'],
    dashboard: { icon: 'activity', sections: [] },
    commands: [
      {
        name: 'ping',
        description: 'Check that Proton answers.',
        data: { name: 'ping', description: 'Check that Proton answers.' },
        handler: async (ctx: CommandContext) => {
          await step(ctx);
          throw new Error('the store was unreachable');
        },
      },
    ],
  } as unknown as ModuleManifest;
}

function pingEvent(edit: (d: Record<string, unknown>) => void = () => undefined): ProtonEvent {
  const raw = dispatch('interactionCreatePing');
  edit(raw.d);
  const event = normalise(raw)[0];
  if (!event) throw new Error('interactionCreatePing did not normalise');
  return event;
}

function build(step: Step, executor = new DedupingExecutor()) {
  const registry = new ModuleRegistry();
  registry.register(crashing(step));
  const { logger, lines } = collectingLogger();

  const runtime = new ModuleRuntime({
    bus,
    registry,
    executor,
    logger,
    config: { get: async () => ({ enabled: true, config: { enabled: true } }) },
  });

  return { runtime, executor, lines };
}

function to(ctx: CommandContext): RespondTo {
  return {
    guildId: ctx.guildId,
    moduleId: 'ping',
    actorId: ctx.userId,
    interaction: ctx.interaction,
    idempotencyKey: ctx.idempotencyKey,
  };
}

function descriptionOf(request: ActionRequest | undefined): string {
  const payload = request?.payload as { embeds?: Array<{ description?: string }> } | undefined;
  return payload?.embeds?.[0]?.description ?? '';
}

async function crash(runtime: ModuleRuntime, event: ProtonEvent): Promise<void> {
  await expect(runtime.handle(event)).rejects.toThrow('the store was unreachable');
}

describe('a handler that throws before it answers', () => {
  test('is answered with the callback-4 reply it always got', async () => {
    const { runtime, executor } = build(async () => undefined);
    const event = pingEvent();

    await crash(runtime, event);

    expect(executor.followups()).toHaveLength(0);
    expect(executor.initialCallbacks()).toHaveLength(1);
    const reply = executor.initialCallbacks()[0];
    expect(reply?.idempotencyKey).toBe(`${event.id}:handler-threw`);
    expect(reply?.payload).toMatchObject({
      interactionId: INTERACTION,
      interactionToken: TOKEN,
      ephemeral: true,
    });
    expect((reply?.payload as { callbackType?: number } | undefined)?.callbackType ?? 4).toBe(4);
    expect(descriptionOf(reply)).toContain(APOLOGY);
  });

  test('an autocomplete result is not an answer, so the reply still goes out', async () => {
    const { runtime, executor } = build(async (ctx) => {
      await ctx.executor.execute(respondAutocomplete(to(ctx), []));
    });

    await crash(runtime, pingEvent());

    expect(executor.followups()).toHaveLength(0);
    expect(executor.requests.at(-1)?.idempotencyKey).toEndWith(':handler-threw');
    expect(executor.requests.at(-1)?.kind).toBe('interaction_reply');
  });

  test('an answer Discord refused is not an answer', async () => {
    const executor = new DedupingExecutor();
    executor.refuse = (request) =>
      request.idempotencyKey.endsWith(':defer')
        ? { status: 'failed_api', failure: { code: 'discord_500', humanReason: 'no' } }
        : undefined;
    const { runtime } = build(async (ctx) => {
      await ctx.executor.execute(deferEphemeral(to(ctx)));
    }, executor);

    await crash(runtime, pingEvent());

    expect(executor.followups()).toHaveLength(0);
    expect(
      executor.initialCallbacks().map((request) => request.idempotencyKey.split(':').at(-1)),
    ).toEqual(['defer', 'handler-threw']);
  });
});

describe('a handler that throws after it answered', () => {
  test('a defer is followed up once, with no second callback', async () => {
    const { runtime, executor } = build(async (ctx) => {
      await ctx.executor.execute(deferEphemeral(to(ctx)));
    });
    const event = pingEvent();

    await crash(runtime, event);

    expect(executor.initialCallbacks()).toHaveLength(1);
    expect(executor.initialCallbacks()[0]?.idempotencyKey).toBe(`${event.id}:defer`);

    const followups = executor.followups();
    expect(followups).toHaveLength(1);
    expect(followups[0]?.idempotencyKey).toBe(`${event.id}:handler-threw`);
    expect(followups[0]?.payload).toMatchObject({
      applicationId: APPLICATION,
      interactionToken: TOKEN,
      ephemeral: true,
    });
    expect(descriptionOf(followups[0])).toContain(APOLOGY);
  });

  test('a reply is followed up the same way', async () => {
    const { runtime, executor } = build(async (ctx) => {
      await ctx.executor.execute(replyEphemeral(to(ctx), 'Pong.'));
    });

    await crash(runtime, pingEvent());

    expect(executor.initialCallbacks()).toHaveLength(1);
    expect(executor.followups()).toHaveLength(1);
    expect(descriptionOf(executor.followups()[0])).toContain(APOLOGY);
  });

  test('a deferred update and a modal are answers too', async () => {
    for (const answer of [
      (ctx: CommandContext) => deferUpdate(to(ctx)),
      (ctx: CommandContext) =>
        openModal(to(ctx), {
          customId: 'proton:ping:modal',
          title: 'Ping',
          components: [],
        }),
    ]) {
      const { runtime, executor } = build(async (ctx) => {
        await ctx.executor.execute(answer(ctx));
      });

      await crash(runtime, pingEvent());

      expect(executor.initialCallbacks()).toHaveLength(1);
      expect(executor.followups()).toHaveLength(1);
    }
  });

  test('an answer made through a scoped executor is still noticed', async () => {
    const { runtime, executor } = build(async (ctx) => {
      const scoped = (
        ctx.executor as ActionExecutor & { scoped(h: unknown): ActionExecutor }
      ).scoped({ channelId: ctx.channelId });
      await scoped.execute(deferEphemeral(to(ctx)));
    });

    await crash(runtime, pingEvent());

    expect(executor.initialCallbacks()).toHaveLength(1);
    expect(executor.followups()).toHaveLength(1);
  });

  test('on redelivery the deduplicated defer still counts, and nothing reaches Discord twice', async () => {
    const executor = new DedupingExecutor();
    const { runtime } = build(async (ctx) => {
      await ctx.executor.execute(deferEphemeral(to(ctx)));
    }, executor);
    const event = pingEvent();

    await crash(runtime, event);
    const first = executor.requests.length;
    await crash(runtime, event);

    const again = executor.requests.slice(first);
    expect(again.map((request) => request.kind)).toEqual([
      'interaction_reply',
      'interaction_followup',
    ]);
    expect(again.every((request) => executor.claimed.has(request.idempotencyKey))).toBe(true);
    expect(
      executor.initialCallbacks().filter((r) => r.idempotencyKey.endsWith(':handler-threw')),
    ).toEqual([]);
  });

  test('a redelivery whose defer Discord says was already acknowledged follows up', async () => {
    const executor = new DedupingExecutor();
    executor.refuse = (request) =>
      request.idempotencyKey.endsWith(':defer')
        ? {
            status: 'failed_api',
            failure: {
              code: 'discord_400',
              humanReason: 'already answered',
              discordCode: RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged,
            },
          }
        : undefined;
    const { runtime } = build(async (ctx) => {
      await ctx.executor.execute(deferEphemeral(to(ctx)));
    }, executor);

    await crash(runtime, pingEvent());

    expect(executor.followups()).toHaveLength(1);
    expect(executor.initialCallbacks()).toHaveLength(1);
  });

  test('the handler’s own apology on the same key dedupes the worker’s', async () => {
    const { runtime, executor } = build(async (ctx) => {
      await ctx.executor.execute(deferEphemeral(to(ctx)));
      await ctx.executor.execute({
        ...followUp({ ...to(ctx), applicationId: ctx.applicationId ?? '' }, 'Sorry.'),
        idempotencyKey: `${ctx.idempotencyKey}:handler-threw`,
      });
    });

    await crash(runtime, pingEvent());

    const followups = executor.followups();
    expect(followups).toHaveLength(2);
    expect(followups[1]?.idempotencyKey).toBe(followups[0]?.idempotencyKey);
    expect(executor.claimed.size).toBe(2);
  });

  test('after a public defer a neutral public line closes it, then the apology goes privately', async () => {
    const { runtime, executor } = build(async (ctx) => {
      await ctx.executor.execute(defer(to(ctx), { ephemeral: false }));
    });
    const event = pingEvent();

    await crash(runtime, event);

    expect(executor.initialCallbacks()).toHaveLength(1);
    const followups = executor.followups();
    expect(followups.map((request) => request.idempotencyKey)).toEqual([
      `${event.id}:handler-threw-public`,
      `${event.id}:handler-threw`,
    ]);
    expect(followups[0]?.payload).toMatchObject({ applicationId: APPLICATION, ephemeral: false });
    expect(descriptionOf(followups[0])).toContain("`/ping` didn't go through.");
    expect(descriptionOf(followups[0])).not.toContain('Something went wrong');
    expect(followups[1]?.payload).toMatchObject({ applicationId: APPLICATION, ephemeral: true });
    expect(descriptionOf(followups[1])).toContain(APOLOGY);
  });

  test('a redelivery whose public defer an earlier delivery made keeps the apology private', async () => {
    let run = 0;
    const executor = new DedupingExecutor();
    const { runtime } = build(async (ctx) => {
      run += 1;
      await ctx.executor.execute(defer(to(ctx), { ephemeral: false }));
      if (run === 1) {
        await ctx.executor.execute(
          followUp(
            { ...to(ctx), applicationId: ctx.applicationId ?? '' },
            { content: 'rank card', ephemeral: false },
          ),
        );
      }
    }, executor);
    const event = pingEvent();

    await crash(runtime, event);
    const first = executor.requests.length;
    await crash(runtime, event);

    const again = executor.requests.slice(first);
    expect(again.map((request) => request.idempotencyKey)).toEqual([
      `${event.id}:defer`,
      `${event.id}:handler-threw`,
    ]);
    expect(again[1]?.payload).toMatchObject({ ephemeral: true });
    expect(
      executor.followups().some((r) => r.idempotencyKey.endsWith(':handler-threw-public')),
    ).toBe(false);
  });

  test('once a followup has answered the public defer, the apology is private', async () => {
    const { runtime, executor } = build(async (ctx) => {
      await ctx.executor.execute(defer(to(ctx), { ephemeral: false }));
      await ctx.executor.execute(
        followUp(
          { ...to(ctx), applicationId: ctx.applicationId ?? '' },
          { content: 'Pong.', ephemeral: false },
        ),
      );
    });

    await crash(runtime, pingEvent());

    const followups = executor.followups();
    expect(followups).toHaveLength(2);
    expect(followups[1]?.payload).toMatchObject({ ephemeral: true });
  });

  test('a public reply leaves the apology private', async () => {
    const { runtime, executor } = build(async (ctx) => {
      await ctx.executor.execute({
        ...replyEphemeral(to(ctx), 'Pong.'),
        payload: {
          interactionId: ctx.interaction.id,
          interactionToken: ctx.interaction.token,
          content: 'Pong.',
        },
      });
    });

    await crash(runtime, pingEvent());

    expect(executor.followups()[0]?.payload).toMatchObject({ ephemeral: true });
  });

  test('without an application id nothing is sent and the silence is logged', async () => {
    const { runtime, executor, lines } = build(async (ctx) => {
      await ctx.executor.execute(deferEphemeral(to(ctx)));
    });

    await crash(
      runtime,
      pingEvent((d) => {
        delete d.application_id;
      }),
    );

    expect(executor.requests).toHaveLength(1);
    expect(executor.followups()).toHaveLength(0);
    expect(
      lines.filter((line) => line.startsWith('error: /ping had already answered')),
    ).toHaveLength(1);
  });
});

describe('acknowledges', () => {
  const request = (payload: Record<string, unknown>): ActionRequest => ({
    guildId: '900000000000000001',
    moduleId: 'ping',
    kind: 'interaction_reply',
    actorId: '100000000000000001',
    idempotencyKey: 'k',
    dryRun: false,
    payload: { interactionId: INTERACTION, interactionToken: TOKEN, ...payload },
  });
  const executed: ActionResult = { status: 'executed' };

  test('every initial callback counts once it went through or was already made', () => {
    for (const callbackType of [undefined, 4, 5, 6, 7, 9]) {
      expect(acknowledges(request({ callbackType }), executed, INTERACTION)).toBe(true);
      expect(
        acknowledges(request({ callbackType }), { status: 'skipped_duplicate' }, INTERACTION),
      ).toBe(true);
    }
  });

  test('an autocomplete result, a failure, a dry run or another interaction does not', () => {
    expect(acknowledges(request({ callbackType: 8 }), executed, INTERACTION)).toBe(false);
    expect(
      acknowledges(
        request({}),
        { status: 'failed_precheck', failure: { code: 'x', humanReason: 'x' } },
        INTERACTION,
      ),
    ).toBe(false);
    expect(acknowledges(request({}), { status: 'dry_run' }, INTERACTION)).toBe(false);
    expect(acknowledges(request({}), executed, '1300000000000000099')).toBe(false);
    expect(
      acknowledges({ ...request({}), kind: 'interaction_followup' }, executed, INTERACTION),
    ).toBe(false);
  });

  test('the watch forwards precheck and remembers nothing it did not see', async () => {
    const prechecked: ActionRequest[] = [];
    const watch = watchAcknowledgement(
      {
        execute: async () => executed,
        precheck: async (r) => {
          prechecked.push(r);
          return null;
        },
      },
      { id: INTERACTION, token: TOKEN },
    );

    expect(watch.acknowledged()).toBe(false);
    await watch.executor.precheck?.(request({}));
    expect(prechecked).toHaveLength(1);
    expect(watch.acknowledged()).toBe(false);
    await watch.executor.execute(request({ callbackType: 5 }));
    expect(watch.acknowledged()).toBe(true);
  });

  test('a public defer stays open until a followup for this interaction goes through', async () => {
    let result: ActionResult = executed;
    const watch = watchAcknowledgement(
      { execute: async () => result },
      { id: INTERACTION, token: TOKEN },
    );
    const followup = (token: string): ActionRequest => ({
      ...request({}),
      kind: 'interaction_followup',
      payload: { applicationId: APPLICATION, interactionToken: token, content: 'x' },
    });

    await watch.executor.execute(request({ callbackType: 5, ephemeral: false }));
    expect(watch.publicDeferOpen()).toBe(true);

    await watch.executor.execute(followup('another-token'));
    result = { status: 'failed_api', failure: { code: 'discord_500', humanReason: 'no' } };
    await watch.executor.execute(followup(TOKEN));
    expect(watch.publicDeferOpen()).toBe(true);

    result = executed;
    await watch.executor.execute(followup(TOKEN));
    expect(watch.publicDeferOpen()).toBe(false);
  });

  test('a later callback Discord refuses as already answered does not close a public defer', async () => {
    const refused: ActionResult = {
      status: 'failed_api',
      failure: {
        code: 'discord_400',
        humanReason: 'already answered',
        discordCode: RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged,
      },
    };
    let result: ActionResult = executed;
    const watch = watchAcknowledgement(
      { execute: async () => result },
      { id: INTERACTION, token: TOKEN },
    );

    await watch.executor.execute(request({ callbackType: 5 }));
    result = refused;
    await watch.executor.execute(request({ callbackType: 4, ephemeral: true }));

    expect(watch.publicDeferOpen()).toBe(true);
  });

  test('a public defer this delivery did not make is never open', async () => {
    for (const result of [
      { status: 'skipped_duplicate' },
      {
        status: 'failed_api',
        failure: {
          code: 'discord_400',
          humanReason: 'already answered',
          discordCode: RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged,
        },
      },
    ] satisfies ActionResult[]) {
      const watch = watchAcknowledgement(
        { execute: async () => result },
        { id: INTERACTION, token: TOKEN },
      );

      await watch.executor.execute(request({ callbackType: 5, ephemeral: false }));

      expect(watch.acknowledged()).toBe(true);
      expect(watch.publicDeferOpen()).toBe(false);
    }
  });

  test('a private defer, a flagged defer or a reply is never an open public defer', () => {
    expect(defersPublicly(request({ callbackType: 5, ephemeral: true }))).toBe(false);
    expect(defersPublicly(request({ callbackType: 5, flags: 64 }))).toBe(false);
    expect(defersPublicly(request({ callbackType: 4 }))).toBe(false);
    expect(defersPublicly(request({ callbackType: 5 }))).toBe(true);
  });
});
