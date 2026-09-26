import {
  type ActionExecutor,
  type ActionRequest,
  type EventBus,
  type EventType,
  errorStatus,
  type InteractionBase,
  interactionRef,
  type Logger,
  type ModuleContext,
  type ModuleManifest,
  type ModuleRegistry,
  type ProtonEvent,
  parseCustomId,
  type RespondTo,
  readAutocompleteInteraction,
  readComponentInteraction,
  readModalInteraction,
  replyEphemeral,
  respondAutocomplete,
  type Subscription,
} from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import type { CommandLabelSource } from './command-labels.ts';
import type { CommandResolverPort } from './command-resolver.ts';
import { ConfigUnavailableError } from './config-provider.ts';
import { moduleExecutor } from './module-actions.ts';
import type { ModulePublisherFactory } from './module-publish.ts';
import type { ModuleSchedulerFactory } from './module-schedule.ts';
import {
  type ConfigProvider,
  DEFAULT_DASHBOARD_URL,
  type ModuleConfigSnapshot,
} from './runtime.ts';

export const LISTENER_GROUP_PREFIX = 'listener';

export const listenerGroup = (prefix: string, moduleId: string): string => `${prefix}:${moduleId}`;

export const interactionListenerGroup = (prefix: string, moduleId: string): string =>
  `${listenerGroup(prefix, moduleId)}:interactions`;

export const requestListenerGroup = (prefix: string, moduleId: string): string =>
  `${listenerGroup(prefix, moduleId)}:requests`;

export const INTERACTION_LISTENER_TYPES: readonly EventType[] = [
  'interaction.component',
  'interaction.modal',
  'interaction.autocomplete',
];

export const REQUEST_LISTENER_TYPES: readonly EventType[] = [
  'moderation.report_action_requested',
  'achievements.reward_retry_requested',
];

const SNOWFLAKE = /^\d{17,20}$/;

const DIRECT_READERS: Partial<
  Record<EventType, (event: ProtonEvent) => { customId: string } | null>
> = {
  'interaction.component': readComponentInteraction,
  'interaction.modal': readModalInteraction,
};

type ParsedConfig = ReturnType<ModuleManifest['configSchema']['safeParse']>;

interface ParsedSnapshot {
  schema: ModuleManifest['configSchema'];
  config: unknown;
  result: ParsedConfig;
}

export interface ListenerRuntimeDeps {
  bus: EventBus;
  registry: ModuleRegistry;
  executor: ActionExecutor;
  config: ConfigProvider;
  logger: Logger;

  groupPrefix?: string;
  dashboardUrl?: string;

  publisherFor?: ModulePublisherFactory;
  schedulerFor?: ModuleSchedulerFactory;

  resolver?: CommandResolverPort;
  labels?: CommandLabelSource;
}

function changedModule(event: ProtonEvent): unknown {
  return typeof event.payload === 'object' && event.payload !== null
    ? (event.payload as Record<string, unknown>).moduleId
    : undefined;
}

export function subscribedTypes(manifest: ModuleManifest): EventType[] {
  return [...new Set((manifest.listeners ?? []).flatMap((listener) => listener.types))];
}

type RefusalSuffix = 'module-disabled' | 'config-invalid';

function pressOf(
  manifest: ModuleManifest,
  event: ProtonEvent,
): { facts: InteractionBase; what: string } | null {
  if (event.type === 'interaction.modal') {
    const facts = readModalInteraction(event);
    if (!facts || parseCustomId(facts.customId)?.moduleId !== manifest.id) return null;
    return { facts, what: 'this form' };
  }

  if (event.type !== 'interaction.component') return null;

  const facts = readComponentInteraction(event);
  if (!facts || parseCustomId(facts.customId)?.moduleId !== manifest.id) return null;
  const what = facts.componentType === ComponentType.Button ? 'this button' : 'this menu';
  return { facts, what };
}

function directGuildOf(manifest: ModuleManifest, event: ProtonEvent): string | null {
  if (!manifest.directInteractionGuild) return null;

  const parsed = parseCustomId(DIRECT_READERS[event.type]?.(event)?.customId);
  if (!parsed || parsed.moduleId !== manifest.id) return null;

  const guildId = manifest.directInteractionGuild(parsed);
  return guildId && SNOWFLAKE.test(guildId) ? guildId : null;
}

export class ModuleListenerRuntime {
  readonly #deps: ListenerRuntimeDeps;
  readonly #prefix: string;
  readonly #parsed = new WeakMap<ModuleConfigSnapshot, ParsedSnapshot>();

  constructor(deps: ListenerRuntimeDeps) {
    this.#deps = deps;
    this.#prefix = deps.groupPrefix ?? LISTENER_GROUP_PREFIX;
  }

  listening(): ModuleManifest[] {
    return this.#deps.registry.all().filter((manifest) => subscribedTypes(manifest).length > 0);
  }

  start(): Subscription[] {
    return this.listening().flatMap((manifest) => {
      const types = subscribedTypes(manifest);
      const interactive = types.filter((type) => INTERACTION_LISTENER_TYPES.includes(type));
      const requests = types.filter((type) => REQUEST_LISTENER_TYPES.includes(type));
      const rest = types.filter(
        (type) =>
          !INTERACTION_LISTENER_TYPES.includes(type) && !REQUEST_LISTENER_TYPES.includes(type),
      );
      const concurrency = manifest.interactionConcurrency;

      // Slow events never hold up a 3-second interaction or an api call waiting on its answer.
      return [
        ...(rest.length > 0 ? [this.#subscribe(manifest, listenerGroup, rest)] : []),
        ...(interactive.length > 0
          ? [
              this.#subscribe(
                manifest,
                interactionListenerGroup,
                interactive,
                concurrency === undefined ? {} : { concurrency },
              ),
            ]
          : []),
        ...(requests.length > 0 ? [this.#subscribe(manifest, requestListenerGroup, requests)] : []),
      ];
    });
  }

  #subscribe(
    manifest: ModuleManifest,
    group: (prefix: string, moduleId: string) => string,
    types: EventType[],
    options: { concurrency?: number } = {},
  ): Subscription {
    const name = group(this.#prefix, manifest.id);

    this.#deps.logger.info(`listening for ${manifest.id}`, {
      moduleId: manifest.id,
      group: name,
      types: types.join(', '),
      ...options,
    });

    return this.#deps.bus.subscribe(
      name,
      types,
      (event) => this.handleFor(manifest, event),
      // '$' on group creation only: '0' would replay all history and re-execute settled events.
      { startId: '$', ...options },
    );
  }

  async handleFor(manifest: ModuleManifest, received: ProtonEvent): Promise<void> {
    const guildId = received.guildId ?? directGuildOf(manifest, received);
    if (guildId === null) {
      return;
    }
    const event = received.guildId === null ? { ...received, guildId } : received;

    const matching = (manifest.listeners ?? []).filter((listener) =>
      listener.types.includes(event.type),
    );
    if (matching.length === 0) return;

    if (event.type === 'proton.config_changed' && changedModule(event) === manifest.id) {
      this.#deps.config.invalidate?.(guildId, manifest.id);
    }

    const labelling = this.#deps.labels?.forGuild(guildId);
    const snapshot = await this.#snapshot(guildId, manifest, event);
    if (snapshot === null) return;

    // A module that has just been disabled still gets its own config_changed, so it can undo
    // what it owns outside Proton. Automod's Discord AutoMod rules would otherwise keep blocking
    // messages after the admin turned the module off, with nothing left running to remove them.
    if (!snapshot.enabled && event.type !== 'proton.config_changed') {
      const link = this.#dashboardLink(guildId, manifest);
      const where = manifest.dashboard
        ? 'the switch at the top of the page'
        : `the switch on the **${manifest.name}** card`;
      const off = (what: string) =>
        `**${manifest.name}** is off in this server, so ${what} doesn’t work. A server admin ` +
        `can turn it on at ${link} using ${where}.`;
      await this.#refuse(manifest, guildId, event, 'module-disabled', off);
      return;
    }

    const parsed = this.#parse(manifest, snapshot);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.')} ${i.message}`);
      this.#deps.logger.error(`invalid stored config for ${manifest.id}, so it did not run`, {
        guildId,
        moduleId: manifest.id,
        eventType: event.type,
        issues,
      });
      const fix = manifest.dashboard
        ? `A server admin can fix them at ${this.#dashboardLink(guildId, manifest)}.`
        : `**${manifest.name}** has no settings page to fix them from, so the problem is on my end.`;
      const invalid = (what: string) =>
        `This server’s **${manifest.name}** settings aren’t valid, so ${what} didn’t work: ` +
        `${issues.join('; ')}.\n\n${fix}`;
      await this.#refuse(manifest, guildId, event, 'config-invalid', invalid);
      return;
    }

    const commandLabel = await labelling;
    const ctx: ModuleContext<typeof parsed.data> = {
      guildId,
      config: parsed.data,
      tier: snapshot.tier ?? 'free',
      executor: moduleExecutor(this.#deps.registry, manifest.id, this.#deps.executor),
      logger: this.#deps.logger,

      ...(this.#deps.publisherFor
        ? { publish: this.#deps.publisherFor(manifest.id, guildId) }
        : {}),
      ...(this.#deps.schedulerFor ? this.#deps.schedulerFor(manifest.id, guildId) : {}),
      ...(commandLabel ? { commandLabel } : {}),
    };

    const delivered = await this.#keyed(guildId, event);

    for (const listener of matching) {
      await listener.handler(delivered, ctx);
    }
  }

  async #refuse(
    manifest: ModuleManifest,
    guildId: string,
    event: ProtonEvent,
    suffix: RefusalSuffix,
    explain: (what: string) => string,
  ): Promise<void> {
    const refusal = await this.#refusal(manifest, guildId, event, explain);
    if (!refusal) return;

    const result = await this.#deps.executor.execute({
      ...refusal,
      idempotencyKey: `${event.id}:${suffix}`,
    });

    if (result.status === 'failed_precheck' || result.status === 'failed_api') {
      this.#deps.logger.error(
        `could not tell ${refusal.actorId} why ${manifest.id} did not answer: ${
          result.failure?.humanReason ?? 'unknown reason'
        }`,
        { guildId, moduleId: manifest.id, code: result.failure?.code },
      );
    }
  }

  async #refusal(
    manifest: ModuleManifest,
    guildId: string,
    event: ProtonEvent,
    explain: (what: string) => string,
  ): Promise<ActionRequest | null> {
    const to = (facts: InteractionBase): RespondTo => ({
      guildId,
      moduleId: manifest.id,
      actorId: facts.userId,
      interaction: interactionRef(facts),
    });

    if (event.type === 'interaction.autocomplete') {
      const facts = readAutocompleteInteraction(await this.#keyed(guildId, event));
      const owned = manifest.commands?.some((command) => command.name === facts?.commandName);
      return facts && owned ? respondAutocomplete(to(facts), []) : null;
    }

    const press = pressOf(manifest, event);
    return press ? replyEphemeral(to(press.facts), errorStatus(explain(press.what))) : null;
  }

  #dashboardLink(guildId: string, manifest: ModuleManifest): string {
    const base = (this.#deps.dashboardUrl ?? DEFAULT_DASHBOARD_URL).replace(/\/$/, '');
    return manifest.dashboard
      ? `<${base}/dashboard/${guildId}/${manifest.id}>`
      : `<${base}/dashboard/${guildId}>`;
  }

  async #keyed(guildId: string, event: ProtonEvent): Promise<ProtonEvent> {
    const resolver = this.#deps.resolver;
    if (!resolver || event.type !== 'interaction.autocomplete') return event;
    if (typeof event.payload !== 'object' || event.payload === null) return event;

    const payload = event.payload as Record<string, unknown>;
    const data = payload.data;
    if (typeof data !== 'object' || data === null) return event;

    const resolution = await resolver.resolve(guildId, payload);
    if ('unresolved' in resolution || resolution.key === (data as { name?: unknown }).name) {
      return event;
    }

    return { ...event, payload: { ...payload, data: { ...data, name: resolution.key } } };
  }

  #parse(manifest: ModuleManifest, snapshot: ModuleConfigSnapshot): ParsedConfig {
    const memo = this.#parsed.get(snapshot);
    if (memo?.schema === manifest.configSchema && memo.config === snapshot.config) {
      return memo.result;
    }

    const result = manifest.configSchema.safeParse(snapshot.config);
    this.#parsed.set(snapshot, { schema: manifest.configSchema, config: snapshot.config, result });
    return result;
  }

  async #snapshot(
    guildId: string,
    manifest: ModuleManifest,
    event: ProtonEvent,
  ): Promise<ModuleConfigSnapshot | null> {
    try {
      return await this.#deps.config.get(guildId, manifest.id);
    } catch (error) {
      if (error instanceof ConfigUnavailableError && error.permanent) {
        this.#deps.logger.error(
          `${manifest.id} did not run in this server because its configuration could not be ` +
            `read, and retrying will not help: ${error.message}. Open the module's settings in ` +
            'the Proton dashboard and save them once to rewrite the stored config.',
          {
            guildId,
            moduleId: manifest.id,
            status: error.status,
            eventType: event.type,
            eventId: event.id,
          },
        );
        return null;
      }
      throw error;
    }
  }
}
