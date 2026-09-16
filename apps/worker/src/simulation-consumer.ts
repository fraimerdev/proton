import type {
  ActionExecutor,
  ActionResult,
  Attachment,
  EventBus,
  GuildState,
  GuildStateStore,
  Logger,
  ModuleRegistry,
  ProtonEvent,
  ProtonMessage,
  RestProxyClient,
  SimulationAttachment,
  SimulationBuild,
  SimulationCard,
  SimulationDescriptor,
  SimulationDestination,
  SimulationOutcome,
  SimulationPerson,
  SimulationRender,
  SimulationRequestedPayload,
  SimulationResults,
  SimulationScene,
  SimulationSent,
  Subscription,
} from '@proton/core';
import {
  asTestDelivery,
  messageLink,
  personFor,
  SIMULATION_ACTOR,
  simulationCardQuery,
  simulationRequestedPayloadSchema,
  testCustomIdFor,
  toDiscordMessage,
} from '@proton/core';
import type {
  ChannelFacts,
  MemberFacts,
  PlaceholderEnvironment,
  UserFacts,
} from '@proton/core/placeholders';
import { serverFactsFrom } from '@proton/core/placeholders';
import { moduleExecutor } from './module-actions.ts';

export const SIMULATION_GROUP = 'simulation';

export interface SimulationConsumerDeps {
  bus: EventBus;
  results: SimulationResults;
  registry: ModuleRegistry;
  executor: ActionExecutor;
  guildState: Pick<GuildStateStore, 'get'>;
  rest: RestProxyClient;
  placeholders: PlaceholderEnvironment;
  apiUrl: string;
  apiSecret: string;
  logger: Logger;
  now?(): number;
}

const NOWHERE: SimulationDestination = { kind: 'none', channelId: null, label: 'nowhere' };

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function nullableText(value: unknown, key: string): string | null | undefined {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined;

  const held: unknown = Reflect.get(value, key);
  if (typeof held === 'string') return held;
  return held === null ? null : undefined;
}

function userFactsOf(raw: unknown, fallbackId: string): UserFacts {
  return {
    id: str(nested(raw, 'id')) ?? fallbackId,
    username: str(nested(raw, 'username')),
    globalName: str(nested(raw, 'global_name')),
    avatarHash: str(nested(raw, 'avatar')),
    bot: nested(raw, 'bot') === true,
  };
}

function memberFactsOf(raw: unknown): MemberFacts {
  const roles = nested(raw, 'roles');

  return {
    nick: nullableText(raw, 'nick'),
    joinedAt: nullableText(raw, 'joined_at'),
    premiumSince: nullableText(raw, 'premium_since'),
    ...(nested(raw, 'pending') === true ? { pending: true } : {}),
    timeoutUntil: nullableText(raw, 'communication_disabled_until'),
    roleIds: Array.isArray(roles)
      ? roles.filter((role): role is string => typeof role === 'string')
      : undefined,
  };
}

function channelFactsOf(state: GuildState | null, channelId: string | null): ChannelFacts | null {
  if (channelId === null) return null;

  const known = state?.channels.get(channelId);
  if (known === undefined) return { id: channelId };

  return { id: channelId, name: known.name, type: known.type, parentId: known.parentId };
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureOf(result: ActionResult): string {
  return result.failure?.humanReason ?? 'Discord refused it and gave no reason.';
}

function messageIdOf(result: ActionResult): string | null {
  return str(nested(result.body, 'id'));
}

/** Names for the ids a test message can mention, so a preview writes @Somebody, not `<@123>`. */
function mentionNamesFor(scene: SimulationScene): Record<string, string> {
  const names: Record<string, string> = {
    [scene.subject.user.id]: scene.subject.displayName,
    [scene.actor.user.id]: scene.actor.displayName,
  };

  const bot = scene.bot;
  if (bot !== null && typeof bot.name === 'string') names[bot.id] = bot.name;

  return names;
}

export class SimulationConsumer {
  readonly #deps: SimulationConsumerDeps;

  constructor(deps: SimulationConsumerDeps) {
    this.#deps = deps;
  }

  start(): Subscription {
    return this.#deps.bus.subscribe(SIMULATION_GROUP, ['proton.simulation_requested'], (event) =>
      this.handle(event),
    );
  }

  async handle(event: ProtonEvent): Promise<void> {
    const parsed = simulationRequestedPayloadSchema.safeParse(event.payload);

    if (!parsed.success) {
      this.#deps.logger.error(
        'a simulation request arrived in a shape the worker cannot read, so nobody was answered ' +
          'and the dashboard will sit waiting for it until it times out',
        { eventId: event.id },
      );
      return;
    }

    const payload = parsed.data;
    let outcome: SimulationOutcome;

    try {
      outcome = await this.#run(payload, event.id);
    } catch (error) {
      this.#deps.logger.error(`a simulation could not be run: ${detailOf(error)}`, {
        guildId: payload.guildId,
        moduleId: payload.moduleId,
        simulationId: payload.simulationId,
      });

      outcome = this.#failed(
        payload,
        NOWHERE,
        'simulation_failed',
        `Proton could not run that test: ${detailOf(error)}`,
      );
    }

    // Answered even when it failed: the api is blocked on this mailbox, and silence reaches the
    // admin as a timeout that says nothing about what went wrong.
    await this.#deps.results.answer(payload.requestId, outcome);
  }

  #failed(
    payload: SimulationRequestedPayload,
    destination: SimulationDestination,
    code: string,
    message: string,
  ): SimulationOutcome {
    return {
      ok: false,
      mode: payload.mode,
      simulationId: payload.simulationId,
      usedDraft: payload.usedDraft,
      destination,
      render: null,
      sent: null,
      error: { code, message },
    };
  }

  async #run(payload: SimulationRequestedPayload, eventId: string): Promise<SimulationOutcome> {
    const adapter = this.#deps.registry.simulation(payload.moduleId, payload.simulationId);

    if (adapter === undefined) {
      return this.#failed(
        payload,
        NOWHERE,
        'unknown_simulation',
        `Proton has nothing called '${payload.simulationId}' to test in ${payload.moduleId}.`,
      );
    }

    const { descriptor } = adapter;
    const state = await this.#deps.guildState.get(payload.guildId);
    const scene = await this.#sceneFor(payload, state, eventId);
    const destination = this.#destinationFor(descriptor, payload.channelId, scene);

    const built = adapter.build(payload.config as never, scene);

    if (!built.ok) {
      return this.#failed(
        payload,
        destination,
        'render_failed',
        `${descriptor.label} cannot be posted as it stands: ${built.humanReason}`,
      );
    }

    const render = renderOf(built, scene);
    const base = {
      mode: payload.mode,
      simulationId: descriptor.id,
      usedDraft: payload.usedDraft,
      destination,
    };

    if (payload.mode === 'preview') {
      return { ...base, ok: true, render, sent: null, error: null };
    }

    if (built.output.kind !== 'message') {
      return this.#failed(
        payload,
        destination,
        'not_sendable',
        `${descriptor.label} is a name Proton gives a channel, not a message it posts.`,
      );
    }

    const delivered = await this.#deliver(
      payload,
      descriptor,
      built.output.message,
      built.output.attachments,
      destination,
    );

    return delivered.sent === null
      ? { ...base, ok: false, render, sent: null, error: delivered.error }
      : { ...base, ok: true, render, sent: delivered.sent, error: null };
  }

  async #sceneFor(
    payload: SimulationRequestedPayload,
    state: GuildState | null,
    eventId: string,
  ): Promise<SimulationScene> {
    const [subject, actor, bot] = await Promise.all([
      this.#personFor(payload.guildId, payload.subjectId),
      payload.subjectId === payload.actorId
        ? Promise.resolve(null)
        : this.#personFor(payload.guildId, payload.actorId),
      this.#botFacts(payload.guildId),
    ]);

    const channel = channelFactsOf(state, payload.channelId);

    return {
      guildId: payload.guildId,
      server: serverFactsFrom(state, payload.guildId),
      guildState: state,
      subject,
      actor: actor ?? subject,
      destinationChannel: channel,
      originChannel: channel,
      bot,
      eventId,
      now: this.#deps.now?.() ?? Date.now(),
      tier: payload.tier,
      inputs: payload.inputs,
    };
  }

  async #botFacts(guildId: string) {
    try {
      return await this.#deps.placeholders.bot();
    } catch (error) {
      this.#deps.logger.warn(
        'Proton could not read its own profile for a simulation, so its name and avatar render ' +
          `as nothing: ${detailOf(error)}`,
        { guildId },
      );
      return null;
    }
  }

  async #personFor(guildId: string, userId: string): Promise<SimulationPerson> {
    const response = await this.#deps.rest.request({
      method: 'GET',
      path: `/guilds/${guildId}/members/${userId}`,
    });

    if (response.status < 400) {
      return personFor(
        userFactsOf(nested(response.body, 'user'), userId),
        memberFactsOf(response.body),
      );
    }

    // Not an outage: an example member who has left is still a readable account, and a surface
    // refusing their member-only keys is the truthful answer rather than a failure.
    const profile = await this.#deps.placeholders.user(userId).catch(() => null);

    return personFor(
      profile ?? { id: userId, username: null, globalName: null, avatarHash: null },
      'unavailable',
    );
  }

  #destinationFor(
    descriptor: SimulationDescriptor,
    channelId: string | null,
    scene: SimulationScene,
  ): SimulationDestination {
    if (descriptor.delivery === 'none') {
      return { kind: 'none', channelId: null, label: 'nowhere — this is a name, not a message' };
    }

    if (descriptor.delivery === 'dm') {
      return { kind: 'dm', channelId: null, label: 'your direct messages' };
    }

    if (channelId === null) return { kind: 'channel', channelId: null, label: 'no channel yet' };

    const name = scene.destinationChannel?.name;

    return {
      kind: 'channel',
      channelId,
      label: name === undefined ? `<#${channelId}>` : `#${name}`,
    };
  }

  async #deliver(
    payload: SimulationRequestedPayload,
    descriptor: SimulationDescriptor,
    message: ProtonMessage,
    attachments: readonly SimulationAttachment[],
    destination: SimulationDestination,
  ): Promise<{ sent: SimulationSent | null; error: SimulationOutcome['error'] }> {
    const executor = moduleExecutor(this.#deps.registry, payload.moduleId, this.#deps.executor);

    const opened =
      descriptor.delivery === 'dm'
        ? await this.#openDm(executor, payload)
        : { channelId: destination.channelId, error: null };

    if (opened.error !== null) return { sent: null, error: opened.error };

    const channelId = opened.channelId;
    if (channelId === null) {
      return {
        sent: null,
        error: {
          code: 'no_channel',
          message: `${descriptor.label} has no channel to go in. Pick one for this test.`,
        },
      };
    }

    let files: Attachment[];
    try {
      files = await this.#cardFiles(payload.guildId, attachments);
    } catch (error) {
      return {
        sent: null,
        error: {
          code: 'card_failed',
          message:
            `The card could not be rendered, so nothing was sent: ${detailOf(error)} The message ` +
            'itself is fine — the picture beside it is what failed.',
        },
      };
    }

    const { message: test, markerOmitted } = asTestDelivery(message, payload.actorId);
    const body = toDiscordMessage(test, { customIdFor: testCustomIdFor });

    const result = await executor.execute({
      guildId: payload.guildId,
      moduleId: payload.moduleId,
      kind: 'send',
      actorId: SIMULATION_ACTOR,
      idempotencyKey: `simulation:${payload.requestId}`,
      dryRun: false,
      // No case row: a rehearsal is not a moderation act, and a ledger entry for one would show up
      // in this server's history as something that happened to somebody.
      record: false,
      payload: { channelId, ...body, ...(files.length > 0 ? { files } : {}) },
    });

    if (result.status === 'failed_precheck' || result.status === 'failed_api') {
      return {
        sent: null,
        error: {
          code: result.status === 'failed_precheck' ? 'not_permitted' : 'delivery_failed',
          message: `The test message was not posted: ${failureOf(result)}`,
        },
      };
    }

    const messageId = messageIdOf(result);

    return {
      sent: {
        channelId,
        messageId: messageId ?? '',
        url:
          messageId === null || descriptor.delivery === 'dm'
            ? null
            : messageLink(payload.guildId, channelId, messageId),
        markerOmitted: markerOmitted ?? null,
      },
      error: null,
    };
  }

  async #openDm(
    executor: ActionExecutor,
    payload: SimulationRequestedPayload,
  ): Promise<{ channelId: string | null; error: SimulationOutcome['error'] }> {
    const opened = await executor.execute({
      guildId: payload.guildId,
      moduleId: payload.moduleId,
      kind: 'create_dm',
      actorId: SIMULATION_ACTOR,
      targetId: payload.actorId,
      idempotencyKey: `simulation:${payload.requestId}:dm`,
      dryRun: false,
      record: false,
      payload: { userId: payload.actorId },
    });

    const channelId = str(nested(opened.body, 'id'));

    if (channelId === null) {
      return {
        channelId: null,
        error: {
          code: 'dm_closed',
          message:
            'Proton could not open a direct message with you, so nothing was sent. Allow direct ' +
            `messages from server members in this server's privacy settings and try again. ` +
            `Discord said: ${failureOf(opened)}`,
        },
      };
    }

    return { channelId, error: null };
  }

  async #cardFiles(
    guildId: string,
    attachments: readonly SimulationAttachment[],
  ): Promise<Attachment[]> {
    return Promise.all(
      attachments.map(async ({ filename, card }) => ({
        filename,
        contentType: 'image/png',
        data: await this.#renderCard(guildId, card),
      })),
    );
  }

  /**
   * Rendered by the api, not here: it owns the satori pipeline the dashboard's preview already
   * fetches from, so the card an admin looked at and the card Discord receives come out of one
   * route with one set of numbers.
   */
  async #renderCard(guildId: string, card: SimulationCard): Promise<Uint8Array<ArrayBuffer>> {
    const base = this.#deps.apiUrl.replace(/\/$/, '');
    const url = `${base}/guilds/${guildId}/cards/preview?${simulationCardQuery(card)}`;

    const response = await fetch(url, { headers: { 'x-proton-secret': this.#deps.apiSecret } });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? `the api answered ${response.status}.`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }
}

function renderOf(
  built: Extract<SimulationBuild, { ok: true }>,
  scene: SimulationScene,
): SimulationRender {
  const { output } = built;

  return {
    kind: output.kind,
    message: output.kind === 'message' ? output.message : null,
    text: output.kind === 'text' ? output.text : null,
    attachments: output.kind === 'message' ? output.attachments : [],
    caption: built.caption,
    diagnostics: built.diagnostics,
    mentionNames: mentionNamesFor(scene),
    now: scene.now,
  };
}
