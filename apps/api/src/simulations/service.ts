import type {
  EventBus,
  Logger,
  ModuleRegistry,
  RateWindowStore,
  SimulationDescriptor,
  SimulationOutcome,
  SimulationResults,
  SimulationRun,
} from '@proton/core';
import {
  entitlementRank,
  newId,
  SIMULATION_WAIT_MS,
  simulationInputsSchema,
  simulationRequestedPayloadSchema,
} from '@proton/core';
import type { DbHandle } from '@proton/db';
import { auditTrail } from '@proton/db/schema';
import { checkedConfig, type ModuleConfigService } from '../modules/service.ts';

export class SimulationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SimulationError';
  }
}

export interface RunSimulationInput extends SimulationRun {
  guildId: string;
  moduleId: string;
  actorId: string;
  source: 'dashboard' | 'command' | 'system';
  ipHash?: string | undefined;
}

export const SIMULATION_SEND_LIMIT = 8;

export const SIMULATION_SEND_WINDOW_MS = 60_000;

export const SIMULATION_PREVIEW_LIMIT = 60;

export const SIMULATION_PREVIEW_WINDOW_MS = 60_000;

export interface SimulationServiceOptions {
  modules: ModuleConfigService;
  registry: ModuleRegistry;
  db: DbHandle;
  results?: SimulationResults | undefined;
  bus?: EventBus | undefined;
  rateWindow?: RateWindowStore | undefined;
  logger?: Logger | undefined;
  waitMs?: number | undefined;
  now?(): number;
}

const NO_BUS =
  'Proton cannot reach its event bus, and the worker is the only process that renders a ' +
  'simulation against this server, so nothing was tested. Set REDIS_URL for the api and restart it.';

const TIMED_OUT =
  'the worker did not answer in time, so Proton cannot say whether anything was sent. Check the ' +
  'channel before trying again — if a message did arrive, sending again would post a second one.';

export class SimulationService {
  readonly #options: SimulationServiceOptions;

  constructor(options: SimulationServiceOptions) {
    this.#options = options;
  }

  catalogue(moduleId: string): SimulationDescriptor[] {
    return this.#options.registry.simulations(moduleId).map(({ descriptor }) => descriptor);
  }

  async run(input: RunSimulationInput): Promise<SimulationOutcome> {
    const { registry, modules, results, bus } = this.#options;

    const manifest = registry.get(input.moduleId);
    if (!manifest) {
      throw new SimulationError(
        'unknown_module',
        `Proton has no module called '${input.moduleId}'.`,
      );
    }

    const adapter = registry.simulation(input.moduleId, input.simulationId);
    if (!adapter) {
      throw new SimulationError(
        'unknown_simulation',
        `${manifest.name} has nothing called '${input.simulationId}' to test. It may have been ` +
          'renamed since this page was opened — reload and try again.',
      );
    }

    const { descriptor } = adapter;

    if (results === undefined || bus === undefined) {
      throw new SimulationError('no_bus', NO_BUS);
    }

    // Before every other check: a second press of the same button is the same request, and the
    // answer it already has is the only honest thing to hand it.
    const already = await results.recall(input.requestId);
    if (already !== null) return already;

    const current = await modules.get(input.guildId, input.moduleId);

    if (input.mode === 'send' && !current.enabled) {
      throw new SimulationError(
        'module_disabled',
        `${manifest.name} is switched off in this server, so Proton will not post one of its ` +
          'messages into a channel. Switch it on first, or use Preview instead.',
      );
    }

    const required = manifest.requiredEntitlement ?? 'free';
    if (entitlementRank(current.tier) < entitlementRank(required)) {
      throw new SimulationError(
        'insufficient_entitlement',
        `${manifest.name} needs the ${required} plan, and this server is on ${current.tier}, so ` +
          'there is nothing here to test yet.',
      );
    }

    const config =
      input.draft === undefined
        ? current.config
        : checkedConfig(manifest, input.draft, current, 'were not tested');

    const inputs = simulationInputsSchema(descriptor.inputs).safeParse(input.inputs);
    if (!inputs.success) {
      throw new SimulationError(
        'invalid_inputs',
        `That example event does not add up: ${inputs.error.issues
          .map((issue) => `${issue.path.map(String).join('.') || 'input'} ${issue.message}`)
          .join('; ')}`,
      );
    }

    const channelId = this.#destinationFor(descriptor, adapter, config, inputs.data, input);

    await this.#rateLimit(input);

    const requested = simulationRequestedPayloadSchema.parse({
      requestId: input.requestId,
      guildId: input.guildId,
      moduleId: input.moduleId,
      simulationId: descriptor.id,
      mode: input.mode,
      actorId: input.actorId,
      subjectId: input.subjectId ?? input.actorId,
      channelId,
      inputs: inputs.data,
      config,
      tier: current.tier,
      usedDraft: input.draft !== undefined,
    });

    // Sends are recorded; previews are not. A preview changes nothing in Discord and writing an
    // audit row for every keystroke-driven re-render would bury the rows that matter.
    if (input.mode === 'send') await this.#record(input, descriptor, channelId);

    await bus.publish({
      id: `proton.simulation_requested:${input.guildId}:${input.requestId}`,
      type: 'proton.simulation_requested',
      guildId: input.guildId,
      occurredAt: this.#now(),
      payload: requested,
    });

    const outcome = await results.wait(input.requestId, this.#options.waitMs ?? SIMULATION_WAIT_MS);

    if (outcome === null) throw new SimulationError('worker_timeout', TIMED_OUT);

    return outcome;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #destinationFor(
    descriptor: SimulationDescriptor,
    adapter: { destination?(config: never, inputs: never): string | null },
    config: Record<string, unknown>,
    inputs: Record<string, string | number | boolean>,
    input: RunSimulationInput,
  ): string | null {
    if (descriptor.delivery === 'none') {
      if (input.mode === 'send') {
        throw new SimulationError(
          'not_sendable',
          `${descriptor.label} is not a message Proton posts — it is a name Proton gives a ` +
            'channel, so there is nothing to send. Preview it instead.',
        );
      }
      return null;
    }

    // A direct message always goes to whoever pressed the button, never to the example member.
    if (descriptor.delivery === 'dm') return null;

    const configured = adapter.destination?.(config as never, inputs as never) ?? null;
    const chosen = input.channelId ?? configured;

    if (chosen === null && input.mode === 'send') {
      throw new SimulationError(
        'no_channel',
        `${descriptor.label} has no channel to go in. Pick one for this test, or set one in the ` +
          'settings beside it.',
      );
    }

    return chosen;
  }

  async #rateLimit(input: RunSimulationInput): Promise<void> {
    const window = this.#options.rateWindow;
    if (window === undefined) return;

    const send = input.mode === 'send';
    const limit = send ? SIMULATION_SEND_LIMIT : SIMULATION_PREVIEW_LIMIT;
    const windowMs = send ? SIMULATION_SEND_WINDOW_MS : SIMULATION_PREVIEW_WINDOW_MS;

    const { count } = await window.hit({
      guildId: input.guildId,
      ruleId: `simulation:${input.mode}`,
      actorId: input.actorId,
      windowMs,
      limit,
      // The request id, so a retry of the same press is not counted twice.
      member: input.requestId,
      now: this.#now(),
    });

    if (count <= limit) return;

    throw new SimulationError(
      'rate_limited',
      send
        ? `That is ${limit} test messages in a minute, which is as many as Proton will post. Wait ` +
            'a moment and try again.'
        : 'Proton is being asked to render too many previews at once. Wait a moment and try again.',
    );
  }

  async #record(
    input: RunSimulationInput,
    descriptor: SimulationDescriptor,
    channelId: string | null,
  ): Promise<void> {
    await this.#options.db.db.insert(auditTrail).values({
      id: newId(),
      guildId: input.guildId,
      actorId: input.actorId,
      source: input.source,
      action: `module.${input.moduleId}.simulation.send`,
      before: null,
      after: {
        simulationId: descriptor.id,
        label: descriptor.label,
        delivery: descriptor.delivery,
        channelId,
        subjectId: input.subjectId ?? input.actorId,
        usedDraft: input.draft !== undefined,
      },
      ipHash: input.ipHash ?? null,
    });
  }
}
